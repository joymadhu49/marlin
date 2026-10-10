// Promote a successful Windows artifact; never rebuild or overwrite a release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [runId, source, tag] = process.argv.slice(2);
if (!/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(source || '') || !/^v\d+\.\d+\.\d+-windows\.\d+$/.test(tag || '')) {
  throw new Error('Usage: node scripts/publish-windows.js <successful-run-id> <full-source-sha> <vX.Y.Z-windows.N>');
}
const repo = process.env.GH_REPO;
if (repo !== 'joymadhu49/marlin') throw new Error('This publisher is restricted to joymadhu49/marlin');
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}`]));
if (run.conclusion !== 'success' || run.head_sha !== source || run.path !== '.github/workflows/windows.yml') {
  throw new Error('Artifact source must match a successful Windows package workflow exactly');
}
const artifacts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts`])).artifacts;
if (!artifacts.some(a => a.name === 'marlin-windows-x64' && !a.expired)) throw new Error('Tested package artifact is unavailable');
const dir = mkdtempSync(join(tmpdir(), 'marlin-publish-'));
try {
  gh(['run', 'download', runId, '--repo', repo, '--name', 'marlin-windows-x64', '--dir', dir]);
  const name = `Marlin-${tag.slice(1)}-windows-x64.zip`;
  const files = readdirSync(dir).sort();
  if (JSON.stringify(files) !== JSON.stringify([name, `${name}.sha256`].sort())) throw new Error('Unexpected package artifact contents');
  const archive = join(dir, name);
  const checksum = readFileSync(`${archive}.sha256`, 'utf8').trim();
  const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(checksum);
  if (!match || match[2] !== name) throw new Error('Invalid checksum sidecar');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== match[1].toLowerCase()) throw new Error('Package checksum mismatch');
  const metadata = JSON.parse(execFileSync('unzip', ['-p', archive, 'Marlin-win32-x64/package.json'], { encoding: 'utf8' }));
  if (`v${metadata.version}` !== tag) throw new Error('Bundled version does not match release tag');
  console.log(`Verified ${name}: sha256:${actual}, source ${source}, build ${runId}`);
  console.log(gh(['release', 'create', tag, archive, `${archive}.sha256`, '--repo', repo,
    '--target', source, '--prerelease', '--latest=false', '--title', `Marlin ${metadata.version} — Windows x64 Preview`,
    '--notes-file', 'docs/windows-preview-release.md']));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
