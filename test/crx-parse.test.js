import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseCrx, idFromPublicKey } from '../src/crx.js';

// These fixtures exercise framing and key selection, not signature verification.
const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
const key = Buffer.from('developer-public-key');
const signature = Buffer.from('signature');
function uint32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
function field(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function crx3(header) { return Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip]); }
const crx2 = Buffer.concat([Buffer.from('Cr24'), uint32(2), uint32(key.length), uint32(signature.length), key, signature, zip]);

test('plain ZIP and CRX2 framing preserve the payload and developer identity', () => {
  assert.deepEqual(parseCrx(zip), { zip, publicKey: null, id: null });
  assert.deepEqual(parseCrx(crx2), { zip, publicKey: key, id: idFromPublicKey(key) });
});

test('CRX3 selects the developer proof matching its signed ID', () => {
  const signedId = createHash('sha256').update(key).digest().subarray(0, 16);
  const header = Buffer.concat([
    field(2, field(1, Buffer.from('store-key'))),
    field(3, field(1, key)),
    field(10000, field(1, signedId)),
  ]);
  assert.deepEqual(parseCrx(crx3(header)), { zip, publicKey: key, id: idFromPublicKey(key) });
});

test('valid unknown protobuf fields are skipped without losing known fields', () => {
  const unknown = Buffer.concat([
    varint(20 * 8), varint(0xffffffffffffffffn),
    varint(21 * 8 + 1), Buffer.alloc(8),
    varint(22 * 8 + 5), Buffer.alloc(4),
    field(23, Buffer.from('unknown')),
  ]);
  const parsed = parseCrx(crx3(Buffer.concat([unknown, field(2, field(1, key))])));
  assert.equal(parsed.id, idFromPublicKey(key));
  assert.deepEqual(parsed.zip, zip);
});

test('all truncated fixed CRX headers produce a controlled parse error', () => {
  for (let length = 4; length < 16; length++) {
    assert.throws(() => parseCrx(crx2.subarray(0, length)), /Invalid CRX.*truncated/);
  }
  const v3 = crx3(Buffer.alloc(0));
  for (let length = 8; length < 12; length++) {
    assert.throws(() => parseCrx(v3.subarray(0, length)), /Invalid CRX3: truncated header/);
  }
});

test('rejects declared CRX2 key and signature lengths beyond the buffer', () => {
  for (const offset of [8, 12]) {
    const bytes = Buffer.from(crx2);
    bytes.writeUInt32LE(0xffffffff, offset);
    assert.throws(() => parseCrx(bytes), /truncated key or signature/);
  }
});

test('rejects a declared CRX3 header extending beyond the package', () => {
  const bytes = crx3(Buffer.alloc(0));
  bytes.writeUInt32LE(0xffffffff, 8);
  assert.throws(() => parseCrx(bytes), /truncated protobuf header/);
});

const invalidHeaders = [
  ['truncated tag varint', Buffer.from([0x80])],
  ['truncated value varint', Buffer.from([0x08, 0x80])],
  ['truncated length varint', Buffer.from([0x12, 0x80])],
  ['overlong varint', Buffer.concat([Buffer.from([0x08]), Buffer.alloc(11, 0x80)])],
  ['uint64 overflow', Buffer.concat([Buffer.from([0x08]), Buffer.alloc(9, 0xff), Buffer.from([2])])],
  ['tag overflow', varint(0x100000000n)],
  ['field number zero', Buffer.from([0])],
  ['unsupported wire type', Buffer.from([0x0f])],
  ['truncated fixed32', Buffer.from([0x0d, 1, 2, 3])],
  ['truncated fixed64', Buffer.from([0x09, 1, 2, 3])],
  ['length beyond header', Buffer.from([0x12, 100, 1])],
  ['unsafe integer length', Buffer.concat([Buffer.from([0x12]), varint(0xffffffffffffffffn)])],
  ['wrong proof wire type', Buffer.from([0x10, 1])],
  ['wrong key wire type', field(2, Buffer.from([0x08, 1]))],
  ['truncated nested proof', field(2, Buffer.from([0x0a, 100]))],
  ['wrong signed header wire type', Buffer.concat([varint(10000 * 8), Buffer.from([1])])],
  ['wrong ID wire type', field(10000, Buffer.from([0x08, 1]))],
  ['incorrect ID length', field(10000, field(1, Buffer.alloc(15)))],
];
for (const [name, header] of invalidHeaders) {
  test(`rejects ${name}`, () => assert.throws(() => parseCrx(crx3(header)), /Invalid CRX/));
}
