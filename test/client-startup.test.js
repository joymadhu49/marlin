import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
const lockPath = join('/test', 'starting.lock');
let operations, health, open, stat, spawnImpl;
const errno = (code) => Object.assign(new Error(code), { code });
mock.module('../src/paths.js', { namedExports: {
  paths: { home: '/test', log: '/test/log' }, ROOT: '/app',
  loadConfig: () => ({ port: 12345 }), readJson: () => ({}),
} });
mock.module('node:fs', { namedExports: {
  openSync: (...args) => open(...args),
  closeSync: (fd) => operations.push(['close', fd]),
  statSync: (...args) => stat(...args),
  rmSync: (path) => operations.push(['remove', path]),
} });
mock.module('node:child_process', { namedExports: { spawn: (...args) => spawnImpl(...args) } });
const { ensureDaemon } = await import('../src/client.js');
afterEach(() => mock.restoreAll());
function setup() {
  operations = [];
  health = false;
  open = (path) => path === '/test/log' ? 20 : 10;
  stat = () => ({ mtimeMs: Date.now() });
  spawnImpl = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => { health = true; child.emit('spawn'); });
    return child;
  };
  mock.method(globalThis, 'fetch', async () => ({ ok: health }));
}
test('lock permission errors preserve their cause without checking nonexistent lock', async () => {
  setup();
  open = () => { throw errno('EACCES'); };
  stat = () => { throw errno('ENOENT'); };
  await assert.rejects(ensureDaemon(), { code: 'EACCES' });
});
test('lock disappearing between acquisition and stat is retried', async () => {
  setup();
  let attempts = 0;
  open = (path) => {
    if (path === '/test/log') return 20;
    if (attempts++ === 0) throw errno('EEXIST');
    return 10;
  };
  stat = () => { throw errno('ENOENT'); };
  await ensureDaemon();
  assert.equal(attempts, 2);
  assert.ok(operations.some(([op, fd]) => op === 'close' && fd === 20));
});
test('parent closes launch log descriptor after successful spawn', async () => {
  setup();
  await ensureDaemon({ headless: true });
  assert.ok(operations.some(([op, fd]) => op === 'close' && fd === 20));
  assert.ok(operations.some(([op, path]) => op === 'remove' && path === lockPath));
});
test('synchronous spawn failure closes log descriptor and releases lock', async () => {
  setup();
  spawnImpl = () => { throw errno('EAGAIN'); };
  await assert.rejects(ensureDaemon(), { code: 'EAGAIN' });
  assert.ok(operations.some(([op, fd]) => op === 'close' && fd === 20));
  assert.ok(operations.some(([op, path]) => op === 'remove' && path === lockPath));
});
test('asynchronous spawn failure is reported and resources are released', async () => {
  setup();
  spawnImpl = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error', errno('ENOENT')));
    return child;
  };
  await assert.rejects(ensureDaemon(), { code: 'ENOENT' });
  assert.ok(operations.some(([op, fd]) => op === 'close' && fd === 20));
  assert.ok(operations.some(([op, path]) => op === 'remove' && path === lockPath));
});
test('another launcher becoming healthy does not spawn a duplicate', async () => {
  setup();
  open = () => { throw errno('EEXIST'); };
  stat = () => { health = true; return { mtimeMs: Date.now() }; };
  spawnImpl = () => { assert.fail('unexpected second launcher'); };
  await ensureDaemon();
  assert.deepEqual(operations, []);
});
test('stale lock is removed before retrying startup', async () => {
  setup();
  let attempts = 0;
  open = (path) => {
    if (path === '/test/log') return 20;
    if (attempts++ === 0) throw errno('EEXIST');
    return 10;
  };
  stat = () => ({ mtimeMs: Date.now() - 120_000 });
  await ensureDaemon();
  assert.equal(attempts, 2);
  assert.equal(operations.filter(([op]) => op === 'remove').length, 2);
});
