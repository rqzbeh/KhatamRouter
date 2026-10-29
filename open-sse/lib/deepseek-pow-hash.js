// DeepSeekHashV1: SHA3-256 (Keccak-f[1600]) with round 0 skipped.
// Ported from noble-hashes keccak implementation with restored input validation
// and difficulty bounds for DoS prevention.

const B = new Uint32Array(10);

const SHA3_PI = [];
const SHA3_ROTL = [];
const SHA3_IOTA_H = new Uint32Array(24);
const SHA3_IOTA_L = new Uint32Array(24);

{
  let R = 1n;
  let x = 1;
  let y = 0;
  for (let round = 0; round < 24; round++) {
    const nx = y;
    const ny = (2 * x + 3 * y) % 5;
    x = nx;
    y = ny;
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((((round + 1) * (round + 2)) / 2) % 64);
    let t = 0n;
    for (let j = 0; j < 7; j++) {
      R = ((R << 1n) ^ ((R >> 7n) * 0x71n)) % 256n;
      if (R & 2n) t ^= 1n << ((1n << BigInt(j)) - 1n);
    }
    SHA3_IOTA_H[round] = Number(t & 0xFFFFFFFFn);
    SHA3_IOTA_L[round] = Number((t >> 32n) & 0xFFFFFFFFn);
  }
}

function rotlSH(h, l, s) { return (h << s) | (l >>> (32 - s)); }
function rotlSL(h, l, s) { return (l << s) | (h >>> (32 - s)); }
function rotlBH(h, l, s) { return (l << (s - 32)) | (h >>> (64 - s)); }
function rotlBL(h, l, s) { return (h << (s - 32)) | (l >>> (64 - s)); }
function rotlH(h, l, s) { return s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s); }
function rotlL(h, l, s) { return s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s); }

const ROUNDS = 23;
const BLOCK = 136;
const DIGEST_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

function keccakP(s, rounds) {
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++) B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      const b0 = s[y];
      const b1 = s[y + 1];
      const b2 = s[y + 2];
      const b3 = s[y + 3];
      s[y] ^= ~s[y + 2] & s[y + 4];
      s[y + 1] ^= ~s[y + 3] & s[y + 5];
      s[y + 2] ^= ~s[y + 4] & s[y + 6];
      s[y + 3] ^= ~s[y + 5] & s[y + 7];
      s[y + 4] ^= ~s[y + 6] & s[y + 8];
      s[y + 5] ^= ~s[y + 7] & s[y + 9];
      s[y + 6] ^= ~s[y + 8] & b0;
      s[y + 7] ^= ~s[y + 9] & b1;
      s[y + 8] ^= ~b0 & b2;
      s[y + 9] ^= ~b1 & b3;
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
}

export const MAX_DEEPSEEK_POW_DIFFICULTY = 250_000;

function computeSpongeHex(input, rounds) {
  if (typeof input !== "string") {
    throw new TypeError("DeepSeek PoW input must be a string");
  }
  const bytes = new TextEncoder().encode(input);
  const state = new Uint8Array(200);
  const state32 = new Uint32Array(state.buffer);
  let pos = 0;
  for (let i = 0; i < bytes.length; i++) {
    state[pos++] ^= bytes[i];
    if (pos === BLOCK) {
      keccakP(state32, rounds);
      pos = 0;
    }
  }
  state[pos] ^= 0x06;
  state[BLOCK - 1] ^= 0x80;
  keccakP(state32, rounds);
  let digest = "";
  for (let i = 0; i < 32; i++) {
    digest += state[i].toString(16).padStart(2, "0");
  }
  return digest;
}

/**
 * Standard FIPS 202 SHA3-256 (24 rounds) reference used to validate permutation core.
 *
 * @param {string} input
 * @returns {string} 64-character hex digest
 */
export function sha3_256Fips202Reference(input) {
  return computeSpongeHex(input, 24);
}

/**
 * DeepSeekHashV1 digest (23 rounds, round 0 skipped).
 *
 * @param {string} input
 * @returns {string} 64-character hex digest
 */
export function deepSeekHashV1(input) {
  return computeSpongeHex(input, ROUNDS);
}

export const deepSeekHashV1Reference = deepSeekHashV1;

