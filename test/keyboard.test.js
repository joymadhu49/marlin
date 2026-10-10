import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectAll } from '../src/keyboard.js';
for (const [platform, modifier] of [['win32', 'Control'], ['darwin', 'Meta']]) {
  test(`select-all uses and releases ${modifier} on ${platform}`, async () => {
    const calls = [];
    const keyboard = Object.fromEntries(['down', 'press', 'up'].map((method) => [method, async (key) => { calls.push([method, key]); }]));
    await selectAll(keyboard, platform);
    assert.deepEqual(calls, [['down', modifier], ['press', 'KeyA'], ['up', modifier]]);
  });
}
test('select-all releases its modifier after a failed key press', async () => {
  const released = [];
  await assert.rejects(selectAll({ down: async () => {}, press: async () => { throw Error('closed'); }, up: async (key) => released.push(key) }, 'win32'), /closed/);
  assert.deepEqual(released, ['Control']);
});
