import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mock, test } from 'node:test';

mock.module('../src/paths.js', { namedExports: { ROOT: '/unused-root', paths: { home: '/unused-home' } } });
let beforeRemove;
mock.module('node:fs/promises', { namedExports: {
  ...realFs,
  rm: async (...args) => { await beforeRemove?.(...args); return realFs.rm(...args); },
} });
const { canUpdateWindows, runWindowsUpdater } = await import('../src/updates-windows.js');
const current = '0.3.0-windows.1', newer = '0.3.0-windows.2';
const payload = Buffer.from('fixture archive contents');
const hash = createHash('sha256').update(payload).digest('hex');
const required = ['node/node.exe', 'marlin.cmd', 'src/cli.js', 'chromium/chrome-win/chrome.exe',
  'extension/manifest.json', 'scripts/update-windows.ps1', 'scripts/start-windows-updater.ps1', 'node_modules/puppeteer-core/package.json'];
function bootstrapChild(state, { code = 0, output = '{"pid":123456}' } = {}) {
  const child = new EventEmitter();
  child.pid = 654321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { state.killed = true; };
  queueMicrotask(() => {
    child.emit('spawn');
    child.stdout.emit('data', output);
    child.emit('close', code);
  });
  return child;
}
async function packageAt(root, version) {
  for (const file of required) {
    const path = join(root, ...file.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'marlin', version }));
}
function release(version = newer) {
  const name = `Marlin-${version}-windows-x64.zip`;
  const url = `https://github.com/joymadhu49/marlin/releases/download/v${version}/${name}`;
  return { tag_name: `v${version}`, draft: false, prerelease: true, assets: [
    { name, browser_download_url: url, size: payload.length, digest: `sha256:${hash}` },
    { name: `${name}.sha256`, browser_download_url: `${url}.sha256`, size: 150 },
  ] };
}
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'marlin updater '));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'Marlin'), dataHome = join(parent, 'profile');
  await packageAt(root, current);
  await mkdir(dataHome);
  const state = { events: [], requested: [], extracted: false, spawned: false, ready: false, killed: false, shutdown: false };
  const info = release();
  const options = {
    root, dataHome, executable: join(root, 'node', 'node.exe'), platform: 'win32', arch: 'x64',
    fetchImpl: async (url) => {
      state.requested.push(url);
      if (url.startsWith('https://api.github.com/')) return Response.json([info]);
      if (url.endsWith('.sha256')) return new Response(`${hash}  ${info.assets[0].name}\r\n`);
      return new Response(payload);
    },
    extract: async (archive, destination) => {
      state.extracted = true;
      assert.deepEqual(await readFile(archive), payload);
      await packageAt(join(destination, 'Marlin-win32-x64'), newer);
    },
    spawnImpl: (command, args, spawnOptions) => {
      state.spawned = true;
      state.command = command; state.args = args; state.spawnOptions = spawnOptions;
      const child = bootstrapChild(state);
      // The helper only acknowledges once JS has transferred lock ownership.
      setTimeout(async () => {
        const request = JSON.parse(await readFile(args[args.indexOf('-RequestFile') + 1], 'utf8'));
        state.request = request;
        const get = (flag) => request.arguments[request.arguments.indexOf(flag) + 1];
        if (state.killed) return;
        const lock = JSON.parse(await readFile(get('-LockPath'), 'utf8'));
        assert.equal(lock.pid, 123456);
        assert.equal(state.shutdown, false);
        state.ready = true;
        await writeFile(get('-ReadyFile'), JSON.stringify({ ready: true, pid: state.ackPid ?? 123456 }));
      }, 20);
      return child;
    },
    shutdown: async () => { assert.equal(state.ready, true); state.shutdown = true; },
  };
  const run = (mode = 'install') => runWindowsUpdater(mode, (event) => state.events.push(event), options);
  const installId = createHash('sha256').update(realpathSync(root).toLowerCase()).digest('hex').slice(0, 16);
  const lockPath = join(dirname(realpathSync(root)), `.marlin-update-${installId}.lock`);
  return { parent, root, dataHome, lockPath, state, info, options, run };
}

