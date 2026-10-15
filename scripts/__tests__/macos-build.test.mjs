import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMacBuildArgs, verifyMacArchitectures } from '../build-macos.mjs';
import { macosPreflight } from '../macos-preflight.mjs';

test('a universal release refuses a thin, duplicate or unexpected executable slice', () => {
  verifyMacArchitectures('universal-apple-darwin', 'x86_64 arm64\n');
  for (const archs of ['arm64', 'x86_64', 'arm64 arm64', 'arm64 x86_64 i386', '']) {
    assert.throws(() => verifyMacArchitectures('universal-apple-darwin', archs), /架构/);
  }
  assert.throws(() => verifyMacArchitectures('aarch64-apple-darwin', 'x86_64'), /架构/);
});

test('invalid targets are rejected before executing any build tools', () => {
  assert.throws(() => parseMacBuildArgs(['--target=x86_64-pc-windows-gnu']), /构建目标/);
  assert.throws(() => parseMacBuildArgs(['--fake-app']), /未知构建选项/);
});

test('a Windows preflight cannot masquerade as a successful macOS build', () => {
  let ran = false;
  assert.throws(() => macosPreflight({ platform: 'win32', run: () => { ran = true; } }), /Mac 上构建/);
  assert.equal(ran, false);
});

test('missing Intel Rust target blocks a universal build rather than silently building ARM', () => {
  const run = (command, args) => ({ status: 0, stdout: command === 'rustc' ? 'rustc 1.99.0' : command === 'rustup' ? 'aarch64-apple-darwin' : '/verified-tool' });
  assert.throws(() => macosPreflight({ platform: 'darwin', run, checkExecutable: () => {} }), /rustup target add x86_64-apple-darwin/);
});

test('the actual CLI reports failure on Windows and help remains available', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../build-macos.mjs', import.meta.url));
  const rejected = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /当前主机不能生成可验证/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Apple Silicon \+ Intel/);
});
