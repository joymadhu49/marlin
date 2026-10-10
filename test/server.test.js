// Run: node --experimental-test-module-mocks --test test/server.test.js
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

let home, daemon, port, token, previousHome;
const originalListeners = new Map();
const clients = new Set();
const builtinId = 'test-extension';
let updater = async () => {};

before(async () => {
  previousHome = process.env.MARLIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'marlin-server-test-'));
  process.env.MARLIN_HOME = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 0, headless: true }));
  for (const signal of ['SIGINT', 'SIGTERM']) originalListeners.set(signal, process.listeners(signal));

  class FakeBrowser extends EventEmitter {
    builtinId = builtinId;
    browser = { version: async () => 'Chromium/test' };
    async start() {}
    async stop() {}
    async listExtensions() { return []; }
  }
  mock.module('../src/browser.js', { namedExports: { MarlinBrowser: FakeBrowser } });
  mock.module('../src/tools.js', { namedExports: {
    buildTools: () => ({ echo: {
      name: 'echo', description: 'Test tool', jsonSchema: { type: 'object' },
      run: async (args) => ({ text: JSON.stringify(args) }),
    } }),
  } });
  mock.module('../src/agent.js', { namedExports: {
    Agent: class { busy = false; stop() {} },
    listModels: async () => [], openRouterKey: () => '',
  } });
  mock.module('../src/vault.js', { namedExports: {
    listSecrets: () => [], setSecret: async () => {}, removeSecret: async () => {}, warmSecrets: async () => {},
  } });
  mock.module('../src/updates.js', { namedExports: {
    canUpdate: () => false, runUpdater: (...args) => updater(...args),
  } });
  const { startDaemon } = await import('../src/server.js');
  daemon = await startDaemon({ headless: true });
  port = daemon.server.address().port;
  token = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).token;
});

after(async () => {
  for (const client of clients) client.terminate();
  if (daemon) {
    daemon.server.closeAllConnections();
    await new Promise((resolve) => daemon.server.close(resolve));
  }
  for (const [signal, originals] of originalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!originals.includes(listener)) process.removeListener(signal, listener);
    }
  }
  mock.restoreAll();
  if (previousHome === undefined) delete process.env.MARLIN_HOME;
  else process.env.MARLIN_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      // Bind an ephemeral port while satisfying validation against config.port.
      headers: { Host: '127.0.0.1:0', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function assertHealthy() {
  const res = await request('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.name, 'marlin');
}

test('health remains available without authorization', assertHealthy);

for (const path of ['//', 'http://[']) {
  test(`malformed HTTP target ${path} returns 400 and leaves daemon healthy`, async () => {
    const res = await request(path);
    assert.equal(res.status, 400);
    await assertHealthy();
  });
}

test('untrusted Host is rejected', async () => {
  assert.equal((await request('/health', { headers: { Host: 'example.com' } })).status, 403);
});

test('Host validation precedes malformed HTTP target parsing', async () => {
  assert.equal((await request('//', { headers: { Host: 'example.com' } })).status, 403);
  await assertHealthy();
});

test('tools require authorization and authenticated requests still route', async () => {
  assert.equal((await request('/tools')).status, 401);
  assert.equal((await request('/tools', { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await request('/tools', { headers });
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].name, 'echo');
  const result = await request('/tools/echo', { method: 'POST', headers, body: { message: 'hello' } });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body.text), { message: 'hello' });
});

test('concurrent update requests launch only one installer and recover after failure', async () => {
  let rejectInstall;
  const calls = [];
  updater = (mode, onEvent, options) => {
    calls.push({ mode, options });
    return new Promise((resolve, reject) => { rejectInstall = reject; });
  };
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const first = await request('/update', { method: 'POST', headers, body: { install: true } });
    assert.equal(first.status, 200);
    await request('/update', { method: 'POST', headers, body: { install: true } });
    await request('/update', { method: 'POST', headers, body: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'install');
    assert.equal(typeof calls[0].options.shutdown, 'function');
    rejectInstall(new Error('Network unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    updater = async (mode, onEvent) => onEvent({ event: 'none' });
    const next = await request('/update', { method: 'POST', headers, body: {} });
    assert.equal(next.body.event, 'none');
    await assertHealthy();
  } finally { updater = async () => {}; }
});

function upgrade(path, { origin = `chrome-extension://${builtinId}`, host = '127.0.0.1:0' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(1500, () => socket.destroy(new Error('Upgrade request timed out')));
    socket.on('error', reject);
    socket.on('data', (data) => { response += data.toString(); });
    socket.on('close', () => resolve(response));
    socket.on('connect', () => socket.write([
      `GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade',
      'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Origin: ${origin}`, '', '',
    ].join('\r\n')));
  });
}

for (const path of ['//', 'http://[']) {
  test(`malformed WebSocket target ${path} closes connection and leaves daemon healthy`, async () => {
    const response = await upgrade(path);
    assert.doesNotMatch(response, /101 Switching Protocols/);
    await assertHealthy();
  });
}

test('WebSocket rejects an untrusted origin with a valid token', async () => {
  const response = await upgrade(`/ws?token=${token}`, { origin: 'https://example.com' });
  assert.doesNotMatch(response, /101 Switching Protocols/);
  await assertHealthy();
});

for (const path of ['/ws', '/ws?token=wrong-token']) {
  test(`WebSocket rejects missing or invalid authorization: ${path}`, async () => {
    const response = await upgrade(path);
    assert.doesNotMatch(response, /101 Switching Protocols/);
    await assertHealthy();
  });
}

test('WebSocket rejects an untrusted Host with a valid token', async () => {
  const response = await upgrade(`/ws?token=${token}`, { host: 'example.com' });
  assert.doesNotMatch(response, /101 Switching Protocols/);
  await assertHealthy();
});

for (const [name, options] of [
  ['extension', { origin: `chrome-extension://${builtinId}` }],
  ['originless', {}],
]) {
  test(`authenticated ${name} WebSocket receives daemon status`, async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: { Host: '127.0.0.1:0' }, ...options,
      handshakeTimeout: 1500,
    });
    clients.add(ws);
    const [message] = await once(ws, 'message', { signal: AbortSignal.timeout(1500) });
    assert.equal(JSON.parse(message).type, 'status');
    const closed = once(ws, 'close');
    ws.close();
    await closed;
    clients.delete(ws);
  });
}
