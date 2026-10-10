import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBackend } from '../src/vault-backend.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'marlin-vault-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('macOS retains the Marlin Keychain service and account commands', async (t) => {
  const calls = [];
  const vault = createSecretBackend({ platform: 'darwin', home: await fixture(t), run: async (...args) => {
    calls.push(args);
    return { stdout: 'test password\n' };
  } });
  await vault.set('wallet', 'test password');
  assert.equal(await vault.get('wallet'), 'test password');
  await vault.remove('wallet');
  assert.deepEqual(calls.map(([file, args]) => [file, args]), [
    ['security', ['add-generic-password', '-U', '-s', 'Marlin', '-a', 'wallet', '-w', 'test password']],
    ['security', ['find-generic-password', '-s', 'Marlin', '-a', 'wallet', '-w']],
    ['security', ['delete-generic-password', '-s', 'Marlin', '-a', 'wallet']],
  ]);
});

test('Windows sends bytes through stdin and persists only protected data', async (t) => {
  const home = await fixture(t);
  const value = 'pāssword 🔑\nsecond line\r\n';
  const encrypted = Buffer.from('mock protected bytes');
  const calls = [];
  const run = async (file, args, input) => {
    calls.push({ file, args, input });
    const request = JSON.parse(input);
    assert.equal(file, 'powershell.exe');
    assert.ok(!args.some((arg) => arg.includes(value) || arg.includes(Buffer.from(value).toString('base64'))));
    assert.equal(Buffer.from(request.entropy, 'base64').toString(), 'Marlin vault v1\0wallet');
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /DataProtectionScope\]::CurrentUser/);
    assert.doesNotMatch(script, /LocalMachine/);
    if (request.operation === 'protect') {
      assert.equal(Buffer.from(request.data, 'base64').toString(), value);
      return { stdout: encrypted.toString('base64') };
    }
    assert.deepEqual(Buffer.from(request.data, 'base64'), encrypted);
    return { stdout: Buffer.from(value).toString('base64') };
  };
  await createSecretBackend({ platform: 'win32', home, run }).set('wallet', value);
  const entries = await readdir(join(home, 'vault'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.dpapi$/);
  assert.deepEqual(await readFile(join(home, 'vault', entries[0])), encrypted);
  const reopened = createSecretBackend({ platform: 'win32', home, run });
  assert.equal(await reopened.get('wallet'), value);
  assert.equal(calls.length, 2);
  await reopened.remove('wallet');
  await reopened.remove('wallet');
  assert.deepEqual(await readdir(join(home, 'vault')), []);
  await assert.rejects(reopened.get('wallet'), { code: 'ENOENT' });
});

test('Windows file names distinguish case and safely handle reserved names', async (t) => {
  const home = await fixture(t);
  const vault = createSecretBackend({ platform: 'win32', home, run: async () => ({ stdout: 'Y2lwaGVydGV4dA==' }) });
  for (const name of ['wallet', 'WALLET', 'CON', '..']) await vault.set(name, 'value');
  assert.equal((await readdir(join(home, 'vault'))).length, 4);
});

test('failed Windows encryption preserves the existing encrypted file', async (t) => {
  const home = await fixture(t);
  let fail = false;
  const vault = createSecretBackend({ platform: 'win32', home, run: async () => {
    if (fail) throw new Error('subprocess error with sensitive output');
    return { stdout: Buffer.from('old ciphertext').toString('base64') };
  } });
  await vault.set('wallet', 'old password');
  const [file] = await readdir(join(home, 'vault'));
  fail = true;
  await assert.rejects(vault.set('wallet', 'new password'), /encryption failed.*not replaced/);
  assert.equal(await readFile(join(home, 'vault', file), 'utf8'), 'old ciphertext');
  assert.deepEqual(await readdir(join(home, 'vault')), [file]);
  await assert.rejects(vault.get('wallet'), /damaged.*different Windows account/);
});

test('missing PowerShell and invalid subprocess output have clear safe errors', async (t) => {
  const home = await fixture(t);
  const missing = createSecretBackend({ platform: 'win32', home, run: async () => {
    throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
  } });
  await assert.rejects(missing.set('wallet', 'password'), /requires powershell.exe/);
  const invalid = createSecretBackend({ platform: 'win32', home, run: async () => ({ stdout: 'not base64!' }) });
  await assert.rejects(invalid.set('wallet', 'password'), /encryption failed/);
  assert.deepEqual(await readdir(home), []);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} validates names for set/get/remove and rejects empty or non-string secrets`, async (t) => {
    let calls = 0;
    const home = await fixture(t);
    const vault = createSecretBackend({ platform, home, run: async () => { calls++; return { stdout: '' }; } });
    for (const name of [undefined, null, 12, {}, [], '', 'a/b', 'a\\b', 'has space', 'a'.repeat(65)]) {
      await assert.rejects(vault.set(name, 'value'), /Secret names/);
      await assert.rejects(vault.get(name), /Secret names/);
      await assert.rejects(vault.remove(name), /Secret names/);
    }
    for (const value of ['', null, undefined, false, 12, {}, [], Buffer.from('bytes')]) {
      await assert.rejects(vault.set('wallet', value), /non-empty string/);
    }
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(home), []);
  });
}

test('unsupported operating systems fail explicitly without executing commands', async (t) => {
  const vault = createSecretBackend({ platform: 'linux', home: await fixture(t), run: () => assert.fail('Unexpected command') });
  assert.throws(vault.assertSupported, /not supported on linux/);
  await assert.rejects(vault.set('wallet', 'password'), /not supported on linux/);
  await assert.rejects(vault.get('wallet'), /not supported on linux/);
  await assert.rejects(vault.remove('wallet'), /not supported on linux/);
});
