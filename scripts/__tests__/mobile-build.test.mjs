import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileEnvironment, androidPreflight, iosPreflight } from '../mobile-preflight.mjs';
import { parseMobileArgs, verifyAndroidPackage, configureAndroidSdk, mobileBuildEnvironment, selectIosArtifact } from '../mobile.mjs';

test('iOS selects architecture before uniqueness across both simulator exports', () => {
  const expected = { identifier: 'app.fastdict.translate', version: '0.4.0', arch: 'arm64' };
  const apps = new Map([
    ['arm/FastLingo.app', { arch: 'arm64' }], ['intel/FastLingo.app', { arch: 'x86_64' }],
    ['old/FastLingo.app', { arch: 'arm64', version: '0.3.0' }],
    ['device/FastLingo.app', { arch: 'arm64', platform: 'iPhoneOS' }],
    ['broken/FastLingo.app', { broken: true }],
  ]);
  const tools = {
    plistValue(app, key) {
      const item = apps.get(app);
      if (item.broken) throw new Error('damaged plist');
      return { CFBundleIdentifier: item.identifier || expected.identifier, CFBundleShortVersionString: item.version || expected.version, 'CFBundleSupportedPlatforms:0': item.platform || 'iPhoneSimulator', CFBundleExecutable: 'FastLingo' }[key];
    },
    architectures(executable) { return apps.get(executable.slice(0, -'/FastLingo'.length).replaceAll('\\', '/')).arch; },
  };
  const candidates = [...apps.keys()];
  assert.equal(selectIosArtifact(candidates, expected, tools), 'arm/FastLingo.app');
  assert.equal(selectIosArtifact(candidates.reverse(), { ...expected, arch: 'x86_64' }, tools), 'intel/FastLingo.app');
  assert.throws(() => selectIosArtifact(['old/FastLingo.app', 'device/FastLingo.app', 'broken/FastLingo.app'], expected, tools), /唯一/);
  apps.set('duplicate/FastLingo.app', { arch: 'arm64' });
  assert.throws(() => selectIosArtifact([...candidates, 'duplicate/FastLingo.app'], expected, tools), /唯一/);
});

test('mobile build defaults clearly distinguish a debug phone APK and simulator app', () => {
  assert.deepEqual(parseMobileArgs(['android', 'build'], 'arm64'), { platform: 'android', action: 'build', target: 'aarch64', help: false });
  assert.equal(parseMobileArgs(['ios', 'build'], 'arm64').target, 'aarch64-sim');
  assert.equal(parseMobileArgs(['ios', 'build'], 'x64').target, 'x86_64');
  assert.throws(() => parseMobileArgs(['ios', 'build', '--target=aarch64']), /真机签名/);
  assert.throws(() => parseMobileArgs(['android', 'build', '--release']), /未知/);
  assert.throws(() => parseMobileArgs(['android', 'build', '--target=malformed']), /Android 目标/);
  assert.equal(parseMobileArgs(['ios', 'check', '--target=aarch64']).target, 'aarch64');
});

test('interactive mobile commands preserve official IDE and device options instead of silently discarding them', () => {
  for (const platform of ['ios', 'android']) {
    for (const options of [[], ['--open', '--host', '192.168.1.10'], ['My phone', '--no-watch']]) {
      const parsed = parseMobileArgs([platform, 'dev', ...options]);
      assert.equal(parsed.target, undefined);
      assert.deepEqual(parsed.devArgs, options);
    }
    assert.throws(() => parseMobileArgs([platform, 'dev', '--target=x86_64']), /交互调试使用设备名称/);
    assert.throws(() => parseMobileArgs([platform, 'dev', '--target', 'x86_64']), /交互调试使用设备名称/);
    assert.throws(() => parseMobileArgs([platform, 'build', '--open']), /未知/);
  }
});

test('iOS rejects Windows before running Xcode or changing files', () => {
  let runs = 0;
  assert.throws(() => iosPreflight({ platform: 'win32', run: () => { runs++; } }), /Windows 无法/);
  assert.equal(runs, 0);
});

test('missing Android SDK and NDK fail before starting Java or Rust', () => {
  let runs = 0;
  assert.throws(() => androidPreflight({ env: {}, exists: () => false, run: () => { runs++; } }), /Android 构建缺少：[\s\S]*NDK/);
  assert.equal(runs, 0);
});

