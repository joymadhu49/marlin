import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = await mkdtemp(join(tmpdir(), 'marlin-download-home-'));
process.env.MARLIN_HOME = home;
const { fetchChromium } = await import('../src/fetch-chromium.js');
import { after } from 'node:test';
after(() => rm(home, { recursive: true, force: true }));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'marlin-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
for (const [arch, bucket] of [['x64', 'Win_x64'], ['arm64', 'Win_Arm64'], ['ia32', 'Win']])
test(`downloads the Windows ${arch} archive and records the revision`, async (t) => {
  const root = await fixture(t), urls = [];
  const result = await fetchChromium({ root, platform: 'win32', arch, revision: '',
    fetchImpl: async (url) => { urls.push(url); return new Response(url.endsWith('LAST_CHANGE') ? '12345\n' : 'zip'); },
    extract: async (_, dest) => { await mkdir(join(dest, 'chrome-win')); await writeFile(join(dest, 'chrome-win', 'chrome.exe'), 'binary'); },
  });
  assert.equal(urls[1], `https://storage.googleapis.com/chromium-browser-snapshots/${bucket}/12345/chrome-win.zip`);
  assert.equal(await readFile(result.executable, 'utf8'), 'binary');
  assert.equal(await readFile(join(root, 'chromium', 'REVISION'), 'utf8'), '12345');
  assert.deepEqual((await readdir(join(root, 'chromium'))).sort(), ['REVISION', 'chrome-win']);
});
test('revision and download failures preserve an installed binary', async (t) => {
  const root = await fixture(t), binary = join(root, 'chromium', 'chrome-win', 'chrome.exe');
  await mkdir(join(root, 'chromium', 'chrome-win'), { recursive: true }); await writeFile(binary, 'previous');
  const opts = { root, platform: 'win32', arch: 'x64' };
  await assert.rejects(fetchChromium({ ...opts, revision: '', fetchImpl: async () => new Response('', { status: 503 }) }), /lookup failed/);
  await assert.rejects(fetchChromium({ ...opts, revision: '../bad' }), /Invalid/);
  await assert.rejects(fetchChromium({ ...opts, revision: '123', fetchImpl: async () => new Response('', { status: 404 }) }), /download failed/);
  await assert.rejects(fetchChromium({ ...opts, revision: '123', fetchImpl: async () => new Response('zip'), extract: async () => {} }), /no Chromium executable/);
  assert.equal(await readFile(binary, 'utf8'), 'previous');
  assert.deepEqual(await readdir(join(root, 'chromium')), ['chrome-win']);
});
