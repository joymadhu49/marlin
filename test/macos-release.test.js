import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const native = (name, fn) => test(name, { skip: process.platform !== 'darwin' && 'macOS release tools' }, fn);
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', ...options });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'marlin-mac [release] '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function script(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
}

test('Sparkle build numbers preserve ordering and reject prerelease or colliding versions', { skip: process.platform === 'win32' }, () => {
  const build = version => run('/bin/bash', ['-c', 'source "$1"; macos_build_number "$2"', 'test', join(root, 'scripts/build-common.sh'), version]);
  for (const [version, expected] of [['0.2.2', '202'], ['0.3.0', '300'], ['1.4.12', '10412']]) {
    const result = build(version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  for (const version of ['0.3.0-windows.3', '0.3.0-beta.1', '0.100.0', '0.3.100', 'invalid']) {
    const result = build(version);
    assert.notEqual(result.status, 0, version);
    assert.equal(result.stdout, '');
  }
});

native('macOS updater resolves default, absolute and relative custom profile locations', t => {
  const dir = temporary(t);
  const main = join(dir, 'main.swift');
  writeFileSync(main, `import Foundation
let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
let cwd = URL(fileURLWithPath: "/tmp/work [test]", isDirectory: true)
for env in [[:], ["MARLIN_HOME": ""], ["MARLIN_HOME": "/tmp/profile [custom]"], ["MARLIN_HOME": "profiles/custom"]] {
    print(marlinStateURL(environment: env, homeDirectory: home, workingDirectory: cwd).path)
}
`);
  const executable = join(dir, 'paths');
  const compile = run('xcrun', ['swiftc', join(root, 'updater/Paths.swift'), main, '-o', executable]);
  assert.equal(compile.status, 0, compile.stderr);
  const output = run(executable, []);
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(output.stdout.trim().split('\n'), [
    '/Users/example/Library/Application Support/Marlin/state.json',
    '/Users/example/Library/Application Support/Marlin/state.json',
    '/tmp/profile [custom]/state.json',
    '/tmp/work [test]/profiles/custom/state.json',
  ]);
});

function releaseFixture(t) {
  const dir = temporary(t);
  for (const folder of ['scripts', 'app', 'bin', 'vendor/sparkle/bin']) mkdirSync(join(dir, folder), { recursive: true });
  for (const file of ['scripts/release.sh', 'scripts/build-common.sh']) copyFileSync(join(root, file), join(dir, file));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  writeFileSync(join(dir, 'CHANGELOG.md'), '## 0.3.0\n- Native release fixture.\n');
  script(join(dir, 'app/build-app.sh'), `mkdir -p dist/Marlin.app/Contents dist/build
cat > dist/Marlin.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>123.0.0</string></dict></plist>
PLIST
if [ -n "\${MUTATE_SOURCE:-}" ]; then echo changed >> CHANGELOG.md; fi`);
  script(join(dir, 'scripts/sign.sh'), 'exit 0');
  script(join(dir, 'bin/xcrun'), 'echo "status: Accepted"');
  script(join(dir, 'bin/security'), 'echo "Developer ID Application: Fixture"');
  script(join(dir, 'bin/codesign'), 'if [ "$1" = --verify ] && [ "${FAIL_VALIDATION:-}" = signature ]; then exit 8; fi');
  script(join(dir, 'bin/spctl'), 'if [ "${FAIL_VALIDATION:-}" = assessment ]; then exit 8; fi');
  script(join(dir, 'bin/ditto'), 'exit 0');
  script(join(dir, 'bin/hdiutil'), 'printf dmg > "${@: -1}"');
  script(join(dir, 'bin/gh'), 'if [ "$1 $2" = "release view" ]; then exit 1; fi\nprintf "%s\\n" "$@" > "$GITHUB_CALLED"');
  script(join(dir, 'bin/git'), 'if [ "$1" = ls-remote ]; then printf "%s" "${EXISTING_TAG:-}"; exit 0; fi\nexec /usr/bin/git "$@"');
  script(join(dir, 'vendor/sparkle/bin/sign_update'), 'echo \'sparkle:edSignature="fixture" length="3"\'');
  script(join(dir, 'vendor/sparkle/bin/generate_keys'), 'echo "Vzdd6fx46YsZwt3iKavazKGu95aBqMUf3rwglxS/JtI="');
  const marker = join(dir, 'github-called');
  writeFileSync(join(dir, '.gitignore'), 'dist/\ngithub-called\n');
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, MARLIN_SIGN_ID: 'Developer ID Application: Fixture', GITHUB_CALLED: marker };
  const git = (...args) => {
    const result = run('/usr/bin/git', args, { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const source = commit();
  return { dir, marker, source, commit, invoke: (args = ['--prepare-only'], overrides = {}) => run('/bin/bash', ['scripts/release.sh', ...args], { cwd: dir, env: { ...env, ...overrides } }) };
}

native('prepare-only produces signed-feed metadata and checksums without calling GitHub', t => {
  const { dir, marker, source, commit, invoke } = releaseFixture(t);
  const result = invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(marker), false, 'prepare-only must not even query GitHub');
  assert.match(readFileSync(join(dir, 'dist/appcast.xml'), 'utf8'), /<sparkle:version>300<\/sparkle:version>/);
  assert.match(readFileSync(join(dir, 'dist/build/notes.md'), 'utf8'), /Apple Silicon \(arm64\)/);
  assert.ok(readFileSync(join(dir, 'dist/build/notes.md'), 'utf8').includes(source));
  assert.match(readFileSync(join(dir, 'dist/SHA256SUMS-macos.txt'), 'utf8'), /Marlin-0\.3\.0\.dmg/);
  const checksums = run('shasum', ['-a', '256', '-c', 'SHA256SUMS-macos.txt'], { cwd: join(dir, 'dist') });
  assert.equal(checksums.status, 0, checksums.stdout + checksums.stderr);
  script(join(dir, 'vendor/sparkle/bin/generate_keys'), 'echo "different-public-key"');
  script(join(dir, 'app/build-app.sh'), 'echo BUILD_SHOULD_NOT_START; exit 99');
  commit();
  const mismatch = invoke();
  assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
  assert.match(mismatch.stderr, /does not match existing Marlin installations/);
  assert.doesNotMatch(mismatch.stdout, /BUILD_SHOULD_NOT_START/);
  assert.equal(existsSync(marker), false);
});

native('publisher binds the release to the exact clean source and explicitly selects latest', t => {
  const { marker, source, invoke } = releaseFixture(t);
  const result = invoke([]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(args[args.indexOf('--target') + 1], source);
  assert.ok(args.includes('--latest'));
});

native('publisher rejects existing tags even without a corresponding GitHub release', t => {
  const { marker, invoke } = releaseFixture(t);
  const result = invoke([], { EXISTING_TAG: '1111111111111111111111111111111111111111 refs/tags/v0.3.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tag v0.3.0 already exists/);
  assert.doesNotMatch(result.stdout, /Building Marlin/);
  assert.equal(existsSync(marker), false);
});

native('publisher rejects source edits during preparation and a dirty checkout before building', t => {
  const { marker, invoke } = releaseFixture(t);
  const result = invoke([], { MUTATE_SOURCE: 'yes' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a clean checkout/);
  assert.equal(existsSync(marker), false);
  const retry = invoke();
  assert.notEqual(retry.status, 0);
  assert.doesNotMatch(retry.stdout, /Building Marlin/);
});

for (const failure of ['signature', 'assessment']) {
  native(`publisher rejects failed ${failure} verification`, t => {
    const { dir, marker, invoke } = releaseFixture(t);
    const result = invoke([], { FAIL_VALIDATION: failure });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, 'dist/appcast.xml')), false);
  });
}
