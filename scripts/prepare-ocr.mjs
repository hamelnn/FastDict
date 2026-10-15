import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'public/ocr');
// Both the revision and digests pin the same upstream tessdata_fast weights.
const modelRevision = '87416418657359cb625c412a48b6e1d6d41c29bd';
const models = {
  eng: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  chi_sim: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
  chi_tra: '529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b',
  jpn: '1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d',
  kor: '6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2',
};
const upstream = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${modelRevision}`;
const digest = data => createHash('sha256').update(data).digest('hex');

async function readIfPresent(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeAtomic(path, data) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Repeated dev/build starts should not rewrite large, unchanged WASM loaders.
export async function copyIfChanged(source, target) {
  const [data, existing] = await Promise.all([readFile(source), readIfPresent(target)]);
  if (!existing?.equals(data)) await writeAtomic(target, data);
}

export async function ensureModel({ target, url, sha256 }, fetchImpl = fetch) {
  const existing = await readIfPresent(target);
  if (existing) {
    try { if (digest(gunzipSync(existing)) === sha256) return; }
    catch { /* An interrupted or corrupt cache is replaced only after validation. */ }
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Unable to prepare ${basename(target)} (${response.status}). Retry npm run prepare:ocr with network access.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (digest(data) !== sha256) throw new Error(`OCR model checksum mismatch: ${basename(target)}. Cached assets were not replaced.`);
  await writeAtomic(target, gzipSync(data, { level: 9 }));
}

async function main() {
  await Promise.all(['core', 'lang'].map(folder => mkdir(resolve(destination, folder), { recursive: true })));
  // LSTM-only recognition uses two loaders with embedded WASM.
  const assets = [
    ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
    ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
    ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
    ['tesseract.js/LICENSE.md', 'tesseract.js-LICENSE.txt'],
    ['tesseract.js-core/LICENSE', 'tesseract.js-core-LICENSE.txt'],
  ];
  await Promise.all([
    ...assets.map(([source, target]) => copyIfChanged(resolve(root, 'node_modules', source), resolve(destination, target))),
    ...Object.entries(models).map(([language, sha256]) => ensureModel({
      target: resolve(destination, 'lang', `${language}.traineddata.gz`),
      url: `${upstream}/${language}.traineddata`, sha256,
    })),
  ]);
  const license = resolve(destination, 'tessdata-LICENSE.txt');
  if (!(await readIfPresent(license))?.length) {
    const response = await fetch(`${upstream}/LICENSE`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Unable to prepare OCR model license. Retry npm run prepare:ocr.');
    await writeAtomic(license, await response.text());
  }
  process.stdout.write('Local OCR assets verified. No runtime model downloads.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
