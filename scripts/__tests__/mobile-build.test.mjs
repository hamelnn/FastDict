import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileEnvironment, androidPreflight, iosPreflight } from '../mobile-preflight.mjs';
import { parseMobileArgs, verifyAndroidPackage, configureAndroidSdk } from '../mobile.mjs';

test('mobile build defaults clearly distinguish a debug phone APK and simulator app', () => {
  assert.deepEqual(parseMobileArgs(['android', 'build'], 'arm64'), { platform: 'android', action: 'build', target: 'aarch64', help: false });
  assert.equal(parseMobileArgs(['ios', 'build'], 'arm64').target, 'aarch64-sim');
  assert.equal(parseMobileArgs(['ios', 'build'], 'x64').target, 'x86_64');
  assert.throws(() => parseMobileArgs(['ios', 'build', '--target=aarch64']), /真机签名/);
  assert.throws(() => parseMobileArgs(['android', 'build', '--release']), /未知/);
  assert.throws(() => parseMobileArgs(['android', 'build', '--target=malformed']), /Android 目标/);
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

test('iOS preflight rejects a missing simulator runtime instead of starting a large download', () => {
  const run = (command, args) => ({ status: 0, stdout: args.includes('runtimes') ? '{"runtimes":[]}' : '/tool' });
  assert.throws(() => iosPreflight({ platform: 'darwin', run }), /Simulator Runtime/);
});

test('generated Android projects use the published API 37.0 SDK and retain other settings', () => {
  const original = 'android {\n    compileSdk = 37\n    namespace = "app.fastdict.translate"\n}\n';
  const configured = configureAndroidSdk(original);
  assert.match(configured, /version = release\(37\) \{ minorApiLevel = 0 \}/);
  assert.match(configured, /namespace = "app.fastdict.translate"/);
  assert.equal(configureAndroidSdk(configured), configured);
  assert.throws(() => configureAndroidSdk('android { compileSdk = 40 }'), /预期模板不同/);
});

test('actual iOS entry point fails clearly on Windows; help works without a mobile SDK', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../mobile.mjs', import.meta.url));
  const failed = spawnSync(process.execPath, [script, 'ios', 'build'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Windows 无法/);
  const help = spawnSync(process.execPath, [script, 'android', 'build', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /debug 测试 APK/);
});
