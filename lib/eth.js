// lib/eth.js — minimal EVM crypto in pure Node stdlib (no dependencies).
// Node's crypto has no keccak256 and no raw secp256k1 digest signing, both
// of which x402 (EIP-3009 / EIP-712) needs. So: keccak-f[1600] implemented
// here, plus secp256k1 ECDSA sign / ecrecover over BigInt, plus EIP-712
// hashing for transferWithAuthorization. Validated against known vectors
// in test-local.mjs (keccak256("") / keccak256("abc"), sign->recover
// round-trip). Used for:
//   - the agent's own throwaway EVM wallet (x402 payTo address)
//   - signing test x402 payment payloads (test-only; never mainnet funds)
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// keccak256 (original Keccak, padding 0x01 — NOT NIST SHA-3 padding 0x06)
// ---------------------------------------------------------------------------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62,
  18, 39, 61, 20, 44,
];
const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14,
  22, 9, 6, 1,
];
const MASK64 = (1n << 64n) - 1n;
function rotl64(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}
function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const D = new Array(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= D[x];
    }
    // Rho + Pi
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = state[j];
      state[j] = rotl64(t, ROT[i]);
      t = tmp;
    }
    // Chi
    for (let y = 0; y < 5; y++) {
      const row = [];
      for (let x = 0; x < 5; x++) row[x] = state[x + 5 * y];
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5]);
      }
    }
    // Iota
    state[0] ^= RC[round];
  }
}

export function keccak256(input) {
  const bytes = typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : Buffer.from(input);
  const rate = 136; // 1088 bits
  const state = new Array(25).fill(0n);
  let off = 0;
  while (off + rate <= bytes.length) {
    for (let i = 0; i < rate / 8; i++) {
      state[i] ^= bytes.readBigUInt64LE(off + i * 8);
    }
    keccakF(state);
    off += rate;
  }
  const block = Buffer.alloc(rate);
  bytes.copy(block, 0, off);
  block[bytes.length - off] = 0x01;
  block[rate - 1] |= 0x80;
  for (let i = 0; i < rate / 8; i++) {
    state[i] ^= block.readBigUInt64LE(i * 8);
  }
  keccakF(state);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}

export const keccak256Hex = (input) => '0x' + keccak256(input).toString('hex');

// ---------------------------------------------------------------------------
// secp256k1 — sign (RFC 6979 deterministic k) and ecrecover, over BigInt
// ---------------------------------------------------------------------------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}
function modInv(a, m = P) {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}
function pointAdd(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y) === 0n) return null;
  let m;
  if (a.x === b.x && a.y === b.y) {
    m = mod((3n * a.x * a.x) * modInv(2n * a.y));
  } else {
    m = mod((b.y - a.y) * modInv(b.x - a.x));
  }
  const x = mod(m * m - a.x - b.x);
  const y = mod(m * (a.x - x) - a.y);
  return { x, y };
}
function pointMul(k, point = G) {
  let res = null;
  let add = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) res = pointAdd(res, add);
    add = pointAdd(add, add);
    n >>= 1n;
  }
  return res;
}
// RFC 6979 deterministic nonce, HMAC-SHA256 based (FIPS 186-4 style).
function deterministicK(priv, digest) {
  let v = Buffer.alloc(32, 0x01);
  let k = Buffer.alloc(32, 0x00);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  k = hmac(k, Buffer.concat([v, Buffer.from([0x00]), priv, digest]));
  v = hmac(k, v);
  k = hmac(k, Buffer.concat([v, Buffer.from([0x01]), priv, digest]));
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const cand = BigInt('0x' + v.toString('hex'));
    if (cand >= 1n && cand < N) return cand;
    k = hmac(k, Buffer.concat([v, Buffer.from([0x00])]));
    v = hmac(k, v);
  }
}

export function privateToPublic(privBytes) {
  const d = BigInt('0x' + Buffer.from(privBytes).toString('hex'));
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const Q = pointMul(d);
  const x = Q.x.toString(16).padStart(64, '0');
  const y = Q.y.toString(16).padStart(64, '0');
  return Buffer.from('04' + x + y, 'hex'); // 65-byte uncompressed
}

export function publicToAddress(pubUncompressed) {
  const hash = keccak256(pubUncompressed.subarray(1));
  return '0x' + hash.subarray(12).toString('hex');
}

export function generateWallet() {
  const priv = crypto.randomBytes(32);
  const pub = privateToPublic(priv);
  return { privateKey: '0x' + priv.toString('hex'), address: publicToAddress(pub) };
}

