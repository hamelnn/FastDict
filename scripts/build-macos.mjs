import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { macosPreflight } from './macos-preflight.mjs';
import { cargoTargetDirectory, desktopOutputPaths } from './build-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = new Map([
  ['universal-apple-darwin', ['arm64', 'x86_64']],
  ['aarch64-apple-darwin', ['arm64']],
  ['x86_64-apple-darwin', ['x86_64']],
]);

export function parseMacBuildArgs(args) {
  let target = 'universal-apple-darwin';
  let help = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else throw new Error(`未知构建选项：${arg}`);
  }
  if (!targets.has(target)) throw new Error('macOS 构建目标须为 universal-apple-darwin、aarch64-apple-darwin 或 x86_64-apple-darwin。');
  return { target, help };
}

export function verifyMacArchitectures(target, archs) {
  const expected = targets.get(target);
  if (!expected) throw new Error('不支持的 macOS 构建目标。');
  const actual = archs.trim().split(/\s+/);
  if (actual.length !== expected.length || expected.some(arch => !actual.includes(arch))) {
    throw new Error(`应用架构与目标不一致；需要 ${expected.join(' + ')}，实际为 ${actual.join(' + ')}。`);
  }
}

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`无法执行 ${basename(command)}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${basename(command)} 执行失败（${result.status}）。请查看上方构建输出。`);
  return result;
}

async function main() {
  const { target, help } = parseMacBuildArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write('在 Mac 上运行 npm run macos:build；默认输出 Apple Silicon + Intel 通用应用。\n可选：--target=aarch64-apple-darwin 或 --target=x86_64-apple-darwin。\n产物：release/macos/ 内的 .app.zip、.dmg、说明与 SHA-256 清单。\n');
    return;
  }
  const env = { ...process.env };
  env.PATH = `${dirname(process.execPath)}:${env.PATH || ''}`;
  macosPreflight({ target, env });
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const macConfig = JSON.parse(await readFile(join(root, 'src-tauri/tauri.macos.conf.json'), 'utf8'));
  // Respect a supplied environment or configuration identity; local builds
  // otherwise use ad-hoc signing without inventing publisher credentials.
  env.APPLE_SIGNING_IDENTITY ||= macConfig.bundle?.macOS?.signingIdentity || config.bundle?.macOS?.signingIdentity || '-';
  if (packageInfo.version !== config.version) throw new Error('前端与原生应用版本不一致。');

  const targetDirectory = cargoTargetDirectory(root, env);
  env.CARGO_TARGET_DIR = targetDirectory;
  run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', target, '--bundles', 'app,dmg', '--ci', '--', '--locked'], env);
  const bundleRoot = desktopOutputPaths(targetDirectory, target).bundle;
  const app = join(bundleRoot, 'macos', `${config.productName}.app`);
  if (!(await stat(app)).isDirectory()) throw new Error('未找到真实的 macOS 应用包。');
  const executableName = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')], env, true).stdout.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(executableName)) throw new Error('应用包的可执行文件名称无效。');
  const executable = join(app, 'Contents/MacOS', executableName);
  const architectures = run('/usr/bin/lipo', ['-archs', executable], env, true).stdout.trim();
  verifyMacArchitectures(target, architectures);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], env);
  const signatureResult = run('/usr/bin/codesign', ['-d', '--verbose=2', app], env, true);
  const signature = /Signature=adhoc/.test(signatureResult.stderr + signatureResult.stdout) ? 'ad-hoc' : 'certificate';

  const dmgFiles = (await readdir(join(bundleRoot, 'dmg'))).filter(name => name.endsWith('.dmg') && name.startsWith(`${config.productName}_${packageInfo.version}_`));
  if (dmgFiles.length !== 1) throw new Error('未能唯一确认本版本的 DMG；请检查 bundle/dmg 构建输出。');
  const sourceDmg = join(bundleRoot, 'dmg', dmgFiles[0]);
  run('/usr/bin/hdiutil', ['verify', sourceDmg], env);

  const output = join(root, 'release/macos');
  await mkdir(output, { recursive: true });
  const archiveName = `${config.productName}-macOS-${packageInfo.version}-${target}.app.zip`;
  const dmgName = `${config.productName}-macOS-${packageInfo.version}-${target}.dmg`;
  // ditto preserves the app's executable mode, symlinks and resource metadata.
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(output, archiveName)], env);
  await copyFile(sourceDmg, join(output, dmgName));
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
  await writeFile(join(output, 'README-macOS.txt'), `${config.productName} ${packageInfo.version} — macOS\n\n打开 DMG，将 ${config.productName}.app 拖到“应用程序”，或解压 app.zip。\n首次配置翻译 API，API Key 保存到系统钥匙串。\n按 ⌥⌘S 框选屏幕文字，松开鼠标后自动识别并翻译。\n按 ⌥⌘V 翻译已复制的文字；Esc 取消当前操作。\n首次截图需要由用户允许屏幕录制；授权后可能需要退出再打开。\n关闭按钮默认退出，可在偏好设置改为隐藏到菜单栏；开机启动默认关闭。⌘Q 或菜单栏“退出”始终完全退出。\n⌥⌘Q 为原生全局退出快捷键，界面失效时仍可使用。\n\n构建目标：${target}\n实际架构：${architectures}\n签名类型：${signature}\n签名和 DMG 完整性已校验；此脚本未验证 Apple 公证状态。\n`, 'utf8');
  const manifest = { version: packageInfo.version, target, architectures: architectures.split(/\s+/), signature, notarization: 'not_checked', artifacts: [] };
  for (const name of [archiveName, dmgName]) {
    const bytes = await readFile(join(output, name));
    manifest.artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(output, `manifest-${target}.json`), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`macOS 应用包已完成：${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
