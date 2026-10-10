// Promote the exact tested architecture artifacts; never rebuild or overwrite.
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
const regressions = JSON.parse(gh(['api', `repos/${repo}/actions/workflows/tests.yml/runs?head_sha=${source}&status=success&per_page=20`]));
if (!regressions.workflow_runs?.some(r => r.head_sha === source && r.conclusion === 'success')) {
  throw new Error('The Linux/macOS/Windows regression matrix must also pass for this exact source');
}
const architectures = ['x64', 'arm64', 'x86'];
const artifacts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts`])).artifacts;
for (const arch of architectures) {
  if (artifacts.filter(a => a.name === `marlin-windows-${arch}` && !a.expired).length !== 1) {
    throw new Error(`Exactly one tested ${arch} package artifact is required`);
  }
}
const dir = mkdtempSync(join(tmpdir(), 'marlin-publish-'));
try {
  const uploads = [];
  for (const arch of architectures) {
    const target = join(dir, arch);
    gh(['run', 'download', runId, '--repo', repo, '--name', `marlin-windows-${arch}`, '--dir', target]);
    const name = `Marlin-${tag.slice(1)}-windows-${arch}.zip`;
    if (JSON.stringify(readdirSync(target).sort()) !== JSON.stringify([name, `${name}.sha256`].sort())) {
      throw new Error(`Unexpected ${arch} package artifact contents`);
    }
    const archive = join(target, name);
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(readFileSync(`${archive}.sha256`, 'utf8').trim());
    if (!match || match[2] !== name) throw new Error(`Invalid ${arch} checksum sidecar`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== match[1].toLowerCase()) throw new Error(`${arch} package checksum mismatch`);
    const metadata = JSON.parse(execFileSync('unzip', ['-p', archive, `Marlin-win32-${arch}/package.json`], { encoding: 'utf8' }));
    if (metadata.name !== 'marlin' || `v${metadata.version}` !== tag || metadata.marlinWindowsArch !== arch) {
      throw new Error(`Bundled ${arch} package identity, architecture or version does not match the release`);
    }
    console.log(`Verified ${name}: sha256:${actual}, source ${source}, build ${runId}`);
    uploads.push(archive, `${archive}.sha256`);
  }
  // Preserve releases/latest for the signed macOS appcast used by existing Macs.
  console.log(gh(['release', 'create', tag, ...uploads, '--repo', repo,
    '--target', source, '--prerelease', '--latest=false', '--title', `Marlin ${tag.slice(1)} — Windows x64, ARM64 and x86`,
    '--notes-file', 'docs/windows-release-notes.md']));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