// Sign a 32-byte digest. Returns { r, s, v } (v = 27/28).
export function signDigest(privBytes, digest) {
  const d = BigInt('0x' + Buffer.from(privBytes).toString('hex'));
  const z = BigInt('0x' + Buffer.from(digest).toString('hex'));
  const k = deterministicK(Buffer.from(privBytes), Buffer.from(digest));
  const R = pointMul(k);
  const r = mod(R.x, N);
  if (r === 0n) throw new Error('r=0, retry');
  let s = mod(modInv(k, N) * (z + r * d), N);
  let v = R.y % 2n === 0n ? 27n : 28n;
  if (s > N / 2n) { // low-s normalization
    s = N - s;
    v = v === 27n ? 28n : 27n;
  }
  return {
    r: '0x' + r.toString(16).padStart(64, '0'),
    s: '0x' + s.toString(16).padStart(64, '0'),
    v: Number(v),
    signature: '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0'),
  };
}

// Recover the signer address from a 32-byte digest + {r, s, v}.
export function recoverAddress(digest, { r, s, v }) {
  const z = BigInt('0x' + Buffer.from(digest).toString('hex'));
  const ri = BigInt(r);
  const si = BigInt(s);
  const recid = BigInt(v - 27);
  if (recid !== 0n && recid !== 1n) throw new Error('bad v');
  const x = ri + (recid >> 1n) * (1n << 256n); // x = r + j*n, j = recid>>1 = 0
  // y^2 = x^3 + 7 (mod p); y parity = recid & 1
  const alpha = mod(x * x * x + 7n);
  let y = modPow(alpha, (P + 1n) / 4n, P); // p % 4 == 3
  if ((y % 2n) !== (recid & 1n)) y = P - y;
  const R = { x, y };
  const rInv = modInv(ri, N);
  const u1 = mod(-z * rInv, N);
  const u2 = mod(si * rInv, N);
  const Q = pointAdd(pointMul(u1), pointMul(u2, R));
  if (!Q) throw new Error('recovery failed');
  const pub = Buffer.from(
    '04' + Q.x.toString(16).padStart(64, '0') + Q.y.toString(16).padStart(64, '0'),
    'hex',
  );
  return publicToAddress(pub);
}
function modPow(base, exp, m) {
  let res = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = mod(res * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return res;
}

// ---------------------------------------------------------------------------
// EIP-712 — transferWithAuthorization (EIP-3009, as used by x402 "exact")
// ---------------------------------------------------------------------------
const TRANSFER_TYPEHASH = keccak256(
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
);
const DOMAIN_TYPEHASH = keccak256(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
);

function abiEncode(types, values) {
  // Minimal static ABI encoding for the types we use (address/uint256/
  // bytes32/string-hash). Returns a Buffer.
  const parts = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const v = values[i];
    if (t === 'address') {
      parts.push(Buffer.from(v.replace(/^0x/, '').toLowerCase().padStart(64, '0'), 'hex'));
    } else if (t === 'uint256') {
      parts.push(Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex'));
    } else if (t === 'bytes32') {
      parts.push(Buffer.from(v.replace(/^0x/, '').padStart(64, '0'), 'hex'));
    } else if (t === 'bytes32hash') {
      parts.push(Buffer.from(v.replace(/^0x/, ''), 'hex'));
    } else {
      throw new Error(`unsupported abi type ${t}`);
    }
  }
  return Buffer.concat(parts);
}

export function eip712TransferAuthorizationHash({ chainId, verifyingContract, name = 'USDC', version = '2', from, to, value, validAfter, validBefore, nonce }) {
  const domainSeparator = keccak256(abiEncode(
    ['bytes32hash', 'bytes32hash', 'bytes32hash', 'uint256', 'address'],
    [
      '0x' + DOMAIN_TYPEHASH.toString('hex'),
      '0x' + keccak256(name).toString('hex'),
      '0x' + keccak256(version).toString('hex'),
      chainId,
      verifyingContract,
    ],
  ));
  const structHash = keccak256(abiEncode(
    ['bytes32hash', 'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [
      '0x' + TRANSFER_TYPEHASH.toString('hex'),
      from, to, value, validAfter, validBefore, nonce,
    ],
  ));
  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]),
    domainSeparator,
    structHash,
  ]));
}

// Build + sign an EIP-3009 authorization for x402 "exact" payments.
// Returns the authorization object + signature (hex) for the payload.
export function signTransferAuthorization(privBytes, auth, { chainId, verifyingContract, name = 'USDC', version = '2' }) {
  const digest = eip712TransferAuthorizationHash({ chainId, verifyingContract, name, version, ...auth });
  const sig = signDigest(privBytes, digest);
  return { ...auth, signature: sig.signature, digest: '0x' + digest.toString('hex') };
}