/**
 * Search `prefix + nonce` for a nonce satisfying DeepSeekHashV1(prefix + nonce) == challenge.
 *
 * @param {string} prefix
 * @param {string} challenge - 64-character hex digest (case-insensitive)
 * @param {number} difficulty - Integer in range [1, MAX_DEEPSEEK_POW_DIFFICULTY]
 * @returns {number} Nonce integer if found, or -1 if no match in [0, difficulty)
 * @throws {TypeError} If prefix is not a string or challenge is not a 64-char hex string
 * @throws {RangeError} If difficulty is not a safe integer in [1, 250_000]
 */
export function findDeepSeekPowNonce(prefix, challenge, difficulty) {
  if (typeof prefix !== "string") {
    throw new TypeError("DeepSeek PoW prefix must be a string");
  }
  if (typeof challenge !== "string" || !DIGEST_HEX_PATTERN.test(challenge)) {
    throw new TypeError("DeepSeek PoW challenge must be a 64-character hex digest");
  }
  if (typeof difficulty !== "number") {
    throw new TypeError("DeepSeek PoW difficulty must be a number");
  }
  if (
    !Number.isSafeInteger(difficulty) ||
    difficulty < 1 ||
    difficulty > MAX_DEEPSEEK_POW_DIFFICULTY
  ) {
    throw new RangeError(
      `DeepSeek PoW difficulty must be an integer from 1 to ${MAX_DEEPSEEK_POW_DIFFICULTY}`
    );
  }

  const target = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    target[i] = parseInt(challenge.slice(i * 2, i * 2 + 2), 16);
  }

  const prefixBytes = new TextEncoder().encode(prefix);

  // absorb prefix
  const state = new Uint8Array(200);
  const state32 = new Uint32Array(state.buffer);
  let pos = 0;
  for (let i = 0; i < prefixBytes.length; i++) {
    state[pos++] ^= prefixBytes[i];
    if (pos === BLOCK) {
      keccakP(state32, ROUNDS);
      pos = 0;
    }
  }
  const snapState = state32.slice();
  const snapPos = pos;

  for (let nonce = 0; nonce < difficulty; nonce++) {
    const st = snapState.slice();
    const bytes = new Uint8Array(st.buffer);
    let p = snapPos;
    const str = String(nonce);
    for (let i = 0; i < str.length; i++) {
      bytes[p++] ^= str.charCodeAt(i);
      if (p === BLOCK) {
        keccakP(st, ROUNDS);
        p = 0;
      }
    }
    // finish with SHA3 padding
    bytes[p] ^= 0x06;
    bytes[BLOCK - 1] ^= 0x80;
    keccakP(st, ROUNDS);
    // compare
    let ok = true;
    for (let i = 0; i < 32; i++) {
      if (bytes[i] !== target[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return nonce;
  }
  return -1;
}

/**
 * Backward-compatible synchronous challenge solver wrapper.
 *
 * @param {string} algorithm - Must be "DeepSeekHashV1"
 * @param {string} challenge - 64-character hex digest
 * @param {string} salt - Salt string (1-1024 chars)
 * @param {number} difficulty - Integer in [1, 250_000]
 * @param {number} expireAt - Non-negative safe integer timestamp
 * @returns {number} Nonce integer or -1
 */
export function solveDeepSeekPow(algorithm, challenge, salt, difficulty, expireAt) {
  if (algorithm !== "DeepSeekHashV1") {
    throw new TypeError(`Unsupported DeepSeek PoW algorithm: ${algorithm}`);
  }
  if (typeof salt !== "string") {
    throw new TypeError("DeepSeek PoW salt must be a string");
  }
  if (salt.length === 0 || salt.length > 1024) {
    throw new RangeError("DeepSeek PoW salt must contain 1-1024 characters");
  }
  if (typeof expireAt !== "number") {
    throw new TypeError("DeepSeek PoW expiry must be a number");
  }
  if (!Number.isSafeInteger(expireAt) || expireAt < 0) {
    throw new RangeError("DeepSeek PoW expiry must be a non-negative safe integer");
  }

  return findDeepSeekPowNonce(`${salt}_${expireAt}_`, challenge, difficulty);
}
