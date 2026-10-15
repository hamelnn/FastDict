import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, readdir, rm, rmdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { copyIfChanged, ensureModel } from '../prepare-ocr.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fastdict-ocr-test-'));
  t.after(async () => {
    await Promise.all((await readdir(directory)).map(name => rm(join(directory, name))));
    await rmdir(directory);
  });
  const target = join(directory, 'test.traineddata.gz');
  const data = Buffer.from('verified model fixture');
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { directory, target, data, request: { target, sha256, url: 'https://example.invalid/model' } };
}

test('a valid OCR cache works offline without rewriting its file', async t => {
  const { target, data, request } = await fixture(t);
  await writeFile(target, gzipSync(data));
  await utimes(target, 1, 1);
  const before = await stat(target);
  await ensureModel(request, () => assert.fail('valid cache must not access the network'));
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
});

test('a truncated OCR cache is repaired and leaves no temporary files', async t => {
  const { directory, target, data, request } = await fixture(t);
  await writeFile(target, gzipSync(data).subarray(0, 15));
  await ensureModel(request, async () => new Response(data));
  assert.deepEqual(gunzipSync(await readFile(target)), data);
  assert.deepEqual(await readdir(directory), ['test.traineddata.gz']);
});

test('an incorrect download never replaces existing OCR bytes', async t => {
  const { directory, target, request } = await fixture(t);
  const previous = gzipSync(Buffer.from('older model'));
  await writeFile(target, previous);
  await assert.rejects(ensureModel(request, async () => new Response('unexpected payload')), /checksum mismatch/);
  assert.deepEqual(await readFile(target), previous);
  assert.deepEqual(await readdir(directory), ['test.traineddata.gz']);
});

test('unchanged loaders retain their timestamp while changed bytes are refreshed', async t => {
  const { directory, target } = await fixture(t);
  const source = join(directory, 'source.js');
  await writeFile(source, 'first');
  await copyIfChanged(source, target);
  await utimes(target, 1, 1);
  const before = await stat(target);
  await copyIfChanged(source, target);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  await writeFile(source, 'other'); // Same length: size alone is not a safe cache key.
  await copyIfChanged(source, target);
  assert.equal(await readFile(target, 'utf8'), 'other');
});
