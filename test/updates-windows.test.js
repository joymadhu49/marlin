import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mock, test } from 'node:test';

mock.module('../src/paths.js', { namedExports: { ROOT: '/unused-root', paths: { home: '/unused-home' } } });
const { canUpdateWindows, runWindowsUpdater } = await import('../src/updates-windows.js');
const current = '0.3.0-windows.1', newer = '0.3.0-windows.2';
const payload = Buffer.from('fixture archive contents');
const hash = createHash('sha256').update(payload).digest('hex');
const required = ['node/node.exe', 'marlin.cmd', 'src/cli.js', 'chromium/chrome-win/chrome.exe',
  'extension/manifest.json', 'scripts/update-windows.ps1', 'node_modules/puppeteer-core/package.json'];
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
      const child = new EventEmitter();
      child.pid = 123456;
      child.unref = () => {};
      child.kill = () => { state.killed = true; };
      queueMicrotask(() => child.emit('spawn'));
      // The helper only acknowledges once JS has transferred lock ownership.
      setTimeout(async () => {
        const get = (flag) => args[args.indexOf(flag) + 1];
        if (state.killed) return;
        const lock = JSON.parse(await readFile(get('-LockPath'), 'utf8'));
        assert.equal(lock.pid, child.pid);
        assert.equal(state.shutdown, false);
        state.ready = true;
        await writeFile(get('-ReadyFile'), JSON.stringify({ ready: true, pid: child.pid }));
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

test('already-cancelled update does not download or shut down', async (t) => {
  const f = await fixture(t);
  f.options.signal = AbortSignal.abort(new Error('Cancelled by test'));
  assert.match((await f.run()).message, /Cancelled/);
  assert.equal(f.state.requested.length, 0);
  assert.equal(f.state.shutdown, false);
});

test('readiness timeout kills helper and never shuts down running app', async (t) => {
  const f = await fixture(t);
  f.options.readyTimeoutMs = 10;
  f.options.spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 123456; child.unref = () => {}; child.kill = () => { f.state.killed = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  assert.match((await f.run()).message, /readiness timed out/);
  assert.equal(f.state.killed, true);
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
  assert.equal(f.state.command, 'powershell.exe');
  assert.equal(f.state.spawnOptions.detached, true);
  assert.equal(f.state.spawnOptions.windowsHide, true);
  assert.equal(f.state.spawnOptions.env.MARLIN_HOME, realpathSync(f.dataHome));
  const get = (flag) => f.state.args[f.state.args.indexOf(flag) + 1];
  assert.equal(get('-BrowserPid'), '98765');
  assert.equal(dirname(get('-StagedDir')), realpathSync(f.parent));
  assert.equal(dirname(dirname(get('-File'))), f.state.spawnOptions.cwd);
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

test('cancellation during readiness kills helper without shutting down browser', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 123456; child.unref = () => {}; child.kill = () => { f.state.killed = true; };
    queueMicrotask(() => child.emit('spawn'));
    setTimeout(() => controller.abort(new Error('Cancelled during handoff')), 10);
    return child;
  };
  assert.equal((await f.run()).event, 'error');
  assert.equal(f.state.killed, true);
  assert.equal(f.state.shutdown, false);
  assert.equal(existsSync(f.lockPath), false);
});

test('early helper exit fails without requesting application shutdown', async (t) => {
  const f = await fixture(t);
  f.options.spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 123456; child.unref = () => {}; child.kill = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1); });
    return child;
  };
  assert.match((await f.run()).message, /exited before handoff/);
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
