// Download an official Chromium snapshot for the current supported platform.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from './paths.js';
import { chromiumTarget } from './platform.js';
import { extractZip } from './archive.js';

export async function fetchChromium({ platform = process.platform, arch = process.arch, root = ROOT,
  revision = process.env.MARLIN_CHROMIUM_REVISION, fetchImpl = fetch, extract = extractZip } = {}) {
  const target = chromiumTarget(platform, arch);
  const base = `https://storage.googleapis.com/chromium-browser-snapshots/${target.bucket}`;
  if (!revision) {
    const latest = await fetchImpl(`${base}/LAST_CHANGE`);
    if (!latest.ok) throw new Error(`Chromium revision lookup failed: HTTP ${latest.status}`);
    revision = (await latest.text()).trim();
  }
  if (!/^\d+$/.test(revision)) throw new Error('Invalid Chromium snapshot revision');
  const dir = join(root, 'chromium');
  await mkdir(dir, { recursive: true });
  const stage = await mkdtemp(join(dir, '.download-'));
  const backup = join(stage, 'previous');
  const destination = join(dir, target.directory);
  try {
    console.log(`Downloading Chromium r${revision} (${target.bucket})`);
    const res = await fetchImpl(`${base}/${revision}/${target.archive}`);
    if (!res.ok) throw new Error(`Chromium download failed: HTTP ${res.status}`);
    if (!res.body) throw new Error('Chromium download returned no body');
    const zip = join(stage, target.archive);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    await extract(zip, stage);
    if (!existsSync(join(stage, ...target.executable))) throw new Error('Downloaded archive has no Chromium executable');
    if (platform === 'darwin') execFileSync('xattr', ['-dr', 'com.apple.quarantine', join(stage, target.directory, 'Chromium.app')]);
    if (existsSync(destination)) await rename(destination, backup);
    try { await rename(join(stage, target.directory), destination); }
    catch (error) {
      if (existsSync(backup)) await rename(backup, destination);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    await writeFile(join(dir, 'REVISION'), String(revision));
    console.log('Done');
    return { revision: String(revision), executable: join(dir, ...target.executable) };
  } finally {
    // If rollback itself failed, retain the backup for recovery.
    if (!existsSync(backup)) await rm(stage, { recursive: true, force: true });
  }
}
