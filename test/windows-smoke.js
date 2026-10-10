// Native Windows smoke test of an already assembled package. No remote sites,
// real wallets, protected secrets, or user profiles are used.
// MARLIN_APP_ROOT=C:\...\dist\Marlin-win32-x64 node test/windows-smoke.js
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.platform !== 'win32') {
  console.log('SKIP: packaged Windows smoke requires native Windows.');
  process.exit(0);
}

assert.ok(process.env.MARLIN_APP_ROOT, 'Set MARLIN_APP_ROOT to the extracted Windows package.');
assert.ok(isAbsolute(process.env.MARLIN_APP_ROOT), 'MARLIN_APP_ROOT must be absolute.');
const appRoot = resolve(process.env.MARLIN_APP_ROOT);
const bundledNode = join(appRoot, 'node', 'node.exe');
const cli = join(appRoot, 'src', 'cli.js');
for (const file of [bundledNode, cli, join(appRoot, 'marlin.cmd'), join(appRoot, 'install.ps1'), join(appRoot, 'chromium', 'chrome-win', 'chrome.exe')]) {
  assert.ok(existsSync(file), `Missing package file: ${file}`);
}
const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;
const home = mkdtempSync(join(tmpdir(), 'marlin windows smoke-'));
const env = { ...process.env, MARLIN_HOME: home };
// Verify the bundled Chromium lookup, even if the developer has an override.
delete env.MARLIN_CHROMIUM;
delete env.OPENROUTER_API_KEY;
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reservations = [];
let fixture, daemon, daemonError, apiPort, cdpPort, token, launcherRoot, mcpClient, mcpTransport;
let daemonLog = '';
let failure;
let checks = 0;

async function step(name, fn) {
  await fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  reservations.push(server);
  return server.address().port;
}

async function releasePorts() {
  for (const server of reservations.splice(0)) await new Promise(resolve => server.close(resolve));
}

async function json(url, options = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json();
  assert.equal(response.status, 200, `${options.method || 'GET'} ${url}: ${JSON.stringify(value)}`);
  return value;
}

