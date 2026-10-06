// Talks to a running daemon, starting one in the background if needed.
import { spawn } from 'node:child_process';
import { openSync, closeSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJson, loadConfig, ROOT } from './paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function daemonUp() {
  const { port } = loadConfig();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function ensureDaemon({ headless } = {}) {
  if (await daemonUp()) return;
  // Several agents may make their first call at once: only one may launch.
  const lock = join(paths.home, 'starting.lock');
  let owner = false;
  try {
    closeSync(openSync(lock, 'wx'));
    owner = true;
  } catch {
    if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { force: true }); return ensureDaemon({ headless }); }
  }
  if (!owner) {
    for (let i = 0; i < 120; i++) { await sleep(250); if (await daemonUp()) return; }
    throw new Error(`Marlin did not start. See ${paths.log}`);
  }
  try { await launch(headless); } finally { rmSync(lock, { force: true }); }
}

async function launch(headless) {
  if (await daemonUp()) return;
  const out = openSync(paths.log, 'a');
  const args = [join(ROOT, 'src', 'cli.js'), 'start'];
  if (headless) args.push('--headless');
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await daemonUp()) return;
  }
  throw new Error(`Marlin did not start. See ${paths.log}`);
}

async function call(method, path, body) {
  const { port } = loadConfig();
  const { token } = readJson(paths.state, {});
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

export const listTools = () => call('GET', '/tools');
export const runTool = (name, args) => call('POST', `/tools/${name}`, args || {});
export const shutdownDaemon = () => call('POST', '/shutdown');
