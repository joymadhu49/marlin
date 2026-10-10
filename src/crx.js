// Download a Chrome Web Store extension as a CRX, parse it, and unpack it
// with its public key injected into manifest.json so the unpacked copy keeps
// the exact same extension ID as the store version.
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
  const requireBytes = (length) => {
    if (length > buf.length - i) throw new Error('Invalid CRX protobuf: truncated field');
  };
  const varint = () => {
    let v = 0n;
    for (let n = 0; n < 10; n++) {
      requireBytes(1);
      const b = buf[i++];
      if (n === 9 && b > 1) throw new Error('Invalid CRX protobuf: varint overflow');
      v |= BigInt(b & 0x7f) << BigInt(n * 7);
      if (!(b & 0x80)) return v;
    }
    throw new Error('Invalid CRX protobuf: varint overflow');
  };
  while (i < buf.length) {
    const rawTag = varint();
    if (rawTag > 0xffffffffn) throw new Error('Invalid CRX protobuf: field tag overflow');
    const tag = Number(rawTag);
    const field = tag >>> 3, wire = tag & 7;
    if (field === 0) throw new Error('Invalid CRX protobuf: field number zero');
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const rawLength = varint();
      if (rawLength > BigInt(buf.length - i)) throw new Error('Invalid CRX protobuf: truncated field');
      const len = Number(rawLength);
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5 || wire === 1) {
      const len = wire === 5 ? 4 : 8;
      requireBytes(len);
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`Invalid CRX protobuf: unsupported wire type ${wire}`);
  }
  return out;
}

function messageBytes(field) {
  if (field.wire !== 2) throw new Error(`Invalid CRX protobuf: field ${field.field} must contain bytes`);
  return field.value;
}

/** Splits a CRX2/CRX3 buffer into { zip, publicKey, id }. */
export function parseCrx(buf) {
  if (buf.subarray(0, 4).toString() !== 'Cr24') {
    if (buf.subarray(0, 2).toString() === 'PK') return { zip: buf, publicKey: null, id: null };
    throw new Error('Not a CRX file');
  }
  if (buf.length < 8) throw new Error('Invalid CRX: truncated version header');
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    if (buf.length < 16) throw new Error('Invalid CRX2: truncated header');
    const keyLen = buf.readUInt32LE(8), sigLen = buf.readUInt32LE(12);
    if (keyLen + sigLen > buf.length - 16) throw new Error('Invalid CRX2: truncated key or signature');
    const publicKey = buf.subarray(16, 16 + keyLen);
    return { zip: buf.subarray(16 + keyLen + sigLen), publicKey, id: idFromPublicKey(publicKey) };
  }
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}`);
  if (buf.length < 12) throw new Error('Invalid CRX3: truncated header');
  const headerLen = buf.readUInt32LE(8);
  if (headerLen > buf.length - 12) throw new Error('Invalid CRX3: truncated protobuf header');
  const header = readProto(buf.subarray(12, 12 + headerLen));
  const zip = buf.subarray(12 + headerLen);
  let crxId = null;
  const signed = header.find((f) => f.field === 10000);
  if (signed) {
    const sd = readProto(messageBytes(signed)).find((f) => f.field === 1);
    if (sd) {
      const bytes = messageBytes(sd);
      if (bytes.length !== 16) throw new Error('Invalid CRX3: crx_id must contain 16 bytes');
      crxId = [...bytes].map((b) => (b >> 4).toString(16) + (b & 15).toString(16)).join('')
        .split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    }
  }
  // RSA (2) and ECDSA (3) proofs; the developer key is the one matching crx_id.
  const keys = header.filter((f) => f.field === 2 || f.field === 3)
    .map((f) => readProto(messageBytes(f)).find((p) => p.field === 1))
    .filter(Boolean).map(messageBytes);
  const publicKey = keys.find((k) => idFromPublicKey(k) === crxId) || keys[0] || null;
  return { zip, publicKey, id: publicKey ? idFromPublicKey(publicKey) : crxId };
}

async function unzipTo(zipBuf, dest) {
  const tmp = await mkdtemp(join(tmpdir(), 'marlin-crx-'));
  const zipPath = join(tmp, 'ext.zip');
  await writeFile(zipPath, zipBuf);
  await mkdir(dest, { recursive: true });
  // unzip exits 1 on harmless warnings (extra bytes etc.); only fail on 2+.
  try { await run('unzip', ['-q', '-o', zipPath, '-d', dest]); }
  catch (e) { if (e.code !== 1) throw e; }
  await rm(tmp, { recursive: true, force: true });
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
  await rm(dest, { recursive: true, force: true });
  await cp(path, dest, { recursive: true });
  return { id, dir: dest, manifest };
}
