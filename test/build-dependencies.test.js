import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const common = fileURLToPath(new URL('../scripts/build-common.sh', import.meta.url));
const shellTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'macOS Bash build scripts' : false }, fn);
function fixture(t, scripts) {
  const dir = mkdtempSync(join(tmpdir(), 'marlin-build-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return command => spawnSync('/bin/bash', ['-c', 'source "$1"; eval "$2"', 'test', common, command], { env: { ...process.env, PATH: dir }, encoding: 'utf8' });
}
const printArgs = 'printf "%s\\n" "$0" "$@"';
const tools = Object.fromEntries(['node', 'rsvg-convert', 'iconutil', 'rsync', 'swiftc', 'xcrun', 'codesign', 'ditto', 'xattr', 'curl', 'tar'].map(tool => [tool, 'exit 0']));

shellTest('npm-only machines can install development and bundled production dependencies', t => {
  const run = fixture(t, { npm: printArgs });
  const dev = run('install_dependencies development');
  assert.equal(dev.status, 0, dev.stderr);
  assert.match(dev.stdout, /npm\ninstall\n--silent/);
  assert.doesNotMatch(dev.stdout, /--omit=dev/);
  const prod = run('install_dependencies production');
  assert.equal(prod.status, 0, prod.stderr);
  assert.match(prod.stdout, /--omit=dev/);
  assert.match(prod.stdout, /--package-lock=false/);
});

shellTest('pnpm is preferred and bundles with frozen, hoisted production dependencies', t => {
  const run = fixture(t, { npm: 'exit 99', pnpm: printArgs });
  const result = run('install_dependencies production');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm\ninstall/);
  assert.match(result.stdout, /--prod/);
  assert.match(result.stdout, /--frozen-lockfile/);
  assert.match(result.stdout, /--config.node-linker=hoisted/);
});

shellTest('missing package managers fail with an actionable message', t => {
  const result = fixture(t, {})('install_dependencies production');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install pnpm or npm/);
});

shellTest('preflight permits npm-only builds and rejects missing tools before building', t => {
  const available = { ...tools, uname: 'echo Darwin', npm: 'exit 0' };
  const good = fixture(t, available)('require_build_tools');
  assert.equal(good.status, 0, good.stderr);
  delete available['rsvg-convert'];
  const missing = fixture(t, available)('require_build_tools');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing build tool: rsvg-convert/);
});

shellTest('preflight rejects unsupported hosts, Node versions and broken toolchains', t => {
  const available = { ...tools, uname: 'echo Darwin', npm: 'exit 0' };
  for (const [override, message] of [
    [{ uname: 'echo Linux' }, /requires macOS/],
    [{ node: 'exit 1' }, /Node 22.12/],
    [{ xcrun: 'exit 1' }, /Swift toolchain is unavailable/],
  ]) {
    const result = fixture(t, { ...available, ...override })('require_build_tools');
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

shellTest('real installer and app builder stop at preflight before touching build output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'marlin-build-entry-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['scripts', 'app', 'dist', 'bin']) mkdirSync(join(dir, folder));
  for (const relative of ['install.sh', 'app/build-app.sh', 'scripts/build-common.sh']) {
    copyFileSync(new URL(`../${relative}`, import.meta.url), join(dir, relative));
  }
  writeFileSync(join(dir, 'dist', 'keep.txt'), 'existing build');
  for (const [name, body] of Object.entries({
    dirname: 'printf "%s\\n" "${1%/*}"', uname: 'echo Darwin', node: 'exit 0', npm: 'echo DEPENDENCY_INSTALL_STARTED',
  })) {
    const path = join(dir, 'bin', name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  for (const entry of ['install.sh', 'app/build-app.sh']) {
    const result = spawnSync('/bin/bash', [join(dir, entry)], { env: { ...process.env, PATH: join(dir, 'bin') }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing build tool: rsvg-convert/);
    assert.doesNotMatch(result.stdout, /DEPENDENCY_INSTALL_STARTED/);
    assert.equal(readFileSync(join(dir, 'dist', 'keep.txt'), 'utf8'), 'existing build');
  }
});
