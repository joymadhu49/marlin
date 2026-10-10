// Windows portable-package updates. Downloads remain in a sibling workspace;
// the external helper performs replacement only after the running app closes.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, paths } from './paths.js';
import { extractZip } from './archive.js';

const REPOSITORY = 'joymadhu49/marlin';
const API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const MAX_ARCHIVE = 3 * 1024 ** 3;
const VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-windows\.(0|[1-9]\d*)$/;
const ASSET_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function versionParts(value) {
  const match = typeof value === 'string' && value.match(VERSION);
  return match ? match.slice(1).map(BigInt) : null;
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function regularFile(file) {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

/** Only the bundled Windows runtime may replace its own portable installation. */
export function canUpdateWindows({ root = ROOT, platform = process.platform, arch = process.arch, executable = process.execPath } = {}) {
  if (platform !== 'win32' || !['x64', 'arm64', 'ia32'].includes(arch)) return false;
  try {
    if (!lstatSync(root).isDirectory() || !regularFile(join(root, 'node', 'node.exe')) || !regularFile(join(root, 'marlin.cmd'))) return false;
    if (realpathSync(executable).toLowerCase() !== realpathSync(join(root, 'node', 'node.exe')).toLowerCase()) return false;
    return !!versionParts(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  } catch { return false; }
}

function safeURL(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) {
    throw new Error('Update URL is not an approved HTTPS endpoint.');
  }
  return url;
}
async function request(url, fetchImpl, signal, { asset = false } = {}) {
  let next = safeURL(url, asset ? ASSET_HOSTS : new Set(['api.github.com']));
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const requestSignal = asset ? signal : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await fetchImpl(next.href, {
      redirect: 'manual', signal: requestSignal,
      headers: { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Marlin-Windows-Updater' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!asset || !location || redirects === 5) throw new Error('Unexpected update download redirect.');
      next = safeURL(new URL(location, next).href, ASSET_HOSTS);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      throw new Error(limited ? 'GitHub update rate limit reached. Try checking again later.' : `Update request failed: HTTP ${response.status}.`);
    }
    return response;
  }
}
async function boundedText(response, limit) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Update metadata exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function latestRelease(current, arch, fetchImpl, signal) {
  let latest;
  for (let page = 1; page <= 10; page++) {
    const response = await request(`${API}?per_page=100&page=${page}`, fetchImpl, signal);
    const releases = JSON.parse(await boundedText(response, 8 * 1024 ** 2));
    if (!Array.isArray(releases)) throw new Error('Invalid GitHub release response.');
    for (const release of releases) {
      if (!release || release.draft || !versionParts(release.tag_name)) continue;
      if (!latest || compareVersions(release.tag_name, latest.tag_name) > 0) latest = release;
    }
    if (releases.length < 100) break;
  }
  if (!latest || compareVersions(latest.tag_name, current) <= 0) return null;
  const version = latest.tag_name.replace(/^v/, '');
  const name = `Marlin-${version}-windows-${arch === 'ia32' ? 'x86' : arch}.zip`;
  const assets = latest.assets;
  if (!Array.isArray(assets)) throw new Error('Windows release assets are missing.');
  const find = (assetName) => {
    const matches = assets.filter((asset) => asset.name === assetName);
    if (matches.length !== 1) throw new Error(`Windows update requires exactly one ${assetName} asset.`);
    const asset = matches[0];
    const url = safeURL(asset.browser_download_url, new Set(['github.com']));
    const expected = `https://github.com/${REPOSITORY}/releases/download/${latest.tag_name}/${assetName}`;
    if (url.href !== expected) throw new Error('Release asset URL does not match its repository, tag and name.');
    return asset;
  };
  const archive = find(name), checksum = find(`${name}.sha256`);
  if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > MAX_ARCHIVE) throw new Error('Invalid Windows archive size.');
  if (archive.digest != null && !/^sha256:[a-f0-9]{64}$/i.test(archive.digest)) throw new Error('Unsupported release asset digest.');
  return { version, name, archive, checksum, notes: typeof latest.body === 'string' ? latest.body.slice(0, 64_000) : '' };
}
function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function acquireLock(file, token) {
  const recoveryFile = `${file}.recovery`;
  const recoveryError = () => new Error(`Update lock recovery is already active or was interrupted: ${recoveryFile}. Close other updaters before removing it, then retry.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Never bypass a recovery marker left by a crashed reclaimer, even when
    // that process already removed the stale main lock.
    try { lstatSync(recoveryFile); throw recoveryError(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let content;
      try { content = await readFile(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let owner;
      try { owner = JSON.parse(content); } catch { throw new Error(`An update lock is incomplete: ${file}. Close other updaters before removing it.`); }
      if (ownerAlive(owner.pid)) throw new Error('Another Windows update is already running.');
      let recovery;
      try { recovery = await open(recoveryFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw recoveryError(); throw error; }
      try {
        // Serialize the re-read and unlink: a second stale reclaimer must not
        // remove a replacement lock acquired by a new, live updater.
        let latest;
        try { latest = await readFile(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try { owner = JSON.parse(latest); }
        catch { throw new Error(`An update lock is incomplete: ${file}. Close other updaters before removing it.`); }
        if (ownerAlive(owner.pid)) throw new Error('Another Windows update is already running.');
        await rm(file, { force: true });
      } finally {
        await recovery.close();
        await rm(recoveryFile, { force: true });
      }
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
    finally { await handle.close(); }
    return;
  }
  throw new Error('Could not acquire the Windows update lock.');
}
async function releaseLock(file, token) {
  const owner = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (owner?.token === token) await rm(file, { force: true });
}
function validatePackage(stage, version, arch) {
  const required = ['node/node.exe', 'marlin.cmd', 'src/cli.js', 'chromium/chrome-win/chrome.exe',
    'extension/manifest.json', 'scripts/update-windows.ps1', 'scripts/start-windows-updater.ps1', 'node_modules/puppeteer-core/package.json'];
  if (!lstatSync(stage).isDirectory()) throw new Error('Windows update package root is invalid.');
  const root = realpathSync(stage);
  for (const file of ['package.json', ...required]) {
    const target = join(stage, ...file.split('/'));
    if (!regularFile(target) || !inside(root, realpathSync(target))) throw new Error(`Windows update package is missing a regular ${file}.`);
  }
  const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  if (pkg.name !== 'marlin' || pkg.version !== version) throw new Error('Windows update package version or name does not match the release.');
  const packageArch = arch === 'ia32' ? 'x86' : arch;
  if (pkg.marlinWindowsArch != null && pkg.marlinWindowsArch !== packageArch) throw new Error('Windows update package architecture does not match the running installation.');
}
async function download(release, archive, fetchImpl, signal, emit) {
  const text = await boundedText(await request(release.checksum.browser_download_url, fetchImpl, signal, { asset: true }), 4096);
  const match = text.trim().match(/^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i);
  if (!match || match[2] !== release.name) throw new Error('Windows update checksum file is invalid.');
  const expected = match[1].toLowerCase();
  if (release.archive.digest && release.archive.digest.slice(7).toLowerCase() !== expected) throw new Error('GitHub asset digest and checksum file disagree.');
  const response = await request(release.archive.browser_download_url, fetchImpl, signal, { asset: true });
  const hash = createHash('sha256');
  const file = await open(archive, 'wx', 0o600);
  let bytes = 0, percent = -1;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > release.archive.size || bytes > MAX_ARCHIVE) throw new Error('Windows archive exceeds its declared size.');
      hash.update(chunk);
      await file.writeFile(chunk);
      const next = Math.floor(bytes / release.archive.size * 100);
      if (next !== percent) { percent = next; emit({ event: 'progress', percent }); }
    }
  } finally { await file.close(); }
  if (bytes !== release.archive.size || hash.digest('hex') !== expected) throw new Error('Windows update SHA-256 or size verification failed.');
}

/** Dependency options support fixture tests; production endpoints and trust rules are fixed. */
export async function runWindowsUpdater(mode, onEvent = () => {}, options = {}) {
  const { root = ROOT, dataHome = paths.home, platform = process.platform, arch = process.arch, executable = process.execPath,
    fetchImpl = fetch, extract = extractZip, spawnImpl = spawn, shutdown, browserPid,
    readyTimeoutMs = 20_000 } = options;
  const signal = AbortSignal.any([AbortSignal.timeout(mode === 'check' ? 30_000 : 15 * 60_000), ...(options.signal ? [options.signal] : [])]);
  let last, workspace, staged, lock, ownsLock = false, handedOff = false, child;
  const token = randomUUID();
  const emit = (event) => { last = event; onEvent(event); };
  try {
    signal.throwIfAborted();
    if (!['check', 'install'].includes(mode)) throw new Error('Unknown Windows update action.');
    if (!canUpdateWindows({ root, platform, arch, executable })) throw new Error('Automatic Windows updates require a bundled Windows x64, ARM64 or x86 installation.');
    const install = realpathSync(root);
    if (inside(install, resolve(dataHome))) throw new Error('Windows updates require MARLIN_HOME outside the installation directory.');
    await mkdir(dataHome, { recursive: true });
    const home = realpathSync(dataHome);
    if (inside(install, home)) throw new Error('Windows updates require MARLIN_HOME outside the installation directory.');
    if (mode === 'install') {
      const installId = createHash('sha256').update(install.toLowerCase()).digest('hex').slice(0, 16);
      lock = join(dirname(install), `.marlin-update-${installId}.lock`);
      await acquireLock(lock, token);
      ownsLock = true;
    }
    emit({ event: 'checking' });
    const current = JSON.parse(await readFile(join(install, 'package.json'), 'utf8')).version;
    const release = await latestRelease(current, arch, fetchImpl, signal);
    if (!release) { emit({ event: 'none' }); return last; }
    emit({ event: 'available', version: release.version, notes: release.notes, size: release.archive.size });
    if (mode === 'check') return last;
    for (const script of ['update-windows.ps1', 'start-windows-updater.ps1']) {
      if (!regularFile(join(install, 'scripts', script))) throw new Error(`The Windows update helper ${script} is missing.`);
    }
    workspace = await mkdtemp(join(dirname(install), '.marlin-update-'));
    const archive = join(workspace, release.name);
    emit({ event: 'downloading', version: release.version, percent: 0 });
    await download(release, archive, fetchImpl, signal, emit);
    signal.throwIfAborted();
    emit({ event: 'extracting' });
    const extracted = join(workspace, 'extracted');
    await extract(archive, extracted);
    signal.throwIfAborted();
    const packageRoot = join(extracted, `Marlin-win32-${arch === 'ia32' ? 'x86' : arch}`);
    validatePackage(packageRoot, release.version, arch);
    staged = join(dirname(install), `.marlin-stage-${token}`);
    await rename(packageRoot, staged);
    const helper = join(workspace, 'update-windows.ps1');
    await copyFile(join(install, 'scripts', 'update-windows.ps1'), helper);
    const bootstrap = join(workspace, 'start-windows-updater.ps1');
    await copyFile(join(install, 'scripts', 'start-windows-updater.ps1'), bootstrap);
    const ready = join(workspace, 'ready.json');
    const deadline = Date.now() + readyTimeoutMs;
    const args = ['-InstallDir', install, '-StagedDir', staged, '-DaemonPid', String(process.pid),
      '-ReadyFile', ready, '-LogPath', join(home, 'update.log'), '-LockPath', lock,
      '-ReadyDeadlineUtc', new Date(deadline).toISOString()];
    if (Number.isSafeInteger(browserPid) && browserPid > 0) args.push('-BrowserPid', String(browserPid));
    const requestFile = join(workspace, 'launch.json');
    await writeFile(requestFile, JSON.stringify({ helper, arguments: args, workingDirectory: dirname(install) }));
    signal.throwIfAborted();
    emit({ event: 'installing' });
    // A detached PowerShell process can exit before executing any script because
    // libuv removes its console. A short-lived, attached bootstrap uses Windows
    // Start-Process to create an independent helper, and returns that helper PID.
    const powershell = win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bootstrap, '-RequestFile', requestFile], {
      detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(install),
      env: { ...process.env, MARLIN_HOME: home },
      signal: AbortSignal.any([signal, AbortSignal.timeout(readyTimeoutMs)]),
    });
    const helperPid = await new Promise((resolveStarted, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
        if (stdout.length > 16_384) { child.kill(); reject(new Error('Windows updater bootstrap returned excessive output.')); }
      });
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-65_536); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) return reject(new Error(`Windows updater bootstrap failed (${code}): ${stderr.trim()}`));
        try {
          const result = JSON.parse(stdout.trim());
          if (!Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error('missing helper PID');
          resolveStarted(result.pid);
        } catch { reject(new Error('Windows updater bootstrap did not return a valid helper PID.')); }
      });
    });
    child = null; // The bootstrap has exited; the independent helper owns its lifecycle.
    await writeFile(lock, JSON.stringify({ pid: helperPid, token }));
    while (true) {
      signal.throwIfAborted();
      const acknowledgement = await readFile(ready, 'utf8').then(JSON.parse).catch((error) => {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      });
      if (acknowledgement?.ready === true && acknowledgement.pid === helperPid) break;
      if (Date.now() >= deadline) throw new Error(`Windows updater readiness timed out. See ${join(home, 'update.log')}`);
      await delay(50, undefined, { signal });
    }
    handedOff = true;
    emit({ event: 'restarting', version: release.version });
    if (shutdown) await shutdown();
    return last;
  } catch (error) {
    emit({ event: 'error', message: error.message || String(error) });
    return last;
  } finally {
    if (!handedOff) {
      // Removing ownership cancels the helper before it can replace anything.
      if (ownsLock) await releaseLock(lock, token).catch(() => {});
      if (child) { try { child.kill(); } catch {} }
      if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {});
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
