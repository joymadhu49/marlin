// One native positive lifecycle: verified JS staging -> helper readiness ->
// updater parent exits -> atomic replacement -> bundled launcher -> cleanup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const beforeVersion = '0.3.0-windows.1', afterVersion = '0.3.0-windows.2';

const runnerSource = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
const [moduleURL, installRoot, dataHome, helperSource] = process.argv.slice(2);
const { runWindowsUpdater, canUpdateWindows } = await import(moduleURL);
const version = '0.3.0-windows.2';
const payload = Buffer.from('verified native updater fixture');
const digest = createHash('sha256').update(payload).digest('hex');
const packageArch = process.arch === 'ia32' ? 'x86' : process.arch;
const name = 'Marlin-' + version + '-windows-' + packageArch + '.zip';
const url = 'https://github.com/joymadhu49/marlin/releases/download/v' + version + '/' + name;
const release = { tag_name: 'v' + version, draft: false, prerelease: true, assets: [
  { name, size: payload.length, digest: 'sha256:' + digest, browser_download_url: url },
  { name: name + '.sha256', browser_download_url: url + '.sha256' },
] };
const launcher = "import {writeFileSync} from 'node:fs'; import {join} from 'node:path';\n" +
  "writeFileSync(join(process.env.MARLIN_HOME,'launched.json'), JSON.stringify({version:'" + version + "',args:process.argv.slice(2),executable:process.execPath}));\n";
assert.equal(canUpdateWindows({ root: installRoot }), true);
const events = [];
const result = await runWindowsUpdater('install', (event) => events.push(event), {
  root: installRoot, dataHome,
  fetchImpl: async (request) => {
    if (request.startsWith('https://api.github.com/')) return Response.json([release]);
    if (request === url + '.sha256') return new Response(digest + '  ' + name + '\n');
    assert.equal(request, url);
    return new Response(payload);
  },
  extract: async (_, destination) => {
    const stage = join(destination, 'Marlin-win32-' + packageArch);
    for (const file of ['node/node.exe', 'marlin.cmd', 'src/cli.js', 'chromium/chrome-win/chrome.exe',
      'extension/manifest.json', 'scripts/update-windows.ps1', 'scripts/start-windows-updater.ps1', 'node_modules/puppeteer-core/package.json']) {
      const target = join(stage, ...file.split('/'));
      await mkdir(dirname(target), { recursive: true });
      if (file === 'node/node.exe') await copyFile(process.execPath, target);
      else if (file === 'scripts/update-windows.ps1') await copyFile(helperSource, target);
      else if (file === 'scripts/start-windows-updater.ps1') await copyFile(join(dirname(helperSource), 'start-windows-updater.ps1'), target);
      else await writeFile(target, file === 'src/cli.js' ? launcher : 'fixture');
    }
    await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'marlin', version, type: 'module' }));
  },
});
await writeFile(join(dataHome, 'handoff.json'), JSON.stringify({ result, events }));
const diagnostics = await Promise.all(['update.log', 'update-result.json'].map(async (file) =>
  file + ': ' + await readFile(join(dataHome, file), 'utf8').catch((error) => error.code)));
assert.equal(result.event, 'restarting', [result.message, ...diagnostics].join('\n'));
// No shutdown callback: a CLI parent must naturally exit for replacement.
`;

test('Windows updater verifies, hands off, replaces and relaunches while preserving profile', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, async (t) => {
  const directory = realpathSync.native(await mkdtemp(join(tmpdir(), 'marlin updater flow ')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const installation = join(directory, 'Installed Marlin');
  const dataHome = join(directory, 'User Data');
  await mkdir(dataHome);
  await writeFile(join(dataHome, 'profile-marker'), 'keep this profile');
  const helper = join(root, 'scripts', 'update-windows.ps1');
  for (const file of ['node/node.exe', 'marlin.cmd', 'src/cli.js', 'chromium/chrome-win/chrome.exe',
    'extension/manifest.json', 'scripts/update-windows.ps1', 'scripts/start-windows-updater.ps1', 'node_modules/puppeteer-core/package.json']) {
    const destination = join(installation, ...file.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    if (file === 'node/node.exe') await copyFile(process.execPath, destination);
    else if (file === 'scripts/update-windows.ps1') await copyFile(helper, destination);
    else if (file === 'scripts/start-windows-updater.ps1') await copyFile(join(dirname(helper), 'start-windows-updater.ps1'), destination);
    else await writeFile(destination, file === 'src/cli.js' ? 'process.exitCode = 0;' : 'fixture');
  }
  await writeFile(join(installation, 'package.json'), JSON.stringify({ name: 'marlin', version: beforeVersion, type: 'module' }));
  const runner = join(directory, 'run-update.mjs');
  await writeFile(runner, runnerSource);
  try {
    await run(join(installation, 'node', 'node.exe'), [runner,
      new URL('../src/updates-windows.js', import.meta.url).href, installation, dataHome, helper], {
      cwd: directory, env: { ...process.env, MARLIN_HOME: dataHome }, windowsHide: true,
      timeout: 60_000,
    });
  } catch (error) {
    const diagnostics = await Promise.all(['update.log', 'update-result.json', 'handoff.json'].map(async (file) =>
      `${file}: ${await readFile(join(dataHome, file), 'utf8').catch((failure) => failure.code)}`));
    throw new Error(`${error.message}\n${diagnostics.join('\n')}`, { cause: error });
  }
  const handoff = JSON.parse(await readFile(join(dataHome, 'handoff.json'), 'utf8'));
  assert.equal(handoff.result.event, 'restarting');
  assert.ok(handoff.events.some((event) => event.event === 'progress' && event.percent === 100));
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith('.marlin-'));
    if (existsSync(join(dataHome, 'launched.json')) && leftovers.length === 0) break;
    await delay(200);
  }
  const log = await readFile(join(dataHome, 'update.log'), 'utf8').catch(() => '(no update log)');
  assert.equal(existsSync(join(dataHome, 'launched.json')), true, log);
  const launched = JSON.parse(await readFile(join(dataHome, 'launched.json'), 'utf8'));
  assert.equal(launched.version, afterVersion);
  assert.deepEqual(launched.args, ['open']);
  assert.equal(launched.executable.toLowerCase(), join(installation, 'node', 'node.exe').toLowerCase());
  assert.equal(JSON.parse(await readFile(join(installation, 'package.json'), 'utf8')).version, afterVersion);
  assert.equal(await readFile(join(dataHome, 'profile-marker'), 'utf8'), 'keep this profile');
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('.marlin-')), [], log);
  assert.equal(JSON.parse(await readFile(join(dataHome, 'update-result.json'), 'utf8')).event, 'none');
});