test('only a Windows bundle running its bundled executable is eligible', async (t) => {
  const f = await fixture(t);
  assert.equal(canUpdateWindows(f.options), true);
  assert.equal(canUpdateWindows({ ...f.options, platform: 'darwin' }), false);
  assert.equal(canUpdateWindows({ ...f.options, arch: 'arm64' }), false);
  assert.equal(canUpdateWindows({ ...f.options, executable: process.execPath }), false);
  await rm(join(f.root, 'marlin.cmd'));
  assert.equal(canUpdateWindows(f.options), false);
  assert.match((await f.run()).message, /bundled/);
  assert.equal(f.state.requested.length, 0);
});

test('checks select highest numeric Windows version across release pages without downloading', async (t) => {
  const f = await fixture(t);
  f.options.fetchImpl = async (url) => {
    f.state.requested.push(url);
    if (url.endsWith('page=1')) return Response.json(Array.from({ length: 100 }, () => ({ tag_name: 'v9.0.0', draft: false })));
    return Response.json([release('0.3.0-windows.9'), release('0.3.0-windows.10'), { ...release('99.0.0-windows.1'), draft: true }]);
  };
  assert.deepEqual(await f.run('check'), { event: 'available', version: '0.3.0-windows.10', notes: '', size: payload.length });
  assert.equal(f.state.requested.length, 2);
  assert.equal(f.state.spawned, false);
  assert.equal(existsSync(f.lockPath), false);
});

test('equal or older Windows releases do not install', async (t) => {
  const f = await fixture(t);
  f.options.fetchImpl = async () => Response.json([release(current), release('0.2.0-windows.9')]);
  assert.deepEqual(await f.run(), { event: 'none' });
  assert.equal(f.state.spawned, false);
  assert.equal(existsSync(f.lockPath), false);
});

for (const url of ['http://github.com/joymadhu49/marlin/releases/download/x/file.zip',
  'https://example.com/file.zip', 'https://github.com/other/project/releases/download/x/file.zip',
  'https://user:secret@github.com/file.zip']) {
  test(`rejects untrusted release asset: ${url}`, async (t) => {
    const f = await fixture(t);
    f.info.assets[0].browser_download_url = url;
    assert.equal((await f.run()).event, 'error');
    assert.equal(f.state.extracted, false);
    assert.equal(f.state.requested.length, 1);
  });
}

test('asset redirect cannot downgrade HTTPS or leave approved GitHub hosts', async (t) => {
  const f = await fixture(t);
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => url.endsWith('.sha256')
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example/checksum' } }) : original(url, options);
  assert.match((await f.run()).message, /approved HTTPS/);
  assert.equal(f.state.extracted, false);
});

test('conflicting GitHub digest prevents archive download', async (t) => {
  const f = await fixture(t);
  f.info.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.match((await f.run()).message, /disagree/);
  assert.equal(f.state.requested.length, 2);
  assert.equal(f.state.extracted, false);
});

test('checksum sidecar must identify this exact archive', async (t) => {
  const f = await fixture(t);
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => url.endsWith('.sha256')
    ? new Response(`${hash}  another.zip`) : original(url, options);
  assert.match((await f.run()).message, /checksum file is invalid/);
  assert.equal(f.state.extracted, false);
});

test('changed archive bytes fail SHA256 before extraction and remove staging/lock', async (t) => {
  const f = await fixture(t);
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => url.endsWith('.zip')
    ? new Response(Buffer.alloc(payload.length)) : original(url, options);
  assert.match((await f.run()).message, /SHA-256/);
  assert.equal(f.state.extracted, false);
  assert.equal(existsSync(f.lockPath), false);
  assert.deepEqual((await readdir(f.parent)).sort(), ['Marlin', 'profile']);
});

test('truncated archive fails declared-size verification', async (t) => {
  const f = await fixture(t);
  f.info.assets[0].size++;
  assert.match((await f.run()).message, /size verification/);
  assert.equal(f.state.extracted, false);
});

test('extracted package version must match the selected release', async (t) => {
  const f = await fixture(t);
  f.options.extract = async (_, destination) => packageAt(join(destination, 'Marlin-win32-x64'), current);
  assert.match((await f.run()).message, /version or name/);
  assert.equal(f.state.spawned, false);
});

