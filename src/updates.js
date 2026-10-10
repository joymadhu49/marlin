// In-browser updates. Sparkle (inside the Marlin Updater helper) does the
// download, EdDSA verification and install; Marlin's own pages show it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ROOT } from './paths.js';

export const helperPath = join(ROOT, '..', '..', 'Helpers', 'Marlin Updater.app', 'Contents', 'MacOS', 'Marlin Updater');
export const canUpdate = () => existsSync(helperPath);

/** Runs the helper in a JSON mode and calls onEvent for each line. Resolves with the last event. */
export function runUpdater(mode, onEvent = () => {}) {
  return new Promise((resolve) => {
    if (!canUpdate()) {
      const e = { event: 'error', message: process.platform === 'win32'
        ? 'Windows updates are manual. Download a Windows package from https://github.com/joymadhu49/marlin/releases.'
        : 'This is a development build. Update it with git pull and install.sh.' };
      onEvent(e);
      return resolve(e);
    }
    // Detached: the install shuts this daemon down and the helper must outlive it.
    const child = spawn(helperPath, [mode === 'install' ? '--json-install' : '--json-check'], {
      detached: mode === 'install', stdio: ['ignore', 'pipe', 'ignore'],
    });
    let last = { event: 'none' };
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { last = JSON.parse(line); onEvent(last); } catch {}
    });
    // `exit` can precede the final stdout data. `close` waits for the pipes.
    child.on('close', (code, signal) => {
      if ((signal || code !== 0) && last.event !== 'error') {
        last = { event: 'error', message: signal
          ? `Update helper terminated by ${signal}.`
          : `Update helper exited with code ${code}.` };
        onEvent(last);
      }
      resolve(last);
    });
    child.on('error', (err) => { last = { event: 'error', message: err.message }; onEvent(last); });
    if (mode === 'install') child.unref();
  });
}
