// Secrets live in the macOS login Keychain (service "Marlin"). Agents can ask
// Marlin to type a secret into a field, but no tool ever returns its value,
// and every tool output is scrubbed for known secret values as a backstop.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, readJson, writeJson } from './paths.js';

const run = promisify(execFile);
const SERVICE = 'Marlin';
const cache = new Map();

const validName = (name) => /^[\w.\-]{1,64}$/.test(name);

export function listSecrets() {
  return readJson(paths.secrets, { names: [] }).names;
}

export async function setSecret(name, value) {
  if (!validName(name)) throw new Error('Secret names use letters, digits, dot, dash or underscore');
  if (!value) throw new Error('Empty secret');
  await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
  cache.set(name, value);
  const names = new Set(listSecrets());
  names.add(name);
  writeJson(paths.secrets, { names: [...names].sort() }, true);
}

export async function removeSecret(name) {
  await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).catch(() => {});
  cache.delete(name);
  writeJson(paths.secrets, { names: listSecrets().filter((n) => n !== name) }, true);
}

/** Internal only. Never expose through a tool result. */
export async function revealSecret(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    const value = stdout.replace(/\n$/, '');
    cache.set(name, value);
    return value;
  } catch {
    throw new Error(`No secret named "${name}". Known: ${listSecrets().join(', ') || 'none'}. Add one with: marlin secret set ${name}`);
  }
}

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [name, value] of cache) {
    if (value && value.length >= 4) out = out.split(value).join(`[secret:${name}]`);
  }
  return out;
}

/** Load every secret into the redaction cache so outputs are scrubbed even before first use. */
export async function warmSecrets() {
  for (const n of listSecrets()) await revealSecret(n).catch(() => {});
}
