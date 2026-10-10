import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { selectRef } from '../src/snapshot.js';
function fixture(connected = true) {
  const events = [];
  const select = { tagName: 'SELECT', isConnected: connected, value: 'one',
    options: [{ value: 'one', text: 'First' }, { value: 'two', text: 'Second' }],
    dispatchEvent: (event) => events.push(event.type),
  };
  const choose = (ref, value) => runInNewContext(`(${selectRef.toString()})(ref, value)`, {
    window: { __marlinRefs: new Map([['e1', select]]) }, Event, ref, value,
  });
  return { select, events, choose };
}
test('detached select ref requests a fresh snapshot without changing the element', () => {
  const { select, events, choose } = fixture(false);
  const result = choose('e1', 'two');
  assert.match(result.error, /stale.*snapshot/i);
  assert.equal(select.value, 'one');
  assert.deepEqual(events, []);
});
test('connected selects still match values and dispatch input/change', () => {
  const { select, events, choose } = fixture();
  assert.equal(choose('e1', 'two').selected, 'Second');
  assert.equal(select.value, 'two');
  assert.deepEqual(events, ['input', 'change']);
});
test('unknown refs and unmatched options remain errors', () => {
  const { choose } = fixture();
  assert.match(choose('missing', 'two').error, /select/);
  assert.match(choose('e1', 'missing').error, /No option/);
});
