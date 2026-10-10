// Both platform updaters report progress through the same browser controls.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ROOT } from './paths.js';
import { canUpdateWindows, runWindowsUpdater } from './updates-windows.js';

export const helperPath = join(ROOT, '..', '..', 'Helpers', 'Marlin Updater.app', 'Contents', 'MacOS', 'Marlin Updater');
export const canUpdate = () => process.platform === 'win32' ? canUpdateWindows() : existsSync(helperPath);

export function runUpdater(mode, onEvent = () => {}, options = {}) {
  return process.platform === 'win32'
    ? runWindowsUpdater(mode, onEvent, options)
    : runMacUpdater(mode, onEvent);
}

/** Runs the helper in a JSON mode and calls onEvent for each line. Resolves with the last event. */
export function runMacUpdater(mode, onEvent = () => {}) {
  return new Promise((resolve) => {
    if (!existsSync(helperPath)) {
      const e = { event: 'error', message: 'This is a development build. Update it with git pull and install.sh.' };
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
