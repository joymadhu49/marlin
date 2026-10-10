import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { join } from 'node:path';
import { parseExtensionRef } from '../src/crx.js';

const extensionId = 'a'.repeat(32);
const home = join('fixture-home', 'user');
const calls = [];
const result = { id: extensionId, dir: '/nonexistent-marlin-fixture', manifest: { name: 'Fixture', version: '1.0' } };
mock.module('puppeteer-core', { defaultExport: {} });
mock.module('node:os', { namedExports: { homedir: () => home } });
mock.module('../src/paths.js', { namedExports: {
  paths: { extensions: '/fixture-extensions', registry: '/fixture-registry' },
  chromiumPath() {}, readJson: () => [], writeJson() {},
} });
mock.module('../src/crx.js', { namedExports: {
  parseExtensionRef, idFromPublicKey() {},
  installFromPath: async (path) => { calls.push(['local', path]); return result; },
  downloadFromStore: async (source) => { calls.push(['store', source]); return result; },
} });
const { MarlinBrowser } = await import('../src/browser.js');
async function install(source) {
  calls.length = 0;
  const browser = new MarlinBrowser({});
  browser.browser = { version: async () => 'Chromium/157.0' };
  browser.cdp = { send: async (method, args) => {
    assert.equal(method, 'Extensions.loadUnpacked');
    assert.equal(args.path, result.dir);
    return { id: extensionId };
  } };
  const entry = await browser.installExtension(source);
  assert.equal(entry.id, extensionId);
  return calls[0];
}
for (const source of [
  `C:\\Users\\Agent\\Extensions\\${extensionId}`,
  `C:/Users/Agent/Extensions/${extensionId}`,
  `\\\\server\\share\\${extensionId}`,
  `/tmp/${extensionId}`,
]) {
  test(`absolute local extension stays local: ${source}`, async () => {
    assert.deepEqual(await install(source), ['local', source]);
  });
}
for (const source of ['~/extension', '~\\extension', '~']) {
  test(`tilde path uses OS home without HOME: ${source}`, async (t) => {
    const previous = process.env.HOME;
    delete process.env.HOME;
    t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
    assert.deepEqual(await install(source), ['local', source === '~' ? home : join(home, 'extension')]);
  });
}
for (const source of [extensionId, `https://chromewebstore.google.com/detail/fixture/${extensionId}`]) {
  test(`store reference remains a download: ${source}`, async () => {
    assert.deepEqual(await install(source), ['store', source]);
  });
}