test('missing bundled files reject before launching updater', async (t) => {
  const f = await fixture(t);
  const original = f.options.extract;
  f.options.extract = async (...args) => {
    await original(...args);
    await rm(join(args[1], 'Marlin-win32-x64', 'src', 'cli.js'));
  };
  assert.match((await f.run()).message, /src\/cli.js/);
  assert.equal(f.state.spawned, false);
});

test('profile inside installation is rejected before fetching', async (t) => {
  const f = await fixture(t);
  f.options.dataHome = join(f.root, 'profile');
  assert.match((await f.run()).message, /outside the installation/);
  assert.equal(f.state.requested.length, 0);
});

test('live update lock excludes concurrent updaters', async (t) => {
  const f = await fixture(t);
  const owner = JSON.stringify({ pid: process.pid, token: 'other' });
  await writeFile(f.lockPath, owner);
  assert.match((await f.run()).message, /already running/);
  assert.equal(await readFile(f.lockPath, 'utf8'), owner);
  assert.equal(f.state.requested.length, 0);
});

test('concurrent stale-lock recovery admits only one updater while its fetch is held', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.lockPath, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  let releaseFetch, firstFetch, secondDelete, duplicateFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const entered = new Promise((resolve) => { firstFetch = resolve; });
  const deleting = new Promise((resolve) => { secondDelete = resolve; });
  const duplicate = new Promise((resolve) => { duplicateFetch = resolve; });
  let requests = 0, deletions = 0;
  f.options.fetchImpl = async () => {
    requests++;
    firstFetch();
    if (requests > 1) duplicateFetch();
    await gate;
    return Response.json([]);
  };
  beforeRemove = async (file) => {
    if (file !== f.lockPath) return;
    if (++deletions === 1) {
      // Let an unprotected second reclaimer finish its stale ownership check.
      await Promise.race([deleting, new Promise((resolve) => setTimeout(resolve, 100))]);
    } else if (deletions === 2) {
      secondDelete();
      // Delay its unlink until the first updater owns a new live lock.
      await entered;
    }
  };
  const runs = [f.run(), f.run()];
  try {
    await entered;
    await Promise.race([...runs, duplicate]);
    assert.equal(requests, 1, 'a second updater entered the protected release check');
    assert.equal(JSON.parse(await readFile(f.lockPath, 'utf8')).pid, process.pid);
  } finally {
    beforeRemove = undefined;
    releaseFetch();
    await Promise.all(runs);
  }
  assert.equal(existsSync(f.lockPath), false);
  assert.equal(existsSync(`${f.lockPath}.recovery`), false);
});

test('an abandoned recovery mutex fails closed with removal instructions', async (t) => {
  const f = await fixture(t);
  const recovery = `${f.lockPath}.recovery`;
  await writeFile(recovery, 'interrupted recovery');
  assert.match((await f.run()).message, /recovery.*Close other updaters.*removing/i);
  assert.equal(await readFile(recovery, 'utf8'), 'interrupted recovery');
  assert.equal(existsSync(f.lockPath), false);
  assert.equal(f.state.requested.length, 0);
  const owner = JSON.stringify({ pid: process.pid, token: 'existing' });
  await writeFile(f.lockPath, owner);
  assert.match((await f.run()).message, /recovery/i);
  assert.equal(await readFile(f.lockPath, 'utf8'), owner);
  assert.equal(await readFile(recovery, 'utf8'), 'interrupted recovery');
});

test('already-cancelled update does not download or shut down', async (t) => {
  const f = await fixture(t);
  f.options.signal = AbortSignal.abort(new Error('Cancelled by test'));
  assert.match((await f.run()).message, /Cancelled/);
  assert.equal(f.state.requested.length, 0);
  assert.equal(f.state.shutdown, false);
});

test('readiness timeout revokes helper ownership and never shuts down running app', async (t) => {
  const f = await fixture(t);
  f.options.readyTimeoutMs = 10;
  f.options.spawnImpl = () => bootstrapChild(f.state);
  assert.match((await f.run()).message, /readiness timed out/);
  assert.equal(f.state.killed, false);
  assert.equal(f.state.shutdown, false);
  assert.equal(existsSync(f.lockPath), false);
  assert.deepEqual((await readdir(f.parent)).sort(), ['Marlin', 'profile']);
});

