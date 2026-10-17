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
  // Device selection belongs to Tauri: it supports physical devices, simulators,
  // --open and --host. A packaging target must never be silently ignored here.
  if (action === 'dev') {
    if (options.some(option => option === '--target' || option.startsWith('--target='))) throw new Error('交互调试使用设备名称选择目标；--target 仅用于 init、check 和 build。例如 npm run ios -- --open。');
    return { platform, action, target: undefined, help: options.includes('--help') || options.includes('-h'), devArgs: options };
  }
  let target = platform === 'android' ? 'aarch64' : arch === 'arm64' ? 'aarch64-sim' : 'x86_64';
  let help = false;
  for (const option of options) {
    if (option === '--help' || option === '-h') help = true;
    else if (option.startsWith('--target=')) target = option.slice(9);
    else throw new Error(`未知移动构建选项：${option}`);
  }
  if (!(platform === 'android' ? androidTargets : iosTargets)[target]) throw new Error(platform === 'android' ? 'Android 目标须为 aarch64、armv7、x86_64 或 i686。' : 'iOS 目标须为 aarch64、aarch64-sim 或 x86_64。');
  if (platform === 'ios' && action === 'build' && target === 'aarch64') throw new Error('ios:build 仅导出模拟器包；真机签名请用 npm run ios -- --open 在 Xcode 配置。');
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

