import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip } from '../src/archive.js';
const fixture = 'UEsDBBQAAAAAAIuQSl2RK1K9EgAAABIAAAAcAAAAZm9sZGVyIHdpdGggc3BhY2VzL2hlbGxvLnR4dGhlbGxvIGZyb20gYXJjaGl2ZVBLAQIUAxQAAAAAAIuQSl2RK1K9EgAAABIAAAAcAAAAAAAAAAAAAACAAQAAAABmb2xkZXIgd2l0aCBzcGFjZXMvaGVsbG8udHh0UEsFBgAAAAABAAEASgAAAEwAAAAAAA==';
test('extracts a ZIP using native tools with spaces in paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'marlin zip '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'input file.zip');
  await writeFile(archive, Buffer.from(fixture, 'base64'));
  await extractZip(archive, join(root, 'output folder'));
  assert.equal(await readFile(join(root, 'output folder', 'folder with spaces', 'hello.txt'), 'utf8'), 'hello from archive');
});
test('invalid archives reject instead of reporting success', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'marlin-bad-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'bad.zip');
  await writeFile(archive, 'not a ZIP');
  await assert.rejects(extractZip(archive, join(root, 'output')));
});
