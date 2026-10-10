import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';

function agent(events = []) {
  return new Agent({ tools: {}, config: { openrouterKey: 'test', model: 'test', maxSteps: 1 }, emit: e => events.push(e) });
}

test('model discovery marks the run busy and can be stopped before completion', async (t) => {
  const events = [];
  let requestedSignal;
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    assert.ok(url.endsWith('/models'), 'no completion request after stopping');
    requestedSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const a = agent(events);
  const running = a.run('hello');
  assert.equal(a.busy, true);
  assert.equal(events[0].type, 'run_start');
  await assert.rejects(a.run('overlap'), /already running/);
  assert.equal(a.busy, true);
  a.stop();
  assert.equal(requestedSignal.aborted, true);
  await running;
  assert.equal(a.busy, false);
  assert.deepEqual(events.at(-1), { type: 'run_end', error: 'Stopped' });
  assert.deepEqual(a.history, []);
});

test('a discovery failure still permits a completion and a later run', async (t) => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/models')) throw new Error('catalog unavailable');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'done' } }] }) };
  });
  const events = [];
  const a = agent(events);
  await a.run('first');
  await a.run('second');
  assert.equal(a.busy, false);
  assert.equal(events.filter(e => e.type === 'assistant').length, 2);
  assert.equal(events.filter(e => e.type === 'run_end' && !e.error).length, 2);
});
