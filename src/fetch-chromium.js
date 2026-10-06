// Downloads the newest open source Chromium snapshot for this Mac.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arch } from 'node:os';
import { ROOT } from './paths.js';

export async function fetchChromium() {
  const platform = arch() === 'arm64' ? 'Mac_Arm' : 'Mac';
  const base = `https://storage.googleapis.com/chromium-browser-snapshots/${platform}`;
  const rev = (await (await fetch(`${base}/LAST_CHANGE`)).text()).trim();
  const dir = join(ROOT, 'chromium');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'chrome-mac.zip');
  console.log(`Downloading Chromium r${rev} (${platform})`);
  const res = await fetch(`${base}/${rev}/chrome-mac.zip`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  rmSync(join(dir, 'chrome-mac'), { recursive: true, force: true });
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  rmSync(zip);
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', join(dir, 'chrome-mac', 'Chromium.app')]);
  writeFileSync(join(dir, 'REVISION'), rev);
  console.log('Done');
}
