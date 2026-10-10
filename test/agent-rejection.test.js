import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

test('a rejected sidebar run ends the run and keeps the connection usable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'marlin-agent-test-'));
  const previousHome = process.env.MARLIN_HOME;
  process.env.MARLIN_HOME = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 0, headless: true }));
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(s => [s, process.listeners(s)]));
  let daemon, ws;
  try {
    class FakeBrowser extends EventEmitter {
      browser = { version: async () => 'Chromium/test' };
      builtinId = 'test';
      async start() {}
      async listExtensions() { return []; }
    }
    mock.module('../src/browser.js', { namedExports: { MarlinBrowser: FakeBrowser } });
    mock.module('../src/tools.js', { namedExports: { buildTools: () => ({}) } });
    mock.module('../src/agent.js', { namedExports: {
      Agent: class { busy = false; async run() { throw new Error('Missing API key'); } },
      listModels: async () => [], openRouterKey: () => '',
    } });
    mock.module('../src/vault.js', { namedExports: { listSecrets: () => [], setSecret() {}, removeSecret() {}, warmSecrets() {} } });
    mock.module('../src/updates.js', { namedExports: { canUpdate: () => false, runUpdater() {} } });
    const { startDaemon } = await import('../src/server.js');
    daemon = await startDaemon({ headless: true });
    const token = JSON.parse(readFileSync(join(home, 'state.json'))).token;
    ws = new WebSocket(`ws://127.0.0.1:${daemon.server.address().port}/ws?token=${token}`, { headers: { Host: '127.0.0.1:0' }, handshakeTimeout: 1500 });
    const next = () => once(ws, 'message', { signal: AbortSignal.timeout(1500) }).then(([m]) => JSON.parse(m));
    assert.equal((await next()).type, 'status');
    const rejected = next();
    ws.send(JSON.stringify({ type: 'chat', text: 'hello' }));
    assert.deepEqual(await rejected, { type: 'run_end', error: 'Missing API key' });
    const status = next();
    ws.send(JSON.stringify({ type: 'status' }));
    assert.equal((await status).busy, false);
  } finally {
    if (ws) { const closed = once(ws, 'close'); ws.terminate(); await closed; }
    if (daemon) await new Promise(resolve => daemon.server.close(resolve));
    for (const [signal, originals] of listeners) for (const listener of process.listeners(signal)) if (!originals.includes(listener)) process.removeListener(signal, listener);
    mock.restoreAll();
    if (previousHome === undefined) delete process.env.MARLIN_HOME;
    else process.env.MARLIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
