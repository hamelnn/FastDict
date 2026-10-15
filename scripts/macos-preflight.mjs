import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

const TARGETS = new Map([
  ['universal-apple-darwin', ['aarch64-apple-darwin', 'x86_64-apple-darwin']],
  ['aarch64-apple-darwin', ['aarch64-apple-darwin']],
  ['x86_64-apple-darwin', ['x86_64-apple-darwin']],
]);

/** Universal is a Tauri target; Rust needs both concrete Apple targets. */
export function macosRustTargets(target = 'universal-apple-darwin') {
  const targets = TARGETS.get(target);
  if (!targets) throw new Error('macOS 构建目标无效，请使用 universal-apple-darwin、aarch64-apple-darwin 或 x86_64-apple-darwin。');
  return [...targets];
}

function output(command, args, env, run) {
  const result = run(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('macOS 构建前置检查失败：' + command + ' ' + args.join(' ') + '。请安装对应工具后重试。');
  return String(result.stdout || '').trim();
}

/** Read-only checks: do not install targets, alter the SDK, or touch user data. */
export function macosPreflight({ target = 'universal-apple-darwin', env = process.env, platform = process.platform, run = spawnSync, checkExecutable = path => accessSync(path, constants.X_OK) } = {}) {
  const rustTargets = macosRustTargets(target);
  if (platform !== 'darwin') throw new Error('macOS 应用需要在 Mac 上构建；当前主机不能生成可验证的 .app 或 .dmg。可在 Mac 或仓库的 macOS 手动构建工作流中运行。');

  const developerDir = output('xcode-select', ['-p'], env, run);
  const sdkPath = output('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], env, run);
  if (!developerDir || !sdkPath) throw new Error('没有找到 macOS SDK，请完成 Xcode 或 Xcode Command Line Tools 初始化。');
  output('xcrun', ['--sdk', 'macosx', '--find', 'clang'], env, run);
  output('xcrun', ['--find', 'lipo'], env, run);
  for (const tool of ['/usr/bin/codesign', '/usr/bin/ditto', '/usr/bin/hdiutil', '/usr/libexec/PlistBuddy', '/usr/sbin/screencapture']) {
    try { checkExecutable(tool); }
    catch { throw new Error('缺少 macOS 打包工具：' + tool + '。'); }
  }

  const rustVersion = output('rustc', ['--version'], env, run);
  const version = /^rustc\s+(\d+)\.(\d+)\./.exec(rustVersion);
  if (!version || Number(version[1]) < 1 || Number(version[1]) === 1 && Number(version[2]) < 90) throw new Error('构建需要 Rust 1.90 或更新版本。');
  output('cargo', ['--version'], env, run);
  const installed = new Set(output('rustup', ['target', 'list', '--installed'], env, run).split(/\s+/));
  const missing = rustTargets.filter(value => !installed.has(value));
  if (missing.length) throw new Error('缺少 Rust 构建目标，请先运行：rustup target add ' + missing.join(' '));

  return { target, rustTargets, developerDir, sdkPath, rustVersion };
}
