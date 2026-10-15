import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

export const androidTargets = {
  aarch64: { rust: 'aarch64-linux-android', abi: 'arm64-v8a' },
  armv7: { rust: 'armv7-linux-androideabi', abi: 'armeabi-v7a' },
  x86_64: { rust: 'x86_64-linux-android', abi: 'x86_64' },
  i686: { rust: 'i686-linux-android', abi: 'x86' },
};
export const iosTargets = {
  'aarch64-sim': { rust: 'aarch64-apple-ios-sim', arch: 'arm64' },
  x86_64: { rust: 'x86_64-apple-ios', arch: 'x86_64' },
};

function latestDirectory(path, exists, list) {
  if (!exists(path)) return undefined;
  return list(path).filter(name => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
}

// Discovery affects the build child process only, never the user's saved environment.
export function mobileEnvironment(root, { env = process.env, platform = process.platform, home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  const result = { ...env };
  const executable = platform === 'win32' ? '.exe' : '';
  const pathKey = Object.keys(result).find(key => key.toLowerCase() === 'path') || 'PATH';
  const paths = [dirname(process.execPath)];
  const localCargo = join(root, '.build-tools/cargo');
  if (!result.CARGO_HOME && !result.RUSTUP_HOME && exists(join(localCargo, 'bin', `rustup${executable}`))) {
    result.CARGO_HOME = localCargo;
    result.RUSTUP_HOME = join(root, '.build-tools/rustup');
  }
  if (result.CARGO_HOME) paths.push(join(result.CARGO_HOME, 'bin'));
  result.ANDROID_HOME ||= result.ANDROID_SDK_ROOT || ({
    win32: join(result.LOCALAPPDATA || join(home, 'AppData/Local'), 'Android/Sdk'),
    darwin: join(home, 'Library/Android/sdk'),
    linux: join(home, 'Android/Sdk'),
  })[platform];
  const javaCandidates = platform === 'win32'
    ? [join(result.ProgramFiles || 'C:/Program Files', 'Android/Android Studio/jbr')]
    : platform === 'darwin' ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home'] : ['/opt/android-studio/jbr'];
  result.JAVA_HOME ||= javaCandidates.find(path => exists(join(path, 'bin', `java${executable}`)));
  if (result.JAVA_HOME) paths.push(join(result.JAVA_HOME, 'bin'));
  if (result.ANDROID_HOME) {
    const version = latestDirectory(join(result.ANDROID_HOME, 'ndk'), exists, list);
    if (!result.NDK_HOME && version) result.NDK_HOME = join(result.ANDROID_HOME, 'ndk', version);
    paths.push(join(result.ANDROID_HOME, 'platform-tools'));
  }
  result[pathKey] = [...paths, result[pathKey] || ''].join(platform === 'win32' ? ';' : delimiter);
  return result;
}

function commandOutput(command, args, env, run) {
  const result = run(command, args, { env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`构建前置检查失败：${command} ${args.join(' ')}。请安装或配置对应工具后重试。`);
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function rustCheck(target, env, run) {
  const rustVersion = commandOutput('rustc', ['--version'], env, run);
  const parsed = /^rustc\s+(\d+)\.(\d+)\./.exec(rustVersion);
  if (!parsed || +parsed[1] < 1 || +parsed[1] === 1 && +parsed[2] < 90) throw new Error('构建需要 Rust 1.90 或更新版本。');
  commandOutput('cargo', ['--version'], env, run);
  const installed = new Set(commandOutput('rustup', ['target', 'list', '--installed'], env, run).split(/\s+/));
  if (!installed.has(target)) throw new Error(`缺少 Rust 移动目标，请先运行：rustup target add ${target}`);
}

export function androidPreflight({ target = 'aarch64', env = process.env, platform = process.platform, exists = existsSync, list = readdirSync, run = spawnSync } = {}) {
  if (!androidTargets[target]) throw new Error('Android 构建目标无效。');
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Android 构建需要 Windows、macOS 或 Linux 主机。');
  const executable = platform === 'win32' ? '.exe' : '';
  const missing = [];
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  // The locked Tauri CLI 2.12.2 Android template targets API 37.
  if (!sdk || !exists(join(sdk, 'platforms/android-37.0/android.jar'))) missing.push('Android SDK Platform 37.0（ANDROID_HOME）');
  if (!sdk || !exists(join(sdk, 'platforms/android-36/android.jar'))) missing.push('Android SDK Platform 36（原生插件依赖）');
  if (!sdk || !exists(join(sdk, 'platform-tools', `adb${executable}`))) missing.push('Android SDK Platform-Tools');
  const buildToolsVersion = sdk && latestDirectory(join(sdk, 'build-tools'), exists, list);
  const buildTools = buildToolsVersion && join(sdk, 'build-tools', buildToolsVersion);
  if (!buildTools || Number(buildToolsVersion.split('.')[0]) < 37 || !exists(join(buildTools, `aapt${executable}`)) || !exists(join(buildTools, 'lib/apksigner.jar'))) missing.push('Android SDK Build-Tools 37 或更新版本');
  const host = { win32: 'windows-x86_64', darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[platform];
  if (!env.NDK_HOME || !exists(join(env.NDK_HOME, 'toolchains/llvm/prebuilt', host, 'bin', `clang${executable}`))) missing.push('NDK (Side by side)，并设置 NDK_HOME');
  const java = env.JAVA_HOME && join(env.JAVA_HOME, 'bin', `java${executable}`);
  if (!java || !exists(java)) missing.push('JDK 17 或更新版本（JAVA_HOME）');
  if (missing.length) throw new Error(`Android 构建缺少：\n- ${missing.join('\n- ')}\n请在 Android Studio 的 SDK Manager 安装所需组件；脚本不会自动安装或接受许可。`);
  const version = commandOutput(java, ['-version'], env, run);
  const major = /version\s+"(\d+)/.exec(version)?.[1];
  if (!major || +major < 17) throw new Error('Android 构建需要 JDK 17 或更新版本。');
  rustCheck(androidTargets[target].rust, env, run);
  return { target, sdk, buildTools, java, abi: androidTargets[target].abi };
}

export function iosPreflight({ target = 'aarch64-sim', env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') throw new Error('iOS 应用必须在安装完整 Xcode 的 Mac 上构建；Windows 无法生成可验证的 iOS 应用。');
  if (!iosTargets[target]) throw new Error('此入口仅构建 iOS 模拟器；真机版本需在 Xcode 配置自己的签名。');
  commandOutput('xcodebuild', ['-version'], env, run);
  const sdk = commandOutput('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], env, run);
  if (!sdk) throw new Error('缺少 iOS Simulator SDK，请在 Xcode 中安装。');
  const runtimes = JSON.parse(commandOutput('xcrun', ['simctl', 'list', 'runtimes', '--json'], env, run));
  if (!runtimes.runtimes?.some(runtime => runtime.isAvailable && runtime.identifier?.includes('.iOS-'))) throw new Error('缺少可用 iOS Simulator Runtime，请在 Xcode Settings > Components 安装。');
  commandOutput('pod', ['--version'], env, run);
  rustCheck(iosTargets[target].rust, env, run);
  return { target, sdk, arch: iosTargets[target].arch };
}
