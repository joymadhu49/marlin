// The Marlin daemon: launches Chromium and serves the tool API on loopback.
//   GET  /health                 no auth
//   GET  /tools                  tool list with JSON schemas
//   POST /tools/:name            run a tool, body = args JSON
//   GET  /ws?token=...           sidebar channel (chat, approvals, settings)
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { join } from 'node:path';
import { paths, loadConfig, saveConfig, readJson, writeJson, ROOT } from './paths.js';
import { MarlinBrowser } from './browser.js';
import { buildTools } from './tools.js';
import { Agent, listModels, openRouterKey } from './agent.js';
import { runUpdater, canUpdate } from './updates.js';
import { listSecrets, setSecret, removeSecret, warmSecrets } from './vault.js';

export async function startDaemon({ headless } = {}) {
  const config = loadConfig();
  if (headless != null) config.headless = headless;
  const token = readJson(paths.state, {}).token || randomBytes(24).toString('hex');
  writeJson(paths.state, { port: config.port, cdpPort: config.cdpPort, token, pid: process.pid, startedAt: new Date().toISOString() }, true);

  await warmSecrets();
  const mb = new MarlinBrowser(config);
  const sockets = new Set();
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); };

  // Human approval for wallet confirm/sign clicks.
  const pending = new Map();
  async function approve(req) {
    const id = randomBytes(6).toString('hex');
    const { screenshot, ...meta } = req;
    const p = new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); broadcast({ type: 'approval_done', id, ok: false }); resolve(false); }, 180_000);
      pending.set(id, { ...meta, screenshot, resolve: (ok) => { clearTimeout(timer); pending.delete(id); broadcast({ type: 'approval_done', id, ok }); resolve(ok); } });
    });
    broadcast({ type: 'approval', id, ...meta, screenshot });
    notify(`${meta.extension}: agent wants to press "${meta.action}"`, 'Approve or decline in the Marlin sidebar');
    if (![...sockets].some((ws) => ws.readyState === 1)) {
      // No sidebar open: show the approval page in a background tab.
      mb.browser.newPage().then((pg) => pg.goto(`chrome-extension://${mb.builtinId}/approve.html#${id}`)).catch(() => {});
    }
    return p;
  }

  await mb.start();
  const tools = buildTools(mb, { approve });
  const agent = new Agent({ tools, config, emit: broadcast });
  mb.on('event', (text) => broadcast({ type: 'browser_event', text }));

  // Updates live in the browser UI: a quiet check after the human opens Marlin.
  // A detached Windows installer can fail after this daemon exits. Surface its
  // result after restart instead of losing it with the old WebSocket connection.
  const previousUpdate = process.platform === 'win32'
    ? readJson(join(paths.home, 'update-result.json'), null) : null;
  let update = previousUpdate?.event === 'error'
    ? { event: 'error', message: String(previousUpdate.message || 'The previous update failed. See update.log in the Marlin data directory.') }
    : { event: 'idle' };
  let updateBusy = false;
  const onUpdate = (e) => { update = { ...update, ...e }; broadcast({ type: 'update_status', ...update }); };
  async function checkUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    update = { event: 'checking' };
    broadcast({ type: 'update_status', ...update });
    try { await runUpdater('check', onUpdate); }
    catch (error) { onUpdate({ event: 'error', message: error.message }); }
    finally { updateBusy = false; }
  }
  async function installUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    update = { ...update, event: 'downloading', percent: 0 };
    broadcast({ type: 'update_status', ...update });
    try {
      await runUpdater('install', onUpdate, { shutdown, browserPid: mb.browser?.process?.()?.pid });
    } catch (error) { onUpdate({ event: 'error', message: error.message }); }
    finally { updateBusy = false; }
  }
  if (!config.headless && canUpdate() && update.event !== 'error') setTimeout(checkUpdate, 8000);

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!hostOk(req.headers.host, config.port)) return send(403, { error: 'bad host' });
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return send(400, { error: 'invalid request target' }); }
    if (url.pathname === '/health') return send(200, { ok: true, name: 'marlin', pid: process.pid, cdp: `http://127.0.0.1:${config.cdpPort}` });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/tools') {
        return send(200, Object.values(tools).map((t) => ({ name: t.name, description: t.description, inputSchema: t.jsonSchema })));
      }
      const m = url.pathname.match(/^\/tools\/(\w+)$/);
      if (req.method === 'POST' && m) {
        const tool = tools[m[1]];
        if (!tool) return send(404, { error: `unknown tool ${m[1]}` });
        const args = await readBody(req);
        broadcast({ type: 'external_tool', name: tool.name, args });
        const out = await tool.run(args);
        return send(200, out);
      }
      if (url.pathname === '/update' && req.method === 'POST') {
        const { install } = await readBody(req);
        if (install) { installUpdate(); return send(200, { ok: true, event: 'installing' }); }
        await checkUpdate();
        return send(200, update);
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        send(200, { ok: true });
        return setTimeout(() => shutdown(), 100);
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { socket.destroy(); return; }
    const origin = req.headers.origin || '';
    const originOk = !origin || origin === `chrome-extension://${mb.builtinId}`;
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token || !originOk || !hostOk(req.headers.host, config.port)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const reply = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
    const status = async () => ({
      type: 'status',
      model: config.model,
      signPolicy: config.signPolicy,
      hasKey: !!openRouterKey(config),
      busy: agent.busy,
      secrets: listSecrets(),
      extensions: await mb.listExtensions().catch(() => []),
      cdp: `http://127.0.0.1:${config.cdpPort}`,
      mcpCommand: `${process.execPath} ${join(ROOT, 'src', 'cli.js')} mcp`,
      version: VERSION,
      update,
      chromium: (await mb.browser.version().catch(() => '')).split('/')[1] || '',
    });
    status().then(reply);
    for (const [id, p] of pending) reply({ type: 'approval', id, extension: p.extension, action: p.action, url: p.url, screenshot: p.screenshot });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        switch (msg.type) {
          case 'chat':
            if (agent.busy) return reply({ type: 'error', text: 'Agent is already running' });
            await agent.run(String(msg.text || ''), msg.model || config.model)
              .catch((error) => reply({ type: 'run_end', error: error.message }));
            break;
          case 'stop': agent.stop(); break;
          case 'reset': agent.reset(); reply({ type: 'reset_done' }); break;
          case 'models': reply({ type: 'models', models: await listModels() }); break;
          case 'set_model': config.model = msg.model; saveConfig({ model: msg.model }); reply(await status()); break;
          case 'set_policy':
            config.signPolicy = ['ask', 'smart', 'allow'].includes(msg.policy) ? msg.policy : 'smart';
            saveConfig({ signPolicy: config.signPolicy });
            reply(await status());
            break;
          case 'set_key': config.openrouterKey = String(msg.key || '').trim(); saveConfig({ openrouterKey: config.openrouterKey }); reply(await status()); break;
          case 'set_secret': await setSecret(msg.name, msg.value); reply(await status()); break;
          case 'remove_secret': await removeSecret(msg.name); reply(await status()); break;
          case 'install':
            reply({ type: 'toast', text: `Installing ${msg.source}` });
            reply({ type: 'toast', text: (await tools.install_extension.run({ source: msg.source })).text.split('\n')[0] });
            reply(await status());
            break;
          case 'uninstall': await tools.uninstall_extension.run({ id: msg.id }); reply(await status()); break;
          case 'open_extension': await tools.open_extension.run({ extension: msg.id, mode: 'tab' }); break;
          case 'approval_answer': pending.get(msg.id)?.resolve(!!msg.ok); break;
          case 'approval_get': {
            const p = pending.get(msg.id);
            reply(p ? { type: 'approval', id: msg.id, extension: p.extension, action: p.action, url: p.url, screenshot: p.screenshot } : { type: 'approval_done', id: msg.id, ok: null });
            break;
          }
          case 'status': reply(await status()); break;
          case 'check_update': checkUpdate(); break;
          case 'install_update': installUpdate(); break;
        }
      } catch (e) {
        reply({ type: 'error', text: e.message });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  log(`Marlin daemon on http://127.0.0.1:${config.port} (CDP ${config.cdpPort})`);

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    agent.stop();
    await mb.stop();
    server.close();
    const st = readJson(paths.state, {});
    writeJson(paths.state, { ...st, pid: null }, true);
    process.exit(0);
  }
  mb.on('exit', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { mb, tools, server, shutdown };
}

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function hostOk(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

function notify(title, body) {
  const esc = (s) => String(s).replace(/["\\]/g, '');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "Marlin" subtitle "${esc(title)}"`], () => {});
}

function log(...a) { console.log(new Date().toISOString(), ...a); }
