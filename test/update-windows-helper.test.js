import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native = (name, run) => test(name, { skip: process.platform !== 'win32', timeout: 90_000 }, run);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const helperSource = new URL('../scripts/update-windows.ps1', import.meta.url);

function executable(target) {
  // A hardlink shares the running test executable's Windows image lock; use
  // independent copies so replacement/deletion models a real installation.
  copyFileSync(process.execPath, target);
}
function packageAt(directory, version, fail = false) {
  for (const path of ['src', 'node', 'chromium/chrome-win', 'extension', 'node_modules']) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'marlin', version }));
  writeFileSync(join(directory, 'marlin.cmd'), '@echo off\r\nexit /b 0\r\n');
  writeFileSync(join(directory, 'extension', 'manifest.json'), '{"manifest_version":3,"name":"fixture","version":"1"}');
  executable(join(directory, 'node', 'node.exe'));
  executable(join(directory, 'chromium', 'chrome-win', 'chrome.exe'));
  writeFileSync(join(directory, 'src', 'cli.js'), `
const fs = require('node:fs');
fs.appendFileSync(process.env.SMOKE_RESTART_LOG, JSON.stringify({ version: ${JSON.stringify(version)}, cwd: process.cwd(), home: process.env.MARLIN_HOME, result: JSON.parse(fs.readFileSync(require('node:path').join(process.env.MARLIN_HOME, 'update-result.json'), 'utf8')) }) + '\\n');
process.exit(${fail ? 7 : 0});
`);
}
function fixture(t, options = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'marlin update [native]-')));
  const f = { root, install: join(root, 'Marlin app [installed]'), stage: join(root, '.marlin-stage-fixture [new]'), workspace: join(root, '.marlin-update-fixture [helper]'), data: join(root, 'external profile [keep]'), children: [] };
  for (const path of [f.workspace, f.data]) mkdirSync(path);
  f.helper = join(f.workspace, 'update-windows.ps1');
  f.ready = join(f.workspace, 'ready.json');
  f.log = join(f.data, 'update.log');
  f.lock = join(root, `.marlin-update-${createHash('sha256').update(f.install.toLowerCase()).digest('hex').slice(0, 16)}.lock`);
  copyFileSync(helperSource, f.helper);
  packageAt(f.install, '0.3.0');
  packageAt(f.stage, '0.3.1', options.failRestart);
  writeFileSync(join(f.data, 'wallet-profile.json'), '{"preserve":"user data"}');
  t.after(async () => {
    for (const child of f.children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await Promise.race([stopped, pause(5000)]);
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  return f;
}
function startHelper(f, extra = [], options = {}) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f.helper,
    '-InstallDir', f.install, '-StagedDir', f.stage, '-ReadyFile', f.ready, '-LogPath', f.log,
    ...(!extra.includes('-WaitTimeoutSeconds') ? ['-WaitTimeoutSeconds', '10'] : []),
    ...(!extra.includes('-RestartTimeoutSeconds') ? ['-RestartTimeoutSeconds', '10'] : []), ...extra,
  ], { env: { ...process.env, MARLIN_HOME: f.data, SMOKE_RESTART_LOG: join(f.data, 'restarts.log'), ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(child);
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  return { child, done, output: () => output };
}
async function ready(f, run) {
  const deadline = Date.now() + 20_000;
  while (!existsSync(f.ready)) {
    assert.equal(run.child.exitCode, null, run.output());
    assert.ok(Date.now() < deadline, `No ready handshake: ${run.output()}`);
    await pause(50);
  }
  const value = JSON.parse(readFileSync(f.ready, 'utf8'));
  assert.equal(value.ready, true);
  assert.equal(value.pid, run.child.pid);
}
async function holdPackageProcess(f, browser = false) {
  const path = browser ? join(f.install, 'chromium', 'chrome-win', 'chrome.exe') : join(f.install, 'node', 'node.exe');
  const child = spawn(path, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(child);
  await once(child.stdout, 'data');
  return child;
}
async function stop(child) { const ended = once(child, 'exit'); child.kill(); await ended; }
const version = directory => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
const result = f => JSON.parse(readFileSync(join(f.data, 'update-result.json'), 'utf8'));
const restarts = f => readFileSync(join(f.data, 'restarts.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

native('detached helper installs/restarts literal paths, preserves profiles and cleans owned backup/workspace', async t => {
  const f = fixture(t);
  writeFileSync(join(f.data, 'update-result.json'), JSON.stringify({ event: 'error', message: 'Previous attempt failed' }));
  const run = startHelper(f, ['-LockPath', f.lock]);
  writeFileSync(f.lock, JSON.stringify({ pid: run.child.pid }));
  const ended = await run.done;
  assert.equal(ended.code, 0, ended.output);
  assert.equal(version(f.install), '0.3.1');
  assert.equal(readFileSync(join(f.data, 'wallet-profile.json'), 'utf8'), '{"preserve":"user data"}');
  const [restarted] = restarts(f);
  assert.equal(restarted.version, '0.3.1');
  assert.equal(restarted.home.toLowerCase(), f.data.toLowerCase());
  assert.equal(restarted.cwd.toLowerCase(), f.install.toLowerCase());
  assert.equal(restarted.result.event, 'none', ended.output);
  assert.equal(result(f).event, 'none', ended.output);
  assert.equal(existsSync(f.lock), false);
  assert.equal(existsSync(f.workspace), false);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.marlin-backup-')), false);
});

native('ready handshake precedes waiting for daemon and browser; replacement waits for both', async t => {
  const f = fixture(t);
  const daemon = await holdPackageProcess(f);
  const browser = await holdPackageProcess(f, true);
  const run = startHelper(f, ['-DaemonPid', String(daemon.pid), '-BrowserPid', String(browser.pid), '-NoRestart']);
  await ready(f, run);
  assert.equal(version(f.install), '0.3.0', run.output());
  assert.equal(daemon.exitCode, null, run.output());
  assert.equal(browser.exitCode, null, run.output());
  await stop(daemon);
  await pause(500);
  assert.equal(version(f.install), '0.3.0');
  assert.equal(run.child.exitCode, null, run.output());
  await stop(browser);
  const ended = await run.done;
  assert.equal(ended.code, 0, ended.output);
  assert.equal(version(f.install), '0.3.1');
});

native('persistent MCP process times out without being killed and the old application reopens', async t => {
  const f = fixture(t);
  const mcp = await holdPackageProcess(f);
  const run = startHelper(f, ['-WaitTimeoutSeconds', '1']);
  await ready(f, run);
  const ended = await run.done;
  assert.equal(ended.code, 1, ended.output);
  assert.equal(mcp.exitCode, null, 'Helper killed the MCP client.');
  assert.equal(version(f.install), '0.3.0');
  assert.match(result(f).message, /Close Marlin and MCP clients/, ended.output);
  assert.equal(restarts(f)[0].version, '0.3.0');
  assert.equal(restarts(f)[0].result.event, 'error');
  assert.equal(existsSync(f.ready), false);
});

native('failed new launcher rolls back and writes error before reopening the old application', async t => {
  const f = fixture(t, { failRestart: true });
  const ended = await startHelper(f).done;
  assert.equal(ended.code, 1, ended.output);
  assert.equal(version(f.install), '0.3.0');
  assert.equal(version(f.stage), '0.3.1');
  assert.match(result(f).message, /exit code 7/, ended.output);
  const launches = restarts(f);
  assert.deepEqual(launches.map(item => item.version), ['0.3.1', '0.3.0']);
  assert.equal(launches[1].result.event, 'error', ended.output);
  assert.equal(readFileSync(join(f.data, 'wallet-profile.json'), 'utf8'), '{"preserve":"user data"}');
  assert.match(readFileSync(f.log, 'utf8'), /Previous package restored/);
});

native('invalid stage and an expired readiness deadline never replace the old package', async t => {
  const f = fixture(t);
  rmSync(join(f.stage, 'extension', 'manifest.json'));
  const invalid = await startHelper(f, ['-NoRestart']).done;
  assert.equal(invalid.code, 1, invalid.output);
  assert.match(result(f).message, /Required package file is missing: extension/, invalid.output);
  assert.equal(version(f.install), '0.3.0');
  assert.equal(existsSync(f.ready), false);
  writeFileSync(join(f.stage, 'extension', 'manifest.json'), '{}');
  const expired = await startHelper(f, ['-NoRestart', '-ReadyDeadlineUtc', '2000-01-01T00:00:00Z']).done;
  assert.equal(expired.code, 1, expired.output);
  assert.match(result(f).message, /readiness deadline expired/, expired.output);
  assert.equal(version(f.install), '0.3.0');
  assert.equal(existsSync(f.ready), false);
});

native('helper rejects unrelated PIDs and data paths inside the installation', async t => {
  const f = fixture(t);
  const unrelated = await startHelper(f, ['-DaemonPid', String(process.pid), '-NoRestart']).done;
  assert.equal(unrelated.code, 1, unrelated.output);
  assert.match(result(f).message, /unrelated process/, unrelated.output);
  assert.equal(version(f.install), '0.3.0');
  const nestedData = join(f.install, 'user profile');
  mkdirSync(nestedData);
  writeFileSync(join(nestedData, 'keep.txt'), 'preserve');
  const nested = await startHelper(f, ['-NoRestart'], { env: { MARLIN_HOME: nestedData } }).done;
  assert.equal(nested.code, 1, nested.output);
  assert.match(nested.output, /outside replaced packages/);
  assert.equal(readFileSync(join(nestedData, 'keep.txt'), 'utf8'), 'preserve');
  assert.equal(version(f.install), '0.3.0');
});

// A restart timeout is not proof that the new app failed: never move its files
// out from under an active process in an attempt to roll back.
native('restart timeout retains the active installation and its rollback backup', async t => {
  const f = fixture(t);
  const pidFile = join(f.data, 'active-launcher.pid');
  writeFileSync(join(f.stage, 'src', 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000);`);
  const run = startHelper(f, ['-RestartTimeoutSeconds', '1']);
  let childPid;
  try {
    const ended = await run.done;
    assert.equal(ended.code, 1, ended.output);
    childPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(childPid > 0);
    process.kill(childPid, 0);
    assert.equal(version(f.install), '0.3.1');
    assert.equal(existsSync(f.stage), false);
    assert.ok(readdirSync(f.root).some(name => name.startsWith('.marlin-backup-')));
    assert.match(readFileSync(f.log, 'utf8'), /left untouched/);
    assert.equal(result(f).event, 'error', ended.output);
  } finally {
    if (!childPid && existsSync(pidFile)) childPid = Number(readFileSync(pidFile, 'utf8'));
    if (childPid) {
      try { process.kill(childPid); } catch {}
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(childPid, 0); } catch { break }
        await pause(100);
      }
    }
  }
});
