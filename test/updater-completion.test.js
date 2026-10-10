import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let child;
mock.module('node:child_process', { namedExports: {
  spawn: () => { child = new EventEmitter(); child.stdout = new PassThrough(); child.unref = () => {}; return child; },
} });
mock.module('node:fs', { namedExports: { existsSync: () => true } });
mock.module('../src/paths.js', { namedExports: { ROOT: process.cwd() } });
const { runUpdater } = await import('../src/updates.js');
after(() => mock.restoreAll());

async function close(code, signal = null) {
  child.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', code, signal);
}

test('waits for stdout after exit and retains the final unterminated JSON line', async () => {
  const events = [];
  let settled = false;
  const result = runUpdater('check', e => events.push(e)).then(r => { settled = true; return r; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.write(JSON.stringify({ event: 'available', version: '1.2.3' }));
  await close(0);
  assert.deepEqual(await result, { event: 'available', version: '1.2.3' });
  assert.equal(events.length, 1);
});

test('an abnormal exit replaces stale progress with an actionable error', async () => {
  const events = [];
  const result = runUpdater('install', e => events.push(e));
  child.stdout.write('{"event":"progress","percent":12}\n');
  await close(7);
  assert.equal((await result).event, 'error');
  assert.match(events.at(-1).message, /code 7/);
});

test('signal termination becomes an error', async () => {
  const result = runUpdater('check');
  await close(null, 'SIGTERM');
  assert.match((await result).message, /SIGTERM/);
});

test('preserves a helper-provided error on nonzero exit', async () => {
  const events = [];
  const result = runUpdater('check', e => events.push(e));
  child.stdout.write('{"event":"error","message":"Bad signature"}\n');
  await close(1);
  assert.deepEqual(await result, { event: 'error', message: 'Bad signature' });
  assert.equal(events.length, 1);
});

test('spawn errors are reported once and settle on close', async () => {
  const events = [];
  let settled = false;
  const result = runUpdater('check', e => events.push(e)).then(r => { settled = true; return r; });
  child.emit('error', new Error('ENOENT'));
  await Promise.resolve();
  assert.equal(settled, false);
  await close(-2);
  assert.match((await result).message, /ENOENT/);
  assert.equal(events.length, 1);
});
