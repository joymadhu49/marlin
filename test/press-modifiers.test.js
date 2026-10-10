import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
mock.module('../src/paths.js', { namedExports: { paths: {} } });
mock.module('../src/browser.js', { namedExports: { settle: async () => {}, sleep: async () => {} } });
mock.module('../src/vault.js', { namedExports: { listSecrets: () => [], revealSecret() {}, redact: (text) => text } });
const { buildTools } = await import('../src/tools.js');
function fixture({ failDown, failPress, failUp } = {}) {
  const calls = [], held = new Set();
  const page = {
    target: () => ({ _targetId: 'test-tab' }),
    keyboard: {
      async down(key) { calls.push(`down:${key}`); if (key === failDown) throw new Error('down failed'); held.add(key); },
      async press(key) { calls.push(`press:${key}`); if (failPress) throw new Error('press failed'); },
      async up(key) { calls.push(`up:${key}`); held.delete(key); if (key === failUp) throw new Error('up failed'); },
    },
  };
  const mb = { config: {}, dialogs: new Map(), pageFor: async () => page, drainEvents: () => [] };
  return { press: buildTools(mb).press, calls, held };
}
test('failed main key releases every successfully held modifier in reverse order', async () => {
  const { press, calls, held } = fixture({ failPress: true });
  await assert.rejects(press.run({ key: 'Ctrl+Shift+InvalidKey' }), /press failed/);
  assert.deepEqual(calls, ['down:Control', 'down:Shift', 'press:InvalidKey', 'up:Shift', 'up:Control']);
  assert.equal(held.size, 0);
});
test('failed modifier acquisition releases earlier modifiers only', async () => {
  const { press, calls, held } = fixture({ failDown: 'Invalid' });
  await assert.rejects(press.run({ key: 'Ctrl+Invalid+A' }), /down failed/);
  assert.deepEqual(calls, ['down:Control', 'down:Invalid', 'up:Control']);
  assert.equal(held.size, 0);
});
test('cleanup continues after a release failure and preserves the main error', async () => {
  const { press, calls } = fixture({ failPress: true, failUp: 'Shift' });
  await assert.rejects(press.run({ key: 'Ctrl+Shift+InvalidKey' }), /press failed/);
  assert.deepEqual(calls.slice(-2), ['up:Shift', 'up:Control']);
});
test('successful chord still normalizes aliases and releases keys', async () => {
  const { press, calls, held } = fixture();
  await press.run({ key: 'Cmd+Shift+A' });
  assert.deepEqual(calls, ['down:Meta', 'down:Shift', 'press:A', 'up:Shift', 'up:Meta']);
  assert.equal(held.size, 0);
});
