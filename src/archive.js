import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/extract-zip.ps1', import.meta.url));

/** Extract into an empty staging directory; callers own cleanup and promotion. */
export async function extractZip(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Archive', archive, '-Destination', destination], { windowsHide: true });
  } else {
    try { await run('unzip', ['-q', '-o', archive, '-d', destination]); }
    catch (e) { if (e.code !== 1) throw e; }
  }
}
