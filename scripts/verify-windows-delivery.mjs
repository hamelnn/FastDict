import { mkdir, copyFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDelivery } from './build-artifacts.mjs';

export async function verifyWindowsDelivery(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyDelivery(directory, manifest);
  const expected = new Set(['manifest.json', ...manifest.artifacts.map(artifact => artifact.name)]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !expected.has(entry.name)) throw new Error(`交付目录包含清单外文件：${entry.name}`);
  }
  return manifest;
}

export async function stageWindowsDelivery(source, destination) {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  await verifyDelivery(source, manifest);
  // A fresh directory avoids carrying a previous version into an artifact.
  await mkdir(destination);
  for (const name of ['manifest.json', ...manifest.artifacts.map(artifact => artifact.name)]) await copyFile(join(source, name), join(destination, name));
  await verifyWindowsDelivery(destination);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...args] = process.argv.slice(2);
  const destination = args.find(arg => arg.startsWith('--stage='))?.slice(8);
  (async () => {
    if (!directory || args.some(arg => !arg.startsWith('--stage='))) throw new Error('用法：node scripts/verify-windows-delivery.mjs 目录 [--stage=新交付目录]');
    if (destination) await stageWindowsDelivery(resolve(directory), resolve(destination));
    else await verifyWindowsDelivery(resolve(directory));
    process.stdout.write('Windows 交付目录及全部文件哈希校验通过。\n');
  })().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