test('build path discovery preserves the caller environment and chooses the newest installed NDK', () => {
  const env = { PATH: '/original', ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' };
  const result = mobileEnvironment('/project', { env, platform: 'linux', home: '/home/user', exists: path => path === join('/sdk', 'ndk'), list: () => ['27.2.12479018', '28.2.13676358', 'unfinished'] });
  assert.equal(result.NDK_HOME, join('/sdk', 'ndk/28.2.13676358'));
  assert.equal(env.NDK_HOME, undefined);
  assert.equal(env.PATH, '/original');
});

test('Android prerequisite checks require the selected Rust architecture', () => {
  const run = command => ({ status: 0, stdout: command === 'rustc' ? 'rustc 1.99.0' : command === 'rustup' ? 'x86_64-pc-windows-gnu' : '', stderr: command.endsWith('java.exe') ? 'openjdk version "21.0.8"' : '' });
  assert.throws(() => androidPreflight({ platform: 'win32', env: { ANDROID_HOME: '/sdk', NDK_HOME: '/ndk', JAVA_HOME: '/jdk' }, exists: () => true, list: () => ['37.0.0'], run }), /rustup target add aarch64-linux-android/);
});

test('a matching APK must have the current package, version, exactly one ABI and debug flag', () => {
  const expected = { identifier: 'app.fastdict.translate', version: '0.2.0', abi: 'arm64-v8a' };
  const good = "package: name='app.fastdict.translate' versionCode='2000' versionName='0.2.0'\napplication-debuggable\nnative-code: 'arm64-v8a'\n";
  verifyAndroidPackage(good, expected);
  assert.throws(() => verifyAndroidPackage(good.replace('0.2.0', '0.1.2'), expected), /版本/);
  assert.throws(() => verifyAndroidPackage(good.replace('app.fastdict.translate', 'another.app'), expected), /包名/);
  assert.throws(() => verifyAndroidPackage(good.replace("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), expected), /架构/);
  assert.throws(() => verifyAndroidPackage(good.replace('application-debuggable', ''), expected), /debug/);
});

test('iOS can compile without a simulator runtime but still requires the selected SDK and Rust target', () => {
  const commands = [];
  const run = (command, args) => {
    commands.push([command, ...args]);
    return { status: 0, stdout: command === 'rustc' ? 'rustc 1.99.0' : command === 'rustup' ? 'aarch64-apple-ios-sim\naarch64-apple-ios' : '/tool' };
  };
  assert.equal(iosPreflight({ platform: 'darwin', run }).sdk, '/tool');
  assert.ok(commands.some(args => args.includes('iphonesimulator')));
  assert.ok(!commands.some(args => args.includes('simctl')));
  commands.length = 0;
  assert.equal(iosPreflight({ platform: 'darwin', target: 'aarch64', action: 'check', run }).arch, 'arm64');
  assert.ok(commands.some(args => args.includes('iphoneos')));
  assert.throws(() => iosPreflight({ platform: 'darwin', target: 'x86_64', run }), /rustup target add x86_64-apple-ios/);
  assert.throws(() => iosPreflight({ platform: 'darwin', run: (command, args) => command === 'xcrun' ? { status: 1 } : run(command, args) }), /xcrun/);
});

test('iOS initialization and device debugging do not require an unrelated simulator target or runtime', () => {
  for (const action of ['init', 'dev']) {
    const commands = [];
    const run = (command, args) => {
      commands.push([command, ...args]);
      assert.notEqual(command, 'xcrun');
      assert.notEqual(command, 'rustup');
      return { status: 0, stdout: command === 'rustc' ? 'rustc 1.99.0' : '/tool' };
    };
    iosPreflight({ platform: 'darwin', action, run });
    assert.ok(commands.some(args => args[0] === 'xcodebuild'));
    assert.ok(commands.some(args => args[0] === 'pod'));
    assert.ok(commands.some(args => args[0] === 'cargo'));
  }
});

test('Android device debugging does not demand arm64 when an x86 emulator will be selected', () => {
  const run = command => {
    assert.notEqual(command, 'rustup');
    return { status: 0, stdout: command === 'rustc' ? 'rustc 1.99.0' : '', stderr: command.endsWith('java.exe') ? 'openjdk version "21.0.8"' : '' };
  };
  androidPreflight({ platform: 'win32', action: 'dev', env: { ANDROID_HOME: '/sdk', NDK_HOME: '/ndk', JAVA_HOME: '/jdk' }, exists: () => true, list: () => ['37.0.0'], run });
});

test('generated Android projects use the published API 37.0 SDK and retain other settings', () => {
  const original = 'android {\n    compileSdk = 37\n    namespace = "app.fastdict.translate"\n}\n';
  const configured = configureAndroidSdk(original);
  assert.match(configured, /version = release\(37\) \{ minorApiLevel = 0 \}/);
  assert.match(configured, /namespace = "app.fastdict.translate"/);
  assert.equal(configureAndroidSdk(configured), configured);
  assert.throws(() => configureAndroidSdk('android { compileSdk = 40 }'), /预期模板不同/);
});

test('Android packaging optimizes Rust without changing the caller or iOS environment', () => {
  const original = { PATH: '/tools', CARGO_PROFILE_DEV_DEBUG: '2', CARGO_PROFILE_DEV_OPT_LEVEL: '0' };
  const android = mobileBuildEnvironment('android', original);
  assert.equal(android.CARGO_PROFILE_DEV_DEBUG, '0');
  assert.equal(android.CARGO_PROFILE_DEV_STRIP, 'symbols');
  assert.equal(android.CARGO_PROFILE_DEV_OPT_LEVEL, 's');
  assert.equal(android.PATH, '/tools');
  assert.equal(original.CARGO_PROFILE_DEV_DEBUG, '2');
  assert.equal(original.CARGO_PROFILE_DEV_OPT_LEVEL, '0');
  assert.equal(original.CARGO_PROFILE_DEV_STRIP, undefined);
  assert.equal(mobileBuildEnvironment('ios', original), original);
});

test('actual iOS entry point fails clearly on Windows; help works without a mobile SDK', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../mobile.mjs', import.meta.url));
  const failed = spawnSync(process.execPath, [script, 'ios', 'build'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Windows 无法/);
  const help = spawnSync(process.execPath, [script, 'android', 'build', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /debug 测试 APK/);
  const iosHelp = spawnSync(process.execPath, [script, 'ios', 'dev', '--help'], { encoding: 'utf8' });
  assert.equal(iosHelp.status, 0);
  assert.match(iosHelp.stdout, /npm run ios -- --open/);
  assert.match(iosHelp.stdout, /保持终端运行/);
});
