// Secrets live in macOS Keychain or Windows DPAPI-protected files. Agents can ask
// Marlin to type a secret into a field, but no tool ever returns its value,
// and every tool output is scrubbed for known secret values as a backstop.
import { paths, readJson, writeJson } from './paths.js';
import { createSecretBackend, validSecretName, validateSecretName } from './vault-backend.js';

const backend = createSecretBackend({ home: paths.home });
const cache = new Map();

export function listSecrets() {
  backend.assertSupported();
  const names = readJson(paths.secrets, { names: [] })?.names;
  return Array.isArray(names) ? names.filter(validSecretName) : [];
}

export async function setSecret(name, value) {
  await backend.set(name, value);
  cache.set(name, value);
  const names = new Set(listSecrets());
  names.add(name);
  writeJson(paths.secrets, { names: [...names].sort() }, true);
}

export async function removeSecret(name) {
  await backend.remove(name);
  cache.delete(name);
  writeJson(paths.secrets, { names: listSecrets().filter((n) => n !== name) }, true);
}

/** Internal only. Never expose through a tool result. */
export async function revealSecret(name) {
  validateSecretName(name);
  backend.assertSupported();
  if (cache.has(name)) return cache.get(name);
  try {
    const value = await backend.get(name);
    cache.set(name, value);
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
