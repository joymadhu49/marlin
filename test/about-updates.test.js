import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function about() {
  const elements = new Map();
  function element() {
    return { hidden: false, disabled: false, textContent: '', style: {}, children: [],
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  }
  let socket;
  const sent = [];
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  class FakeWebSocket {
    constructor() { socket = this; }
    send(message) { sent.push(JSON.parse(message)); }
  }
  // Exercise the plain-text (Windows GitHub notes) path without an HTML DOM.
  class DOMParser { parseFromString() { return { querySelectorAll: () => [], querySelector: () => null }; } }
  const context = vm.createContext({ document: { querySelector: get, createElement: element },
    self: { MARLIN: { port: 1, token: 'test' } }, WebSocket: FakeWebSocket, DOMParser });
  vm.runInContext(readFileSync(new URL('../extension/about.js', import.meta.url), 'utf8'), context);
  return { get, sent, update: value => socket.onmessage({ data: JSON.stringify({ type: 'update_status', ...value }) }) };
}

test('Windows release notes remain plain text and install uses the browser update channel', () => {
  const { get, sent, update } = about();
  const notes = '# New release\n<img src=x onerror=alert(1)>\n- Windows updates';
  update({ event: 'available', version: '0.3.0-windows.3', notes, size: 1048576 });
  assert.equal(get('#updNotes').children[0].textContent, notes);
  assert.equal(get('#updSize').textContent, '1 MB');
  assert.equal(get('#install').hidden, false);
  get('#install').onclick();
  assert.equal(sent[0].type, 'install_update');
  update({ event: 'progress', version: '0.3.0-windows.3', percent: 30 });
  assert.equal(get('#check').disabled, true);
  assert.equal(get('#install').hidden, true);
  assert.equal(get('#barFill').style.width, '30%');
});

test('detached installation failures remain visible and permit checking again', () => {
  const { get, sent, update } = about();
  update({ event: 'error', message: 'Close MCP clients and retry.' });
  assert.equal(get('#status').textContent, 'Close MCP clients and retry.');
  assert.equal(get('#check').disabled, false);
  get('#check').onclick();
  assert.equal(sent[0].type, 'check_update');
});
