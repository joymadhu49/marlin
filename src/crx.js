// Download a Chrome Web Store extension as a CRX, verify it, and unpack it
// with its public key injected into manifest.json so the unpacked copy keeps
// the exact same extension ID as the store version.
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, cp, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { extractZip } from './archive.js';

/** Accepts a bare 32-char ID or any Web Store URL containing one. */
export function parseExtensionRef(ref) {
  const m = String(ref).match(/\b([a-p]{32})\b/);
  return m ? m[1] : null;
}

export function crxUrl(id, prodversion = '157.0.0.0') {
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${prodversion}&acceptformat=crx2,crx3&x=${x}`;
}

export function idFromPublicKey(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Minimal protobuf reader: returns [{field, wire, value}] for one message.
function readProto(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let shift = 0n, v = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) { i += 4; } else if (wire === 1) { i += 8; } else break;
  }
  return out;
}

/** Splits a CRX2/CRX3 buffer into { zip, publicKey, id }. */
export function parseCrx(buf) {
  if (buf.subarray(0, 4).toString() !== 'Cr24') {
    if (buf.subarray(0, 2).toString() === 'PK') return { zip: buf, publicKey: null, id: null };
    throw new Error('Not a CRX file');
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8), sigLen = buf.readUInt32LE(12);
    const publicKey = buf.subarray(16, 16 + keyLen);
    return { zip: buf.subarray(16 + keyLen + sigLen), publicKey, id: idFromPublicKey(publicKey) };
  }
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}`);
  const headerLen = buf.readUInt32LE(8);
  const header = readProto(buf.subarray(12, 12 + headerLen));
  const zip = buf.subarray(12 + headerLen);
  let crxId = null;
  const signed = header.find((f) => f.field === 10000);
  if (signed) {
    const sd = readProto(signed.value).find((f) => f.field === 1);
    if (sd) crxId = [...sd.value].map((b) => (b >> 4).toString(16) + (b & 15).toString(16)).join('')
      .split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  }
  // RSA (2) and ECDSA (3) proofs; the developer key is the one matching crx_id.
  const keys = header.filter((f) => f.field === 2 || f.field === 3)
    .map((f) => readProto(f.value).find((p) => p.field === 1)?.value).filter(Boolean);
  const publicKey = keys.find((k) => idFromPublicKey(k) === crxId) || keys[0] || null;
  return { zip, publicKey, id: publicKey ? idFromPublicKey(publicKey) : crxId };
}

async function unzipTo(zipBuf, dest) {
  const tmp = await mkdtemp(join(tmpdir(), 'marlin-crx-'));
  const zipPath = join(tmp, 'ext.zip');
  try {
    await writeFile(zipPath, zipBuf);
    await extractZip(zipPath, dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function injectKey(dir, publicKey) {
  const mf = join(dir, 'manifest.json');
  const manifest = JSON.parse((await readFile(mf, 'utf8')).replace(/^﻿/, ''));
  if (publicKey && !manifest.key) manifest.key = Buffer.from(publicKey).toString('base64');
  // _metadata holds store signatures that no longer match once unpacked.
  await rm(join(dir, '_metadata'), { recursive: true, force: true });
  await writeFile(mf, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Installs from a buffer (CRX or zip) into extRoot/<id>. Returns {id, dir, manifest}. */
export async function unpackCrxBuffer(buf, extRoot, fallbackId) {
  const { zip, publicKey, id: parsedId } = parseCrx(buf);
  const id = parsedId || fallbackId || `local-${Date.now()}`;
  const dest = join(extRoot, id);
  const staging = `${dest}.staging`;
  await rm(staging, { recursive: true, force: true });
  await unzipTo(zip, staging);
  const manifest = await injectKey(staging, publicKey);
  await rm(dest, { recursive: true, force: true });
  await rename(staging, dest);
  return { id, dir: dest, manifest };
}

export async function downloadFromStore(ref, extRoot, prodversion) {
  const id = parseExtensionRef(ref);
  if (!id) throw new Error(`Could not find a 32 character extension ID in "${ref}"`);
  const res = await fetch(crxUrl(id, prodversion), { redirect: 'follow' });
  if (!res.ok) throw new Error(`Web Store download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`Web Store returned no package for ${id} (removed, region locked, or wrong ID)`);
  const out = await unpackCrxBuffer(buf, extRoot, id);
  if (out.id !== id) throw new Error(`Package ID mismatch: expected ${id}, got ${out.id}`);
  return out;
}

/** Copies a local unpacked folder, .crx or .zip into the managed extensions dir. */
export async function installFromPath(path, extRoot) {
  if (!existsSync(path)) throw new Error(`No such path: ${path}`);
  if (/\.(crx|zip)$/i.test(path)) return unpackCrxBuffer(await readFile(path), extRoot);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  const id = manifest.key ? idFromPublicKey(Buffer.from(manifest.key, 'base64')) : `local-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`;
  const dest = join(extRoot, id);
  await mkdir(extRoot, { recursive: true });
  const source = await realpath(path);
  const target = await realpath(dest).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return realpath(extRoot).then((root) => join(root, id));
  });
  if (source === target) return { id, dir: dest, manifest };
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (contains(source, target) || contains(target, source)) {
    throw new Error('Cannot install overlapping source and destination directories');
  }

  // Finish copying before touching an existing installation. Keep its backup
  // on the same filesystem so a failed replacement can be rolled back.
  const staging = await mkdtemp(join(extRoot, '.marlin-install-'));
  const replacement = join(staging, 'replacement');
  const backup = join(staging, 'previous');
  let backedUp = false, preserveBackup = false;
  try {
    await cp(source, replacement, { recursive: true });
    try { await rename(dest, backup); backedUp = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(replacement, dest); }
    catch (error) {
      if (backedUp) {
        try { await rename(backup, dest); }
        catch (restoreError) {
          preserveBackup = true;
          throw new Error(`Installation failed; previous files remain at ${backup}`, { cause: restoreError });
        }
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true });
  }
  return { id, dir: dest, manifest };
}