export function configureIosSimulatorArchitecture(project, arch) {
  if (!['arm64', 'x86_64'].includes(arch)) throw new Error('iOS 模拟器构建架构无效。');
  // Tauri's archive command can use the host architecture even when --target
  // names a different simulator. Xcode must build that target, not just export
  // the host binary into a directory named after the requested architecture.
  // Archive can otherwise choose the project's default iphoneos destination
  // even for an Intel simulator target. Restrict this temporary configuration
  // to the simulator SDK as well; the original project is always restored.
  const existing = /^[ \t]*"(?:ARCHS|VALID_ARCHS|ONLY_ACTIVE_ARCH)\[sdk=iphonesimulator\*\]"\s*=\s*(?:\([^;]*\)|[^;]*);[ \t]*\r?\n/gm;
  const platformSettings = /^[ \t]*(?:"(?:SDKROOT|SUPPORTED_PLATFORMS)"|SDKROOT|SUPPORTED_PLATFORMS)\s*=\s*(?:\([^;]*\)|[^;]*);[ \t]*\r?\n/gm;
  const cleaned = project.replace(existing, '').replace(platformSettings, '');
  let blocks = 0;
  const configured = cleaned.replace(/^([ \t]*)buildSettings = \{[ \t]*(\r?)$/gm, (_, indent, cr) => {
    blocks++;
    return `${indent}buildSettings = {${cr}\n${indent}\tSDKROOT = iphonesimulator;${cr}\n${indent}\tSUPPORTED_PLATFORMS = iphonesimulator;${cr}\n${indent}\t"ARCHS[sdk=iphonesimulator*]" = ${arch};${cr}\n${indent}\t"VALID_ARCHS[sdk=iphonesimulator*]" = ${arch};${cr}\n${indent}\t"ONLY_ACTIVE_ARCH[sdk=iphonesimulator*]" = NO;${cr}`;
  });
  if (!blocks) throw new Error('Xcode 工程缺少预期 buildSettings，无法固定模拟器架构。');
  return configured;
}

export function requireNativeIosSimulatorHost(arch, hostArch = process.arch) {
  const nativeArch = hostArch === 'arm64' ? 'arm64' : hostArch === 'x64' ? 'x86_64' : undefined;
  // tauri ios xcode-script currently replaces simulator ARCHS with its own
  // host architecture before compiling and copying Externals/<arch>/libapp.a.
  if (!nativeArch || arch !== nativeArch) throw new Error('当前 Tauri iOS 构建要求模拟器架构与主机一致：Intel 模拟器包需 Intel Mac，ARM64 模拟器包需 Apple Silicon Mac。请在对应 Mac 或 GitHub 双架构构建工作流运行。');
}

export async function withIosSimulatorArchitecture(projectDirectory, arch, build, onFailure) {
  const projects = (await readdir(projectDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.xcodeproj'));
  if (projects.length !== 1) throw new Error('未能唯一找到 iOS Xcode 工程。');
  const path = join(projectDirectory, projects[0].name, 'project.pbxproj');
  const original = await readFile(path, 'utf8');
  const configured = configureIosSimulatorArchitecture(original, arch);
  await writeFile(path, configured, 'utf8');
  try {
    return await build();
  } catch (error) {
    try { await onFailure?.(path); }
    catch (diagnosticError) { process.stderr.write(`iOS 构建诊断未完成：${diagnosticError.message}\n`); }
    throw error;
  } finally {
    // Restore developer settings on both success and failure so later device
    // runs or the other simulator architecture do not inherit this override.
    await writeFile(path, original, 'utf8');
  }
}

async function diagnoseIosBuild(projectDirectory, projectPath, info, env) {
  const project = await readFile(projectPath, 'utf8');
  const projectLines = project.split(/\r?\n/).filter(line => /ARCHS|LIBRARY_SEARCH_PATHS|OTHER_LDFLAGS|SDKROOT|SUPPORTED_PLATFORMS|Build Rust Code|shellScript|libapp\.a/.test(line)).map(line => line.slice(0, 4000));
  const lines = [`iOS build diagnostics: target=${info.target}, requested=${info.arch}, host=${process.arch}`, 'Xcode project settings / Rust phase:', ...projectLines.slice(0, 120), 'Actual Externals static libraries:'];
  const libraries = await findArtifacts(join(projectDirectory, 'Externals'), '.a');
  if (!libraries.length) lines.push('(none)');
  for (const path of libraries.slice(0, 32)) {
    const lipo = spawnSync('/usr/bin/lipo', ['-archs', path], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    lines.push(`${path}: ${lipo.status === 0 ? lipo.stdout.trim() : (lipo.stderr?.trim() || lipo.error?.message || `exit=${lipo.status}`)}`);
  }
  const scheme = basename(dirname(projectPath), '.xcodeproj') + '_iOS';
  const settings = spawnSync('/usr/bin/xcodebuild', ['-project', dirname(projectPath), '-scheme', scheme, '-configuration', 'debug', '-showBuildSettings'], { cwd: projectDirectory, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  lines.push('Effective Xcode build settings (project default SDK, no command-line override):');
  lines.push(...(settings.stdout || '').split(/\r?\n/).filter(line => /^\s*(ARCHS|VALID_ARCHS|ONLY_ACTIVE_ARCH|CURRENT_ARCH|SDKROOT|SUPPORTED_PLATFORMS|PLATFORM_NAME|CONFIGURATION|LIBRARY_SEARCH_PATHS|OTHER_LDFLAGS)\s*=/.test(line)));
  if (settings.status !== 0) lines.push(`showBuildSettings: ${settings.error?.message || `exit=${settings.status}`}`);
  const report = lines.join('\n') + '\n';
  process.stderr.write(report);
  const output = join(root, 'release/ios');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `build-diagnostics-${info.target}.txt`), report);
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
  const plistValue = (app, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')], env, true).trim();
  const app = selectIosArtifact(candidates, { identifier: config.identifier, version: config.version, arch: info.arch }, {
    plistValue,
    architectures: executable => run('/usr/bin/lipo', ['-archs', executable], env, true).trim(),
  });
  const output = join(root, 'release/ios');
  await mkdir(output, { recursive: true });
  const name = `${config.productName}-iOS-${config.version}-${info.target}-simulator.app.zip`;
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(output, name)], env);
  await writeManifest(output, name, { version: config.version, target: info.target, kind: 'ios-simulator-app', signing: 'none', deviceInstallable: false, deviceTest: 'not_run' });
  await writeFile(join(output, 'README-iOS.txt'), `${config.productName} ${config.version} iOS 模拟器构建\n\n解压后将 .app 拖入 Mac 的 iOS Simulator。不能直接安装到 iPhone/iPad。\n真机安装与 TestFlight 分发需要自己的 Apple 开发签名和描述文件，请在 Xcode 配置。\n本构建使用 --no-sign，没有伪造 Apple Team 或签名证书。\n`, 'utf8');
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
  process.stdout.write(`iOS 模拟器应用已生成并校验：${join(output, name)}\n`);
}

export function selectIosArtifact(candidates, expected, { plistValue, architectures }) {
  const diagnostics = [];
  const valid = candidates.filter(app => {
    try {
      const identifier = plistValue(app, 'CFBundleIdentifier');
      const version = plistValue(app, 'CFBundleShortVersionString');
      const platform = plistValue(app, 'CFBundleSupportedPlatforms:0');
      if (identifier !== expected.identifier || version !== expected.version || platform !== 'iPhoneSimulator') {
        diagnostics.push(`${app}: identifier=${identifier}, version=${version}, platform=${platform}`);
        return false;
      }
      const executable = plistValue(app, 'CFBundleExecutable');
      if (!/^[A-Za-z0-9._-]+$/.test(executable)) { diagnostics.push(`${app}: executable 无效`); return false; }
      const arch = architectures(join(app, executable)).trim();
      diagnostics.push(`${app}: architectures=${arch}`);
      // Another target's normal output is not a duplicate of this target.
      return arch === expected.arch;
    } catch { diagnostics.push(`${app}: 无法读取 Info.plist 或可执行文件架构`); return false; }
  });
  if (valid.length !== 1) throw new Error(`未能唯一找到当前版本、包名与 ${expected.arch} 架构的 iOS 模拟器应用（匹配 ${valid.length} 个）。\n${diagnostics.slice(0, 16).join('\n')}`);
  return valid[0];
}

async function writeManifest(output, name, metadata) {
  const bytes = await readFile(join(output, name));
  if (!bytes.length) throw new Error('构建产物为空。');
  await writeFile(join(output, `manifest-${metadata.target}.json`), JSON.stringify({ ...metadata, artifacts: [{ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }, null, 2) + '\n');
}

async function main() {
  const options = parseMobileArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法：npm run android:init / android:build / android:check / android\n      npm run ios:init / ios:build / ios:check / ios\nAndroid build 默认生成 arm64 debug 测试 APK，可用 --target=x86_64 等切换架构。\niOS build 默认生成当前 Mac 架构的模拟器应用，可用 --target=aarch64-sim 或 --target=x86_64。\n交互调试：npm run ios -- --open（Xcode）或 npm run android -- --open（Android Studio）。保持终端运行；真机签名在 Xcode 配置。\n调试参数直接传给 Tauri，可使用设备名称、--host 等选项；调试不使用 --target。例如 npm run ios -- "iPhone 17"。\niOS 真机环境检查：npm run ios:check -- --target=aarch64。模拟器 Runtime 只在运行模拟器时需要，初始化及编译不要求安装。\n构建前需先 init；脚本不会自动安装 SDK、Rust 目标或接受许可。\n');
    return;
  }
  const env = mobileEnvironment(root);
  const info = (options.platform === 'android' ? androidPreflight : iosPreflight)({ target: options.target, action: options.action, env });
  if (options.platform === 'ios' && options.action === 'build') requireNativeIosSimulatorHost(info.arch);
  if (options.action === 'check') { process.stdout.write(`${options.platform} ${options.target} 构建环境检查通过。\n`); return; }
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (config.version !== packageInfo.version) throw new Error('前端与原生应用版本不一致。');
  const tauri = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const project = join(root, 'src-tauri/gen', options.platform === 'android' ? 'android' : 'apple');
  if (options.action === 'init') {
    if (existsSync(project) && (await readdir(project)).length) throw new Error(`原生工程已存在：${project}。请直接运行 npm run ${options.platform} 调试或 ${options.platform}:build 构建，避免覆盖本地修改。`);
    run(process.execPath, [tauri, options.platform, 'init', '--ci', '--skip-targets-install'], env);
    if (options.platform === 'android') await prepareAndroidProject(project);
    process.stdout.write(`${options.platform} 原生工程已初始化。\n`);
    return;
  }
  if (!existsSync(project) || !(await stat(project)).isDirectory()) throw new Error(`请先运行 npm run ${options.platform}:init。`);
  if (options.platform === 'android') await prepareAndroidProject(project);
  if (options.action === 'dev') {
    run(process.execPath, [tauri, options.platform, 'dev', ...options.devArgs], env);
    return;
  }
  const args = [tauri, options.platform, 'build', '--debug', '--target', options.target, '--ci'];
  args.push(options.platform === 'android' ? '--apk' : '--no-sign');
  args.push('--', '--locked');
  const buildEnv = mobileBuildEnvironment(options.platform, env);
  if (options.platform === 'ios') {
    await withIosSimulatorArchitecture(project, info.arch, () => run(process.execPath, args, buildEnv), path => diagnoseIosBuild(project, path, info, buildEnv));
  } else {
    run(process.execPath, args, buildEnv);
  }
  await (options.platform === 'android' ? exportAndroid : exportIos)(info, config, buildEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
