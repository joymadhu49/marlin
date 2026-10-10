import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { idFromPublicKey, installFromPath } from '../src/crx.js';

const key = Buffer.from('local-extension-test-key');
const id = idFromPublicKey(key);
const manifest = { manifest_version: 3, name: 'Test extension', version: '1.0', key: key.toString('base64') };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'marlin-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensions = join(root, 'extensions');
  await mkdir(extensions);
  return { root, extensions, dest: join(extensions, id) };
}

async function extension(dir, content = 'original') {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'content.js'), content);
}

test('reinstalling a managed keyed directory preserves its source', async (t) => {
  const { extensions, dest } = await fixture(t);
  await extension(dest);
  const result = await installFromPath(dest, extensions);
  assert.equal(result.id, id);
  assert.equal(await readFile(join(dest, 'content.js'), 'utf8'), 'original');
  assert.deepEqual(await readdir(extensions), [id]);
});

test('a symlink alias of the destination is also a safe reinstall', async (t) => {
  const { root, extensions, dest } = await fixture(t);
  await extension(dest);
  const alias = join(root, 'alias');
  await symlink(dest, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await installFromPath(alias, extensions);
  assert.equal(await readFile(join(dest, 'content.js'), 'utf8'), 'original');
});

test('rejects a source nested inside its destination without deleting either', async (t) => {
  const { extensions, dest } = await fixture(t);
  await extension(dest);
  const nested = join(dest, 'nested');
  await extension(nested, 'nested');
  await assert.rejects(installFromPath(nested, extensions), /overlapping/);
  assert.equal(await readFile(join(dest, 'content.js'), 'utf8'), 'original');
  assert.equal(await readFile(join(nested, 'content.js'), 'utf8'), 'nested');
});

test('rejects a destination nested inside the source without recursive copying', async (t) => {
  const { root } = await fixture(t);
  const source = join(root, 'source');
  await extension(source);
  await assert.rejects(installFromPath(source, join(source, 'managed')), /overlapping/);
  assert.equal(await readFile(join(source, 'content.js'), 'utf8'), 'original');
});

test('a replacement preserves the external source and removes stale installed files', async (t) => {
  const { root, extensions, dest } = await fixture(t);
  const source = join(root, 'source');
  await extension(source, 'new');
  await extension(dest, 'old');
  await writeFile(join(dest, 'obsolete.js'), 'obsolete');
  await installFromPath(source, extensions);
  assert.equal(await readFile(join(dest, 'content.js'), 'utf8'), 'new');
  assert.equal(await readFile(join(source, 'content.js'), 'utf8'), 'new');
  assert.deepEqual((await readdir(dest)).sort(), ['content.js', 'manifest.json']);
  assert.deepEqual(await readdir(extensions), [id]);
});

test('a failed copy preserves the previous install and cleans staging', { skip: process.platform === 'win32' }, async (t) => {
  const { root, extensions, dest } = await fixture(t);
  const source = join(root, 'source');
  await extension(source, 'new');
  await extension(dest, 'old');
  // Node cannot copy Unix sockets, producing a real failure during cp().
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(source, 'socket'), resolve);
  });
  try {
    await assert.rejects(installFromPath(source, extensions), /socket|copy/i);
    assert.equal(await readFile(join(dest, 'content.js'), 'utf8'), 'old');
    assert.deepEqual(await readdir(extensions), [id]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
