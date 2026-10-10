import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('macOS signing preserves downloader entitlements before signing its containing bundle', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'marlin signing [test] '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'Marlin.app');
  const downloader = join(app, 'Contents/Helpers/Marlin Updater.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc');
  const downloaderExe = join(downloader, 'Contents/MacOS/Downloader');
  const node = join(app, 'Contents/Resources/node/bin/node');
  const chromium = join(app, 'Contents/MacOS/Chromium');
  for (const file of [downloaderExe, node, chromium]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'fixture', { mode: 0o755 });
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'codesign.log');
  writeFileSync(join(bin, 'file'), '#!/bin/sh\necho Mach-O\n', { mode: 0o755 });
  writeFileSync(join(bin, 'codesign'), '#!/bin/sh\nprintf "%s\\t" "$@" >> "$SIGNING_LOG"\nprintf "\\n" >> "$SIGNING_LOG"\n', { mode: 0o755 });
  const result = spawnSync('/bin/bash', [fileURLToPath(new URL('../scripts/sign.sh', import.meta.url)), app], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MARLIN_SIGN_ID: 'Fixture Identity', SIGNING_LOG: log },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => line.trim().split('\t'));
  const exeCall = calls.findIndex(args => args.at(-1) === downloaderExe);
  const bundleCall = calls.findIndex(args => args.at(-1) === downloader);
  assert.ok(exeCall >= 0 && bundleCall > exeCall, 'Executable must be signed before containing XPC bundle');
  assert.ok(calls[exeCall].includes('--preserve-metadata=entitlements'));
  assert.ok(calls[bundleCall].includes('--preserve-metadata=entitlements'));
  for (const [file, entitlement] of [[node, 'jit.plist'], [chromium, 'browser.plist']]) {
    assert.ok(calls.find(args => args.at(-1) === file).some(arg => arg.endsWith(`/entitlements/${entitlement}`)));
  }
  assert.ok(calls.some(args => args.includes('--verify') && args.includes('--deep') && args.includes('--strict')));
});
