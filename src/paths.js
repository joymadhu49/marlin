import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.MARLIN_HOME || join(homedir(), 'Library', 'Application Support', 'Marlin');

export const paths = {
  home: HOME,
  profile: join(HOME, 'profile'),
  extensions: join(HOME, 'extensions'),
  builtin: join(HOME, 'builtin', 'marlin-agent'),
  registry: join(HOME, 'extensions.json'),
  state: join(HOME, 'state.json'),
  config: join(HOME, 'config.json'),
  secrets: join(HOME, 'secrets.json'),
  shots: join(HOME, 'screenshots'),
  downloads: join(HOME, 'downloads'),
  log: join(HOME, 'marlin.log'),
  extensionSrc: join(ROOT, 'extension'),
};

for (const d of [paths.home, paths.profile, paths.extensions, paths.shots, paths.downloads]) {
  mkdirSync(d, { recursive: true });
}

export function chromiumPath() {
  const candidates = [
    process.env.MARLIN_CHROMIUM,
    // Inside Marlin.app the rebranded Chromium binary sits next to us.
    join(ROOT, '..', '..', 'MacOS', 'Chromium'),
    join(ROOT, 'chromium', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('Chromium not found. Run: marlin fetch-chromium');
  return hit;
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data, secret = false) {
  writeFileSync(file, JSON.stringify(data, null, 2));
  if (secret) chmodSync(file, 0o600);
}

const DEFAULT_CONFIG = {
  port: 47615,
  cdpPort: 47616,
  headless: false,
  // "smart": agents sign logins and plain messages alone, a human approves
  // transactions, token approvals and typed data. "ask": a human approves every
  // wallet confirm. "allow": agents sign everything.
  signPolicy: 'smart',
  model: 'anthropic/claude-sonnet-5.5',
  maxSteps: 40,
  // Leaner Chromium flags + Memory Saver. Extra flags go in chromiumFlags.
  lowMemory: true,
  chromiumFlags: [],
};

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(paths.config, {}) };
}

export function saveConfig(patch) {
  const next = { ...readJson(paths.config, {}), ...patch };
  writeJson(paths.config, next);
  return { ...DEFAULT_CONFIG, ...next };
}
