import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { androidTargets, iosTargets, mobileEnvironment, androidPreflight, iosPreflight } from './mobile-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseMobileArgs(args, arch = process.arch) {
  const [platform, action, ...options] = args;
  if (!['android', 'ios'].includes(platform) || !['init', 'build', 'dev', 'check'].includes(action)) throw new Error('用法：node scripts/mobile.mjs android|ios init|build|dev|check [--target=目标]');
  let target = platform === 'android' ? 'aarch64' : arch === 'arm64' ? 'aarch64-sim' : 'x86_64';
  let help = false;
  for (const option of options) {
    if (option === '--help' || option === '-h') help = true;
    else if (option.startsWith('--target=')) target = option.slice(9);
    else throw new Error(`未知移动构建选项：${option}`);
  }
  if (!(platform === 'android' ? androidTargets : iosTargets)[target]) throw new Error(platform === 'android' ? 'Android 目标须为 aarch64、armv7、x86_64 或 i686。' : 'iOS 目标须为模拟器 aarch64-sim 或 x86_64；真机签名请在 Xcode 配置。');
  return { platform, action, target, help };
}

export function verifyAndroidPackage(badging, { identifier, version, abi }) {
  const packageLine = /^package: name='([^']+)' versionCode='\d+' versionName='([^']+)'/m.exec(badging);
  const nativeLine = /^native-code:\s*(.*)$/m.exec(badging)?.[1] || '';
  const abis = [...nativeLine.matchAll(/'([^']+)'/g)].map(match => match[1]);
  if (!packageLine || packageLine[1] !== identifier || packageLine[2] !== version) throw new Error('APK 包名或版本与当前项目不一致。');
  if (abis.length !== 1 || abis[0] !== abi) throw new Error(`APK 架构不匹配，需要 ${abi}。`);
  if (!/^application-debuggable(?:\s|$)/m.test(badging)) throw new Error('预期生成 debug 测试 APK，实际包类型不一致。');
}

export function configureAndroidSdk(gradle) {
  // API 37 is published as android-37.0. An integer compileSdk in Tauri's
  // template resolves android-37 instead, which does not exist in Google's SDK.
  if (/compileSdk\s*\{\s*version\s*=\s*release\(37\)\s*\{\s*minorApiLevel\s*=\s*0\s*\}\s*\}/.test(gradle)) return gradle;
  const template = /^([ \t]*)compileSdk\s*=\s*37\s*$/m;
  if (!template.test(gradle)) throw new Error('Android compileSdk 配置与预期模板不同，请检查 app/build.gradle.kts 的 API 37.0 配置。');
  return gradle.replace(template, (_, indent) => `${indent}compileSdk {\n${indent}    version = release(37) { minorApiLevel = 0 }\n${indent}}`);
}

export function mobileBuildEnvironment(platform, env) {
  if (platform !== 'android') return env;
  // Keep the Android debug signing variant while avoiding large Rust DWARF
  // sections. Tauri forwards CARGO_* through its mobile build options server.
  // This copy is passed only to `build`, never the interactive `dev` command.
  return {
    ...env,
    CARGO_PROFILE_DEV_DEBUG: '0',
    CARGO_PROFILE_DEV_STRIP: 'symbols',
    CARGO_PROFILE_DEV_OPT_LEVEL: 's',
  };
}

async function prepareAndroidProject(project) {
  const path = join(project, 'app/build.gradle.kts');
  const original = await readFile(path, 'utf8');
  const configured = configureAndroidSdk(original);
  if (configured !== original) await writeFile(path, configured, 'utf8');
}

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} 执行失败（${result.status ?? result.error?.code}）。请查看构建输出。`);
  return result.stdout || '';
}

async function findArtifacts(directory, extension, depth = 7) {
  if (!existsSync(directory) || depth < 0) return [];
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.name.endsWith(extension)) found.push(path);
    else if (entry.isDirectory() && !entry.name.endsWith('.xcarchive')) found.push(...await findArtifacts(path, extension, depth - 1));
  }
  return found;
}

async function exportAndroid(info, config, env) {
  const candidates = (await findArtifacts(join(root, 'src-tauri/gen/android/app/build/outputs/apk'), '.apk')).filter(path => /[\\/]debug[\\/]/i.test(path));
  const valid = [];
  const aapt = join(info.buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  for (const candidate of candidates) {
    try {
      verifyAndroidPackage(run(aapt, ['dump', 'badging', candidate], env, true), { identifier: config.identifier, version: config.version, abi: info.abi });
      valid.push(candidate);
    } catch { /* Exclude stale outputs from another version or architecture. */ }
  }
  if (valid.length !== 1) throw new Error('未能唯一找到符合本版本、包名与架构的 debug APK。请检查 Android 构建输出。');
  run(info.java, ['-jar', join(info.buildTools, 'lib/apksigner.jar'), 'verify', '--verbose', valid[0]], env);
  const output = join(root, 'release/android');
  await mkdir(output, { recursive: true });
  const name = `${config.productName}-Android-${config.version}-${info.abi}-debug.apk`;
  await copyFile(valid[0], join(output, name));
  await writeManifest(output, name, { version: config.version, target: info.target, abi: info.abi, kind: 'debug-apk', signing: 'android-debug', rustProfile: 'optimized-dev', rustOptions: { debug: 0, strip: 'symbols', optLevel: 's' }, deviceTest: 'not_run' });
  await writeFile(join(output, 'README-Android.txt'), `${config.productName} ${config.version} Android 测试版\n\n安装 ${name}。此包使用 Android debug 签名，仅用于测试，不是商店发布版。\nRust 原生库按体积优化并在编译时去除调试符号，以减小安装包。\n需要 Android 7.0 (API 24) 或更新系统。\n在其他 App 截图后，打开 ${config.productName}，选择截图后识别并翻译。\n也可主动粘贴已复制的文字。API Key 使用 Android Keystore 保护。\n不同机器或 CI 运行使用的 debug 密钥可能不同；签名不匹配时无法覆盖安装。\n此清单只证明编译与包校验通过，实际设备功能仍需验证。\n`, 'utf8');
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
  process.stdout.write(`Android 测试 APK 已生成并校验：${join(output, name)}\n`);
}

async function exportIos(info, config, env) {
  const candidates = await findArtifacts(join(root, 'src-tauri/gen/apple/build'), '.app');
  const valid = [];
  const plistValue = (app, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')], env, true).trim();
  for (const app of candidates) {
    try {
      if (plistValue(app, 'CFBundleIdentifier') === config.identifier && plistValue(app, 'CFBundleShortVersionString') === config.version && plistValue(app, 'CFBundleSupportedPlatforms:0') === 'iPhoneSimulator') valid.push(app);
    } catch { /* Exclude stale or non-simulator build directories. */ }
  }
  if (valid.length !== 1) throw new Error('未能唯一找到当前版本的 iOS 模拟器应用。');
  const executable = plistValue(valid[0], 'CFBundleExecutable');
  if (!/^[A-Za-z0-9._-]+$/.test(executable)) throw new Error('iOS 应用可执行文件名称无效。');
  const architectures = run('/usr/bin/lipo', ['-archs', join(valid[0], executable)], env, true).trim();
  if (architectures !== info.arch) throw new Error(`iOS 模拟器架构不匹配，需要 ${info.arch}。`);
  const output = join(root, 'release/ios');
  await mkdir(output, { recursive: true });
  const name = `${config.productName}-iOS-${config.version}-${info.target}-simulator.app.zip`;
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', valid[0], join(output, name)], env);
  await writeManifest(output, name, { version: config.version, target: info.target, kind: 'ios-simulator-app', signing: 'none', deviceInstallable: false, deviceTest: 'not_run' });
  await writeFile(join(output, 'README-iOS.txt'), `${config.productName} ${config.version} iOS 模拟器构建\n\n解压后将 .app 拖入 Mac 的 iOS Simulator。不能直接安装到 iPhone/iPad。\n真机安装与 TestFlight 分发需要自己的 Apple 开发签名和描述文件，请在 Xcode 配置。\n本构建使用 --no-sign，没有伪造 Apple Team 或签名证书。\n`, 'utf8');
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
  process.stdout.write(`iOS 模拟器应用已生成并校验：${join(output, name)}\n`);
}

async function writeManifest(output, name, metadata) {
  const bytes = await readFile(join(output, name));
  if (!bytes.length) throw new Error('构建产物为空。');
  await writeFile(join(output, `manifest-${metadata.target}.json`), JSON.stringify({ ...metadata, artifacts: [{ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }, null, 2) + '\n');
}

async function main() {
  const options = parseMobileArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法：npm run android:init / android:build / android:check / android\n      npm run ios:init / ios:build / ios:check / ios\nAndroid 默认生成 arm64 debug 测试 APK，可用 --target=x86_64 等切换架构。\niOS 默认生成当前 Mac 架构的模拟器应用，可用 --target=aarch64-sim 或 --target=x86_64。\n构建前需先 init；脚本不会自动安装 SDK、Rust 目标或接受许可。\n');
    return;
  }
  const env = mobileEnvironment(root);
  const info = (options.platform === 'android' ? androidPreflight : iosPreflight)({ target: options.target, env });
  if (options.action === 'check') { process.stdout.write(`${options.platform} ${options.target} 构建环境检查通过。\n`); return; }
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (config.version !== packageInfo.version) throw new Error('前端与原生应用版本不一致。');
  const tauri = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const project = join(root, 'src-tauri/gen', options.platform === 'android' ? 'android' : 'apple');
  if (options.action === 'init') {
    if (existsSync(project) && (await readdir(project)).length) throw new Error(`原生工程已存在：${project}。请直接运行 ${options.platform}:build，避免覆盖本地修改。`);
    run(process.execPath, [tauri, options.platform, 'init', '--ci', '--skip-targets-install'], env);
    if (options.platform === 'android') await prepareAndroidProject(project);
    process.stdout.write(`${options.platform} 原生工程已初始化。\n`);
    return;
  }
  if (!existsSync(project) || !(await stat(project)).isDirectory()) throw new Error(`请先运行 npm run ${options.platform}:init。`);
  if (options.platform === 'android') await prepareAndroidProject(project);
  if (options.action === 'dev') {
    run(process.execPath, [tauri, options.platform, 'dev'], env);
    return;
  }
  const args = [tauri, options.platform, 'build', '--debug', '--target', options.target, '--ci'];
  args.push(options.platform === 'android' ? '--apk' : '--no-sign');
  const buildEnv = mobileBuildEnvironment(options.platform, env);
  run(process.execPath, args, buildEnv);
  await (options.platform === 'android' ? exportAndroid : exportIos)(info, config, buildEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
