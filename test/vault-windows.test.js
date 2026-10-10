import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = `
  const vault = await import('./src/vault.js');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const [operation, name] = process.argv.slice(1);
  if (operation === 'set') await vault.setSecret(name, JSON.parse(input));
  if (operation === 'get') process.stdout.write(JSON.stringify(await vault.revealSecret(name)));
  if (operation === 'remove') await vault.removeSecret(name);
  if (operation === 'list') process.stdout.write(JSON.stringify(vault.listSecrets()));
  if (operation === 'redact') {
    await vault.warmSecrets();
    process.stdout.write(JSON.stringify(vault.redact(JSON.parse(input))));
  }
`;
function command(home, operation, name = 'wallet', value) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', script, operation, name], {
      cwd: root, env: { ...process.env, MARLIN_HOME: home }, timeout: 30000, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      try { resolve(stdout ? JSON.parse(stdout) : undefined); }
      catch (parseError) { reject(parseError); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(value === undefined ? '' : JSON.stringify(value));
  });
}

test('vault subprocess failures preserve stderr for native failure assertions', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'marlin-vault-error-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Invalid names fail before reaching Keychain or DPAPI on every platform.
  await assert.rejects(command(home, 'get', 'invalid/name'), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Secret names use/);
    return true;
  });
});

test('native Windows DPAPI persists Unicode/newlines, decrypts after restart and redacts', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'marlin-native-vault-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const value = 'pāssword 🔑\nsecond line\r\ntrailing newline\n';
  await command(home, 'set', 'wallet', value);
  assert.deepEqual(await command(home, 'list'), ['wallet']);
  const [file] = await readdir(join(home, 'vault'));
  const encrypted = await readFile(join(home, 'vault', file));
  assert.ok(!encrypted.includes(Buffer.from(value)));
  assert.ok(!encrypted.includes(Buffer.from(Buffer.from(value).toString('base64'))));
  assert.deepEqual(JSON.parse(await readFile(join(home, 'secrets.json'), 'utf8')), { names: ['wallet'] });
  // Each invocation is a new Node process with an empty in-memory secret cache.
  assert.equal(await command(home, 'get'), value);
  assert.equal(await command(home, 'redact', 'wallet', `before ${value} after`), 'before [secret:wallet] after');
  const replacement = 'replacement 🔐\n';
  await command(home, 'set', 'wallet', replacement);
  assert.equal(await command(home, 'get'), replacement);
  await command(home, 'remove');
  assert.deepEqual(await command(home, 'list'), []);
  assert.deepEqual(await readdir(join(home, 'vault')), []);
});

test('native Windows DPAPI reports damaged ciphertext without exposing a password', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'marlin-native-vault-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const value = 'native-corruption-test-password';
  await command(home, 'set', 'wallet', value);
  const [file] = await readdir(join(home, 'vault'));
  await writeFile(join(home, 'vault', file), Buffer.from('damaged ciphertext'));
  await assert.rejects(command(home, 'get'), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /damaged or protected by a different Windows account/);
    assert.ok(!error.stderr.includes(value));
    return true;
  });
});
