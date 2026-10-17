import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cargoTargetDirectory, desktopOutputPaths, webviewLoaderFromBuild, artifactRecords } from '../build-artifacts.mjs';
import { parseWindowsBuildArgs, windowsBuildEnvironment, defaultWindowsBuildTarget } from '../build-windows.mjs';
import { stageWindowsDelivery, verifyWindowsDelivery } from '../verify-windows-delivery.mjs';

test('Cargo metadata resolves an environment or config directory without mutating the caller', () => {
  const root = join(tmpdir(), 'fastlingo-project');
  const configured = join(tmpdir(), 'configured-target');
  for (const env of [{ CARGO_TARGET_DIR: configured }, { CARGO_HOME: join(tmpdir(), 'config-cargo-home') }]) {
    const original = { ...env };
    const directory = cargoTargetDirectory(root, env, (command, args, options) => {
      assert.equal(command, 'cargo');
      assert.ok(args.includes('--locked'));
      assert.equal(options.cwd, join(root, 'src-tauri'));
      assert.equal(options.env, env);
      return { status: 0, stdout: JSON.stringify({ target_directory: configured }) };
    });
    assert.equal(directory, configured);
    assert.deepEqual(env, original);
  }
  for (const response of [{ status: 1 }, { status: 0, stdout: '{}' }, { status: 0, stdout: '{"target_directory":"relative"}' }]) {
    assert.throws(() => cargoTargetDirectory(root, {}, () => response), /Cargo/);
  }
});

test('Windows builds respect explicit Rust settings even when an older portable toolchain exists', () => {
  const root = join(tmpdir(), 'fastlingo-project');
  for (const settings of [{ CARGO_HOME: join(tmpdir(), 'user-cargo') }, { RUSTUP_HOME: join(tmpdir(), 'user-rustup') }, { CARGO_HOME: join(tmpdir(), 'user-cargo'), RUSTUP_HOME: join(tmpdir(), 'user-rustup') }]) {
    const env = { Path: 'original-path', CARGO_TARGET_DIR: join(tmpdir(), 'user-target'), ...settings };
    const original = { ...env };
    const selected = windowsBuildEnvironment(root, { env, exists: () => true });
    assert.equal(selected.CARGO_HOME, env.CARGO_HOME);
    assert.equal(selected.RUSTUP_HOME, env.RUSTUP_HOME);
    assert.equal(selected.CARGO_TARGET_DIR, env.CARGO_TARGET_DIR);
    assert.equal(selected.PATH, undefined);
    assert.ok(selected.Path.endsWith(';original-path'));
    assert.deepEqual(env, original);
    assert.ok(!selected.Path.includes('.build-tools'));
  }
  const discovered = windowsBuildEnvironment(root, { env: { PATH: 'system-path' }, exists: () => true });
  assert.equal(discovered.CARGO_HOME, join(root, '.build-tools/cargo'));
  assert.equal(discovered.RUSTUP_HOME, join(root, '.build-tools/rustup'));
  assert.ok(discovered.PATH.includes(join(discovered.CARGO_HOME, 'bin')));
});

test('Windows default build target follows the selected compiler instead of a directory heuristic', () => {
  const root = join(tmpdir(), 'fastlingo-project');
  const env = { CARGO_HOME: join(tmpdir(), 'selected-cargo') };
  for (const host of ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu']) {
    const selected = defaultWindowsBuildTarget(root, env, (command, args, options) => {
      assert.equal(command, 'rustc');
      assert.deepEqual(args, ['-vV']);
      assert.equal(options.env, env);
      assert.equal(options.cwd, root);
      return { status: 0, stdout: `rustc 1.99.0\nhost: ${host}\nrelease: 1.99.0\n` };
    });
    assert.equal(selected, host);
  }
  assert.throws(() => defaultWindowsBuildTarget(root, env, () => ({ status: 1 })), /当前 Rust 工具链/);
  for (const stdout of ['', 'host: aarch64-pc-windows-msvc']) {
    assert.throws(() => defaultWindowsBuildTarget(root, env, () => ({ status: 0, stdout })), /显式指定/);
  }
});

