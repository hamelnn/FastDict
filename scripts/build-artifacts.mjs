import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

// Ask Cargo itself: this includes CARGO_TARGET_DIR and .cargo/config.toml.
// Pin the returned absolute directory in every later child process so Tauri's
// working-directory changes cannot reinterpret a relative environment value.
export function cargoTargetDirectory(root, env, run = spawnSync) {
  const result = run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', join(root, 'src-tauri/Cargo.toml')], {
    cwd: join(root, 'src-tauri'), env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('无法读取 Cargo 构建目录；请检查 Rust 与锁文件。');
  let directory;
  try { directory = JSON.parse(result.stdout).target_directory; } catch { /* Fail closed below. */ }
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Cargo 没有返回有效的绝对 target_directory。');
  return resolve(directory);
}

export function desktopOutputPaths(targetDirectory, target) {
  const release = join(targetDirectory, target, 'release');
  return { release, executable: join(release, 'fastdict.exe'), bundle: join(release, 'bundle'), nsis: join(release, 'bundle/nsis') };
}

// A build-script message identifies the dependency output actually used by this
// cargo invocation, including a Fresh cached dependency. Never scan old hashes.
export function webviewLoaderFromBuild(stdout) {
  const outputs = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line);
      if (message.reason === 'build-script-executed' && /(?:^|[#/])webview2-com-sys(?:@|\s)/.test(message.package_id) && isAbsolute(message.out_dir)) outputs.add(message.out_dir);
    } catch { /* Non-Cargo output, e.g. the frontend build, is expected. */ }
  }
  if (outputs.size !== 1) throw new Error('无法从本次 Cargo 构建记录唯一确认 WebView2Loader.dll；不会复用历史目录。');
  return join([...outputs][0], 'x64/WebView2Loader.dll');
}

export async function artifactRecords(directory, names) {
  return Promise.all(names.map(async name => {
    const bytes = await readFile(join(directory, name));
    if (!bytes.length || !(await stat(join(directory, name))).isFile()) throw new Error(`构建产物为空或不是文件：${name}`);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

export async function verifyDelivery(directory, manifest) {
  const names = manifest.artifacts.map(artifact => artifact.name);
  if (new Set(names).size !== names.length || names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error('交付清单文件名无效或重复。');
  const actual = await artifactRecords(directory, names);
  if (actual.some((artifact, index) => artifact.bytes !== manifest.artifacts[index].bytes || artifact.sha256 !== manifest.artifacts[index].sha256)) throw new Error('交付文件与清单不一致。');
}
