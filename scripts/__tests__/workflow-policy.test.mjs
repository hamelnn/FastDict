import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('third-party workflow actions are fixed to reviewed commits', async () => {
  const directory = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
  let count = 0;
  for (const name of await readdir(directory)) {
    const text = await readFile(join(directory, name), 'utf8');
    for (const match of text.matchAll(/\buses:\s*([^\s#]+)/g)) {
      count++;
      assert.match(match[1], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/, `${name}: mutable action ${match[1]}`);
    }
  }
  assert.ok(count >= 29, 'The complete workflow set must be checked.');
});