test('verified package hands off only after matching helper readiness acknowledgement', async (t) => {
  const f = await fixture(t);
  f.options.browserPid = 98765;
  assert.deepEqual(await f.run(), { event: 'restarting', version: newer });
  assert.equal(f.state.shutdown, true);
  assert.equal(f.state.killed, false);
  assert.match(f.state.command, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(f.state.spawnOptions.detached, false);
  assert.equal(f.state.spawnOptions.windowsHide, true);
  assert.equal(f.state.spawnOptions.env.MARLIN_HOME, realpathSync(f.dataHome));
  const get = (flag) => f.state.request.arguments[f.state.request.arguments.indexOf(flag) + 1];
  assert.equal(get('-BrowserPid'), '98765');
  assert.equal(dirname(get('-StagedDir')), realpathSync(f.parent));
  assert.equal(dirname(dirname(f.state.request.helper)), f.state.spawnOptions.cwd);
  assert.equal(f.state.spawnOptions.cwd, realpathSync(f.parent));
  assert.equal(JSON.parse(await readFile(get('-LockPath'), 'utf8')).pid, 123456);
  assert.ok(f.state.events.find((e) => e.event === 'progress' && e.percent === 100));
  assert.deepEqual(f.state.events.slice(-2).map((e) => e.event), ['installing', 'restarting']);
});

test('GitHub rate-limit response has actionable feedback', async (t) => {
  const f = await fixture(t);
  f.options.fetchImpl = async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  assert.match((await f.run('check')).message, /rate limit.*later/);
});

test('dead updater lock is recovered and removed when no update exists', async (t) => {
  const f = await fixture(t);
  await writeFile(f.lockPath, JSON.stringify({ pid: 2147483647, token: 'stale' }));
  f.options.fetchImpl = async () => Response.json([]);
  assert.deepEqual(await f.run(), { event: 'none' });
  assert.equal(existsSync(f.lockPath), false);
});

test('cancellation during readiness revokes helper ownership without shutting down browser', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.spawnImpl = () => {
    const child = bootstrapChild(f.state);
    setTimeout(() => controller.abort(new Error('Cancelled during handoff')), 10);
    return child;
  };
  assert.equal((await f.run()).event, 'error');
  assert.equal(f.state.killed, false);
  assert.equal(f.state.shutdown, false);
  assert.equal(existsSync(f.lockPath), false);
});

test('bootstrap failure prevents handoff and application shutdown', async (t) => {
  const f = await fixture(t);
  f.options.spawnImpl = () => bootstrapChild(f.state, { code: 1 });
  assert.match((await f.run()).message, /bootstrap failed/);
  assert.equal(f.state.shutdown, false);
});

test('installation lock prevents a second updater even with a different profile home', async (t) => {
  const f = await fixture(t);
  const owner = JSON.stringify({ pid: process.pid, token: 'other' });
  await writeFile(f.lockPath, owner);
  f.options.dataHome = join(f.parent, 'another-profile');
  assert.match((await f.run()).message, /already running/);
  assert.equal(await readFile(f.lockPath, 'utf8'), owner);
  assert.equal(f.state.requested.length, 0);
});

test('invalid bootstrap PID output fails closed before shutdown', async (t) => {
  const f = await fixture(t);
  f.options.spawnImpl = () => bootstrapChild(f.state, { output: '{"pid":0}' });
  assert.match((await f.run()).message, /valid helper PID/);
  assert.equal(f.state.shutdown, false);
  assert.equal(existsSync(f.lockPath), false);
});

test('bootstrap PID cannot substitute for the independent helper readiness PID', async (t) => {
  const f = await fixture(t);
  f.options.readyTimeoutMs = 80;
  f.state.ackPid = 654321;
  assert.match((await f.run()).message, /readiness timed out/);
  assert.equal(f.state.shutdown, false);
  assert.equal(existsSync(f.lockPath), false);
});
