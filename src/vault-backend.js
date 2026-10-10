import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SERVICE = 'Marlin';
export const validSecretName = (name) => typeof name === 'string' && /^[\w.\-]{1,64}$/.test(name);
export function validateSecretName(name) {
  if (!validSecretName(name)) throw new Error('Secret names use 1–64 letters, digits, dot, dash or underscore');
}

// Only this fixed program is placed in argv. Secret bytes and entropy travel
// through stdin as ASCII JSON/base64, preserving Unicode and trailing newlines.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $data = [Convert]::FromBase64String($request.data)
  $entropy = [Convert]::FromBase64String($request.entropy)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
  } else { throw 'Unsupported vault operation' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
  [Console]::Error.Write('Windows data protection operation failed.')
  exit 1
}
`;
const DPAPI_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text',
  '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')];

function runCommand(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

function missingSecret() {
  return Object.assign(new Error('Secret not found'), { code: 'ENOENT' });
}

/** Internal platform adapter. Never return its secret values through tools. */
export function createSecretBackend({ platform = process.platform, home, run = runCommand } = {}) {
  const assertSupported = () => {
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new Error(`Secret storage is not supported on ${platform}; use macOS Keychain or Windows DPAPI`);
    }
  };
  const checkName = (name) => { validateSecretName(name); assertSupported(); };
  const directory = join(home, 'vault');
  // Hash names to avoid Windows reserved filenames, case folding and path aliases.
  const fileFor = (name) => join(directory, `${createHash('sha256').update(name).digest('hex')}.dpapi`);
  async function dpapi(operation, name, data) {
    const input = JSON.stringify({
      operation, data: data.toString('base64'),
      entropy: Buffer.from(`Marlin vault v1\0${name}`, 'utf8').toString('base64'),
    });
    try {
      const { stdout } = await run('powershell.exe', DPAPI_ARGS, input);
      const encoded = stdout.trim();
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('Invalid data protection result');
      }
      return Buffer.from(encoded, 'base64');
    } catch (error) {
      // Do not include subprocess output or argv in an error surfaced to a tool.
      if (error.code === 'ENOENT') throw new Error('Windows secret storage requires powershell.exe');
      if (operation === 'unprotect') {
        throw new Error('Cannot decrypt this Windows secret: it may be damaged or protected by a different Windows account');
      }
      throw new Error('Windows secret encryption failed; the existing secret was not replaced');
    }
  }
  return {
    assertSupported,
    async set(name, value) {
      checkName(name);
      if (typeof value !== 'string' || value.length === 0) throw new Error('Secret must be a non-empty string');
      if (platform === 'darwin') {
        await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
        return;
      }
      const protectedBytes = await dpapi('protect', name, Buffer.from(value, 'utf8'));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(directory, '.write-'));
      try {
        const pending = join(staging, 'secret.dpapi');
        await writeFile(pending, protectedBytes, { mode: 0o600 });
        await rename(pending, fileFor(name));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    async get(name) {
      checkName(name);
      if (platform === 'darwin') {
        try {
          const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
          return stdout.replace(/\n$/, '');
        } catch { throw missingSecret(); }
      }
      const protectedBytes = await readFile(fileFor(name));
      return (await dpapi('unprotect', name, protectedBytes)).toString('utf8');
    },
    async remove(name) {
      checkName(name);
      if (platform === 'darwin') {
        await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).catch(() => {});
      } else {
        await rm(fileFor(name), { force: true });
      }
    },
  };
}