test('desktop export paths choose fresh custom outputs over distinct old default files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fastlingo-paths-'));
  try {
    const defaultTarget = join(root, 'src-tauri/target');
    const customTarget = join(root, 'cargo-config-target');
    for (const target of ['x86_64-pc-windows-gnu', 'universal-apple-darwin']) {
      const old = desktopOutputPaths(defaultTarget, target);
      const current = desktopOutputPaths(customTarget, target);
      const relativeFiles = target.endsWith('gnu') ? ['fastdict.exe', 'WebView2Loader.dll', 'bundle/nsis/FastLingo_0.4.0_x64-setup.exe'] : ['bundle/macos/FastLingo.app/Contents/MacOS/fastdict', 'bundle/dmg/FastLingo_0.4.0_universal.dmg'];
      for (const file of relativeFiles) {
        for (const [paths, text] of [[old, 'OLD-SAME-VERSION'], [current, 'NEW-CURRENT-BUILD']]) {
          const location = join(paths.release, file);
          await mkdir(join(location, '..'), { recursive: true });
          await writeFile(location, text);
        }
        const selected = join(current.release, file);
        assert.equal(await readFile(selected, 'utf8'), 'NEW-CURRENT-BUILD');
      }
      assert.equal(current.executable, join(customTarget, target, 'release/fastdict.exe'));
      assert.equal(current.nsis, join(customTarget, target, 'release/bundle/nsis'));
    }
    await rm(defaultTarget, { recursive: true });
    assert.equal(await readFile(desktopOutputPaths(customTarget, 'x86_64-pc-windows-gnu').executable, 'utf8'), 'NEW-CURRENT-BUILD');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WebView loader comes only from the current Cargo build-script record', () => {
  const output = join(tmpdir(), 'new-target/x86_64-pc-windows-gnu/release/build/webview2-com-sys-new/out');
  const record = { reason: 'build-script-executed', package_id: 'registry+https://github.com/rust-lang/crates.io-index#webview2-com-sys@0.38.2', out_dir: output };
  assert.equal(webviewLoaderFromBuild(`npm frontend output\n${JSON.stringify(record)}\n`), join(output, 'x64/WebView2Loader.dll'));
  assert.throws(() => webviewLoaderFromBuild('no current build record'), /本次 Cargo/);
  assert.throws(() => webviewLoaderFromBuild(`${JSON.stringify(record)}\n${JSON.stringify({ ...record, out_dir: join(tmpdir(), 'other-output') })}`), /唯一确认/);
});

test('unverified package-only reuse is rejected before any build can start', () => {
  assert.deepEqual(parseWindowsBuildArgs(['--installer', '--target=x86_64-pc-windows-msvc']), { target: 'x86_64-pc-windows-msvc', installer: true, help: false });
  for (const oldArtifact of ['old-version', 'same-version-old-commit', 'wrong-architecture', 'missing-metadata']) {
    assert.throws(() => parseWindowsBuildArgs(['--package-only', `--input=${oldArtifact}`]), /已移除/);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../build-windows.mjs', import.meta.url)), '--package-only'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /已移除/);
});

test('the staged/downloaded Windows inventory verifies every file without duplicate ZIPs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fastlingo-delivery-'));
  try {
    const source = join(root, 'release');
    const staged = join(root, 'upload');
    const downloaded = join(root, 'download');
    await mkdir(source);
    const names = ['FastLingo-Windows-x64-0.4.0.zip', 'FastLingo_0.4.0_x64-setup.exe', 'README-Windows.txt', 'THIRD_PARTY_NOTICES.md'];
    for (const name of [...names, 'FastLingo.exe', 'FastLingo-Windows-x64.zip']) await writeFile(join(source, name), `fixture:${name}`);
    const manifest = { version: '0.4.0', artifacts: await artifactRecords(source, names) };
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    await stageWindowsDelivery(source, staged);
    await mkdir(downloaded);
    for (const name of ['manifest.json', ...names]) await copyFile(join(staged, name), join(downloaded, name));
    await verifyWindowsDelivery(downloaded);
    await writeFile(join(downloaded, names[0]), 'tampered');
    await assert.rejects(verifyWindowsDelivery(downloaded), /不一致/);
    await copyFile(join(staged, names[0]), join(downloaded, names[0]));
    await writeFile(join(downloaded, 'FastLingo.exe'), 'unlisted');
    await assert.rejects(verifyWindowsDelivery(downloaded), /清单外/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
