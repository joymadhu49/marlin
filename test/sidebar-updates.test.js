import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function sidebar() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, textContent: '', value: '', style: {}, addEventListener() {}, classList: { toggle() {} } });
    return elements.get(selector);
  };
  let socket;
  const sent = [];
  class FakeWebSocket {
    readyState = 1;
    constructor() { socket = this; }
    send(message) { sent.push(JSON.parse(message)); }
  }
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    self: { MARLIN: { port: 1, token: 'test' } }, WebSocket: FakeWebSocket,
  });
  vm.runInContext(readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'), context);
  return { element, sent, update: u => socket.onmessage({ data: JSON.stringify({ type: 'update_status', ...u }) }) };
}

test('failed install displays its error and enables a retry after the button was disabled', () => {
  const { element, sent, update } = sidebar();
  update({ event: 'available', version: '1.0' });
  element('#updInstall').onclick();
  assert.equal(element('#updInstall').disabled, true);
  assert.equal(sent.at(-1).type, 'install_update');
  update({ event: 'progress', version: '1.0', percent: 50 });
  assert.equal(element('#checkUpdate').disabled, true);
  update({ event: 'error', version: '1.0', message: 'Download failed' });
  assert.equal(element('#updBanner').hidden, false);
  assert.equal(element('#updText').textContent, 'Download failed');
  assert.equal(element('#updInstall').hidden, false);
  assert.equal(element('#updInstall').disabled, false);
  assert.equal(element('#updInstall').textContent, 'Retry');
  assert.equal(element('#checkUpdate').disabled, false);
  element('#updInstall').onclick();
  assert.equal(sent.at(-1).type, 'install_update');
});

test('catalog errors without a version remain visible and retry the check', () => {
  const { element, sent, update } = sidebar();
  update({ event: 'checking' });
  assert.equal(element('#checkUpdate').disabled, true);
  update({ event: 'error', message: '<b>Offline</b>' });
  assert.equal(element('#updBanner').hidden, false);
  assert.equal(element('#updText').textContent, '<b>Offline</b>');
  element('#updInstall').onclick();
  assert.equal(sent.at(-1).type, 'check_update');
  update({ event: 'none' });
  assert.equal(element('#updBanner').hidden, true);
  assert.equal(element('#checkUpdate').disabled, false);
});

test('fresh availability clears failed state and re-enables install', () => {
  const { element, update } = sidebar();
  update({ event: 'error' });
  assert.match(element('#updText').textContent, /Update failed/);
  element('#updInstall').onclick();
  update({ event: 'available', version: '2.0' });
  assert.equal(element('#updInstall').disabled, false);
  assert.equal(element('#updInstall').textContent, 'Install');
  assert.equal(element('#updText').textContent, 'Marlin 2.0 is available');
});