const api = (path, options, timeout) => json(`http://127.0.0.1:${apiPort}${path}`, options, timeout);
const tool = (name, args = {}) => api(`/tools/${name}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
}, 60_000);

function waitForExit(child, timeoutMs) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = exited => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function runCli(args) {
  return exec(bundledNode, [cli, ...args], { env, cwd: home, windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
}

async function runLauncher(args) {
  // /s /c requires the outer quote pair around a quoted command path. The
  // arguments here are fixed test values, with no shell metacharacters.
  const command = `""${join(launcherRoot, 'marlin.cmd')}" ${args}"`;
  return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    env, cwd: home, windowsHide: true, windowsVerbatimArguments: true, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
}

async function cleanup() {
  const errors = [];
  const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
  await attempt(async () => { if (mcpClient) await mcpClient.close(); else if (mcpTransport) await mcpTransport.close(); });
  await attempt(async () => {
    if (!daemon?.pid) return;
    // The token and PID must belong to this test before requesting shutdown.
    let state;
    try { state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); } catch {}
    if (state?.pid === daemon.pid && state.token && daemon.exitCode === null && daemon.signalCode === null) {
      try {
        await api('/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }, 3000);
      } catch { /* The bounded process wait below also handles a failed shutdown. */ }
    }
    if (!await waitForExit(daemon, 10_000)) {
      // Never taskkill by image name: this PID is the child we spawned.
      await exec('taskkill.exe', ['/PID', String(daemon.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
      assert.ok(await waitForExit(daemon, 5000), 'Owned daemon did not exit after taskkill.');
    }
  });
  await attempt(releasePorts);
  await attempt(async () => {
    if (!fixture) return;
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  });
  // Remove the junction itself before removing our scratch directory. Never
  // traverse or delete the supplied package directory.
  await attempt(() => { if (launcherRoot) unlinkSync(launcherRoot); });
  await attempt(() => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }));
  if (errors.length) throw new AggregateError(errors, 'Windows smoke cleanup failed');
}

try {
  await step('bundled CLI version and setup configuration', async () => {
    assert.equal((await runCli(['version'])).stdout.trim(), version);
    await runCli(['setup']);
    const generated = JSON.parse(readFileSync(join(home, 'mcp-config.json'), 'utf8')).mcpServers.marlin;
    assert.equal(resolve(generated.command), bundledNode);
    assert.deepEqual(generated.args, [cli, 'mcp']);
  });

  await step('bundled runtime enables the Windows browser updater', async () => {
    const moduleUrl = pathToFileURL(join(appRoot, 'src', 'updates.js')).href;
    const code = `const {canUpdate} = await import(${JSON.stringify(moduleUrl)}); if (!canUpdate()) throw new Error('Packaged Windows updater unavailable');`;
    await exec(bundledNode, ['--input-type=module', '-e', code], { env, cwd: home, windowsHide: true, timeout: 20_000 });
    assert.ok(existsSync(join(appRoot, 'scripts', 'update-windows.ps1')));
  });

  await step('marlin.cmd works from a package path and argument containing spaces', async () => {
    const junction = join(home, 'Packaged Marlin [test]');
    symlinkSync(appRoot, junction, 'junction');
    launcherRoot = junction;
    assert.equal((await runLauncher('version')).stdout.trim(), version);
    await runLauncher('config smokeQuotedPath "fixture directory with spaces"');
    assert.equal((await runCli(['config', 'smokeQuotedPath'])).stdout.trim(), 'fixture directory with spaces');
  });

  await step('in-place installer handles literal bracket paths without changing PATH or shortcuts', async () => {
    const result = await exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(launcherRoot, 'install.ps1'), '-InstallDir', launcherRoot,
      '-NoPath', '-NoShortcut',
    ], { env, cwd: home, windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const diagnostic = `Requested destination: ${launcherRoot}\nInstaller stdout:\n${result.stdout}\nInstaller stderr:\n${result.stderr}`;
    const reported = result.stdout.match(/Installed Marlin to (.+?)\. Open a new terminal/s)?.[1].trim();
    assert.ok(reported, `Installer did not report a destination.\n${diagnostic}`);
    // PowerShell/.NET can expand an 8.3 TEMP path or change its casing. Verify
    // filesystem identity instead of requiring the same printed spelling.
    let actualDestination;
    try { actualDestination = realpathSync.native(reported); }
    catch (cause) { throw new Error(`Installer reported an inaccessible destination: ${reported}\n${diagnostic}`, { cause }); }
    assert.equal(actualDestination.toLowerCase(), realpathSync.native(launcherRoot).toLowerCase(), diagnostic);
    assert.ok(lstatSync(launcherRoot).isSymbolicLink(), `In-place install replaced the package junction.\n${diagnostic}`);
    assert.equal((await runLauncher('version')).stdout.trim(), version);
  });

  await step('packaged MCP server lists tools using the generated configuration', async () => {
    const config = JSON.parse(readFileSync(join(home, 'mcp-config.json'), 'utf8')).mcpServers.marlin;
    mcpTransport = new StdioClientTransport({ command: config.command, args: config.args, env, cwd: home, stderr: 'pipe' });
    mcpTransport.stderr?.on('data', chunk => { daemonLog = (daemonLog + chunk.toString()).slice(-24_000); });
    mcpClient = new Client({ name: 'windows-packaged-smoke', version: '1.0.0' });
    await mcpClient.connect(mcpTransport, { timeout: 15_000 });
    const { tools } = await mcpClient.listTools({}, { timeout: 15_000 });
    for (const name of ['navigate', 'snapshot', 'screenshot', 'install_extension']) assert.ok(tools.some(tool => tool.name === name), `Missing MCP tool ${name}`);
    assert.equal(existsSync(join(home, 'state.json')), false, 'Listing MCP tools must not start a daemon.');
    await mcpClient.close();
    mcpClient = null;
    mcpTransport = null;
  });

  apiPort = await reservePort();
  cdpPort = await reservePort();
  assert.notEqual(apiPort, cdpPort);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: apiPort, cdpPort, headless: true, signPolicy: 'ask' }));
  fixture = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Marlin Windows smoke</title><h1>Local smoke fixture</h1><label>Smoke name <input aria-label="Smoke name"></label><button id="action">Smoke action</button><p id="result">Ready</p><script>document.getElementById("action").onclick=()=>{document.getElementById("result").textContent="Clicked locally";};</script>');
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

  await step('packaged headless daemon starts with isolated API and CDP ports', async () => {
    await releasePorts();
    daemon = spawn(bundledNode, [cli, 'start', '--headless'], { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.on('error', error => { daemonError = error; });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { daemonLog = (daemonLog + chunk.toString()).slice(-24_000); });
    const deadline = Date.now() + 90_000;
    while (true) {
      if (daemonError) throw daemonError;
      assert.equal(daemon.exitCode, null, `Daemon exited during startup: ${daemonLog}`);
      let health;
      try { health = await api('/health', {}, 1000); } catch {}
      if (health) {
        assert.equal(health.name, 'marlin');
        assert.equal(health.pid, daemon.pid, 'Health endpoint belongs to another process.');
        break;
      }
      assert.ok(Date.now() < deadline, `Daemon startup timed out: ${daemonLog}`);
      await pause(200);
    }
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(state.pid, daemon.pid);
    assert.equal(state.port, apiPort);
    assert.equal(state.cdpPort, cdpPort);
    assert.ok(state.token);
    token = state.token;
    const cdp = await json(`http://127.0.0.1:${cdpPort}/json/version`);
    assert.match(cdp.Browser, /Chrome|Chromium/);
    assert.match(cdp.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:/);
  });

  await step('local navigation, snapshot refs and clicks work over the tool API', async () => {
    const navigated = await tool('navigate', { url: fixtureUrl });
    assert.match(navigated.text, /Local smoke fixture/);
    const snapshot = await tool('snapshot');
    const row = snapshot.text.split('\n').find(line => line.includes('Smoke action'));
    const ref = row?.match(/\[(e\d+)\]/)?.[1];
    assert.ok(ref, `No interactive button ref: ${snapshot.text}`);
    const clicked = await tool('click', { ref });
    assert.match(clicked.text, /Clicked locally/);
  });

  await step('screenshot returns a PNG and writes only inside the temporary profile', async () => {
    const shot = await tool('screenshot');
    assert.equal(shot.image?.mimeType, 'image/png');
    const image = Buffer.from(shot.image.data, 'base64');
    assert.ok(image.length > 1000);
    assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(shot.file);
    const path = relative(home, shot.file);
    assert.ok(path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`), 'Screenshot escaped the test profile.');
    assert.deepEqual(readFileSync(shot.file), image);
  });

  await step('local Lockbox extension installs and opens as a tab', async () => {
    const source = join(home, 'Lockbox fixture');
    cpSync(new URL('./fixtures/lockbox', import.meta.url), source, { recursive: true });
    const installed = await tool('install_extension', { source });
    assert.match(installed.text, /Installed Lockbox/);
    const id = installed.text.match(/id=([a-p]{32})/)?.[1];
    assert.ok(id, installed.text);
    assert.match((await tool('extensions')).text, /Lockbox Test Wallet/);
    const opened = await tool('open_extension', { extension: id, mode: 'tab' });
    assert.match(opened.text, /Lockbox Test Wallet/);
    assert.match(opened.text, /Password|Unlock/i);
    assert.match(opened.text, /\[e\d+\]/);
    assert.equal((await api('/health')).pid, daemon.pid);
  });
} catch (error) {
  failure = error;
} finally {
  try { await cleanup(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Smoke test and cleanup failed') : error; }
}

if (failure) {
  console.error(failure);
  if (daemonLog) console.error(`Recent daemon/MCP output:\n${daemonLog}`);
  process.exitCode = 1;
} else {
  console.log(`${checks} packaged Windows checks passed; owned processes stopped and temporary profile removed.`);
}
