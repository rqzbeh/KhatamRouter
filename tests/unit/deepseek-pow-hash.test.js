import { describe, expect, it } from "vitest";

import {
  deepSeekHashV1,
  findDeepSeekPowNonce,
  MAX_DEEPSEEK_POW_DIFFICULTY,
  sha3_256Fips202Reference,
  solveDeepSeekPow,
} from "../../open-sse/lib/deepseek-pow-hash.js";

// NIST FIPS 202 Algorithms 1-9 clean-room reference implementation for differential testing
const LANE_MASK = (1n << 64n) - 1n;
const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl64(val, amt) {
  if (amt === 0) return val;
  const s = BigInt(amt);
  return ((val << s) | (val >> (64n - s))) & LANE_MASK;
}

function referenceKeccak(input, roundCount) {
  const bytes = new TextEncoder().encode(input);
  const state = new Array(25).fill(0n);
  let offset = 0;
  while (offset + 136 <= bytes.length) {
    for (let i = 0; i < 136; i++) {
      state[Math.floor(i / 8)] ^= BigInt(bytes[offset + i]) << BigInt((i % 8) * 8);
    }
    permuteReference(state, roundCount);
    offset += 136;
  }
  const block = new Uint8Array(136);
  block.set(bytes.subarray(offset));
  block[bytes.length - offset] ^= 0x06;
  block[135] ^= 0x80;
  for (let i = 0; i < 136; i++) {
    state[Math.floor(i / 8)] ^= BigInt(block[i]) << BigInt((i % 8) * 8);
  }
  permuteReference(state, roundCount);
  const out = [];
  for (let i = 0; i < 32; i++) {
    out.push(Number((state[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xffn));
  }
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

function permuteReference(state, roundCount) {
  const cp = new Array(5).fill(0n);
  const tm = new Array(5).fill(0n);
  const rp = new Array(25).fill(0n);
  const start = 24 - roundCount;
  for (let r = start; r < 24; r++) {
    for (let x = 0; x < 5; x++) {
      cp[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) tm[x] = cp[(x + 4) % 5] ^ rotl64(cp[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] ^= tm[x];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const lane = x + 5 * y;
        rp[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[lane], ROTATION_OFFSETS[lane]);
      }
    }
    for (let y = 0; y < 5; y++) {
      const row = 5 * y;
      for (let x = 0; x < 5; x++) {
        state[x + row] = rp[x + row] ^ (~rp[((x + 1) % 5) + row] & LANE_MASK & rp[((x + 2) % 5) + row]);
      }
    }
    state[0] ^= ROUND_CONSTANTS[r];
  }
}

describe("DeepSeek PoW Hash Module (noble-hashes Keccak port)", () => {
  it("exports MAX_DEEPSEEK_POW_DIFFICULTY as 250_000", () => {
    expect(MAX_DEEPSEEK_POW_DIFFICULTY).toBe(250_000);
  });

  describe("NIST FIPS 202 SHA3-256 standard vectors (permutation core)", () => {
    it("matches official NIST vectors for 24-round Keccak sponge", () => {
      // Empty string
      const emptySha3 = sha3_256Fips202Reference("");
      expect(emptySha3).toBe("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
      // "abc"
      const abcSha3 = sha3_256Fips202Reference("abc");
      expect(abcSha3).toBe("3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
    });
  });

  describe("DeepSeekHashV1 known-answer vectors (23-round sponge)", () => {
    const knownVectors = [
      { input: "", expected: "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3" },
      { input: "abc", expected: "f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506" },
      { input: "DeepSeek", expected: "59c9e4e5b0871c74c5d3b6351188a74f09431352183ad266cbff901222ac5e0e" },
      { input: "salt_12345_0", expected: "fc04a0e7945fffcc7f9bbf2bc90ba6636308eb28535a144678cd706e55b86c14" },
      { input: "salt_12345_42", expected: "914ed66cf0f75040e91480161f08e0313dee03c0a895e08a0a28b8ebf1194308" },
      { input: "hello world", expected: "d3861d3283d610f532813c30dd15162c6980aed6d34f05aa26caac9baf306f95" },
      { input: "1234567890", expected: "970f8dd219aa4fc0681cd0dd38494678215d23933833734b1213901171ca637f" },
      {
        input: "a".repeat(136),
        expected: "680364b336f77918ed390287a581f96f1371599825acd1e348fa7649fcecbbab",
      },
      {
        input: "test-prefix-for-pow_1730000000_123",
        expected: "822ceb700875a9281acc876bd0383b4190f6a5ee2aba79da9582368446167d5a",
      },
    ];

    for (const { input, expected } of knownVectors) {
      it(`produces expected hash for input "${input.slice(0, 20)}${input.length > 20 ? "..." : ""}"`, () => {
        expect(deepSeekHashV1(input)).toBe(expected);
        expect(referenceKeccak(input, 23)).toBe(expected);
      });
    }
  });

  describe("Differential verification: old clean-room reference vs noble-hashes implementation (>=20 random inputs)", () => {
    it("cross-checks 25 pseudo-random inputs of variable lengths spanning block boundaries", () => {
      const inputs = [
        "short",
        "medium-length-string-for-hash-checking",
        "x".repeat(64),
        "y".repeat(135), // BLOCK - 1
        "z".repeat(136), // exactly BLOCK
        "w".repeat(137), // BLOCK + 1
        "k".repeat(272), // 2 * BLOCK
        "p".repeat(300), // multi-block
        "salt_98765_1730000000_",
        "challenge_payload_with_special_chars_!@#$%^&*()_+",
        "utf8_characters_åäö_日本語_العربية",
        ...Array.from({ length: 14 }, (_, i) => `random_test_input_${i * 7919}_${"q".repeat(i * 17)}`),
      ];

      expect(inputs.length).toBeGreaterThanOrEqual(20);

      for (const inp of inputs) {
        const refHash = referenceKeccak(inp, 23);
        const newHash = deepSeekHashV1(inp);
        expect(newHash).toBe(refHash);

        // Verify findDeepSeekPowNonce solves nonce 0 when target is the hash of (inp + "0")
        const targetZeroHash = deepSeekHashV1(inp + "0");
        const nonceFound = findDeepSeekPowNonce(inp, targetZeroHash, 1);
        expect(nonceFound).toBe(0);
      }
    });
  });

  describe("findDeepSeekPowNonce solver functionality", () => {
    it("finds the correct nonce for a known challenge target", () => {
      const prefix = "ds_pow_salt_1730000000_";
      const targetNonce = 15;
      const targetHash = deepSeekHashV1(prefix + String(targetNonce));

      const solvedNonce = findDeepSeekPowNonce(prefix, targetHash, 50);
      expect(solvedNonce).toBe(targetNonce);
    });

    it("supports case-insensitive challenge hex digests", () => {
      const prefix = "ds_case_test_";
      const targetNonce = 7;
      const lowerHash = deepSeekHashV1(prefix + String(targetNonce));
      const upperHash = lowerHash.toUpperCase();

      expect(findDeepSeekPowNonce(prefix, upperHash, 20)).toBe(targetNonce);
      expect(findDeepSeekPowNonce(prefix, lowerHash, 20)).toBe(targetNonce);
    });

    it("returns -1 when no nonce satisfies the challenge within difficulty ceiling", () => {
      const prefix = "unsolvable_prefix_";
      // Target hash for nonce 999
      const targetHash = deepSeekHashV1(prefix + "999");

      // Search only up to difficulty 50
      const result = findDeepSeekPowNonce(prefix, targetHash, 50);
      expect(result).toBe(-1);
    });

    it("handles multi-block prefixes correctly across 136-byte absorption chunks", () => {
      const longPrefix = "long_prefix_chunk_".repeat(15); // > 250 bytes
      const targetNonce = 3;
      const targetHash = deepSeekHashV1(longPrefix + String(targetNonce));

      const result = findDeepSeekPowNonce(longPrefix, targetHash, 10);
      expect(result).toBe(targetNonce);
    });
  });

  describe("Input validation & security hardening (rejection paths)", () => {
    const validChallenge = "914ed66cf0f75040e91480161f08e0313dee03c0a895e08a0a28b8ebf1194308";

    describe("prefix validation (TypeError)", () => {
      it("throws TypeError if prefix is not a string", () => {
        expect(() => findDeepSeekPowNonce(null, validChallenge, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce(undefined, validChallenge, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce(12345, validChallenge, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce({}, validChallenge, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce([], validChallenge, 10)).toThrow(TypeError);
      });
    });

    describe("challenge validation (TypeError)", () => {
      it("throws TypeError if challenge is not a string", () => {
        expect(() => findDeepSeekPowNonce("salt_", null, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", undefined, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", 12345, 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", {}, 10)).toThrow(TypeError);
      });

      it("throws TypeError if challenge is not a 64-character hex digest", () => {
        // Too short
        expect(() => findDeepSeekPowNonce("salt_", "abcd", 10)).toThrow(TypeError);
        // Too long (65 chars)
        expect(() => findDeepSeekPowNonce("salt_", "a".repeat(65), 10)).toThrow(TypeError);
        // Empty string
        expect(() => findDeepSeekPowNonce("salt_", "", 10)).toThrow(TypeError);
        // Non-hex characters
        expect(() => findDeepSeekPowNonce("salt_", "g".repeat(64), 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", "z".repeat(64), 10)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", "914ed66cf0f75040e91480161f08e0313dee03c0a895e08a0a28b8ebf119430!", 10)).toThrow(TypeError);
      });
    });

    describe("difficulty validation (RangeError / TypeError)", () => {
      it("throws TypeError if difficulty is not a number", () => {
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, "100")).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, null)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, undefined)).toThrow(TypeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, {})).toThrow(TypeError);
      });

      it("throws RangeError if difficulty is not a safe integer or is <= 0", () => {
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, 0)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, -1)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, -100)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, 1.5)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, NaN)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, Infinity)).toThrow(RangeError);
      });

      it("throws RangeError if difficulty exceeds MAX_DEEPSEEK_POW_DIFFICULTY (250_000)", () => {
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, 250_001)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, 1_000_000)).toThrow(RangeError);
        expect(() => findDeepSeekPowNonce("salt_", validChallenge, 10_000_000)).toThrow(RangeError);
      });
    });

    describe("DoS protection: oversized difficulty rejection performance", () => {
      it("rejects oversized difficulty fast (<100ms) without spinning", () => {
        const start = performance.now();
        let thrown = false;
        try {
          findDeepSeekPowNonce("prefix_", validChallenge, 10_000_000);
        } catch (e) {
          thrown = true;
          expect(e).toBeInstanceOf(RangeError);
        }
        const duration = performance.now() - start;
        expect(thrown).toBe(true);
        expect(duration).toBeLessThan(100);
      });
    });
  });

  describe("Backward-compatible helper APIs (solveDeepSeekPow)", () => {
    it("solves challenge via solveDeepSeekPow(algorithm, challenge, salt, difficulty, expireAt)", () => {
      const salt = "my_salt";
      const expireAt = 1730000000;
      const targetNonce = 4;
      const targetHash = deepSeekHashV1(`${salt}_${expireAt}_${targetNonce}`);

      const result = solveDeepSeekPow("DeepSeekHashV1", targetHash, salt, 10, expireAt);
      expect(result).toBe(targetNonce);
    });

    it("rejects unsupported algorithm in solveDeepSeekPow", () => {
      expect(() => solveDeepSeekPow("SHA256", "a".repeat(64), "salt", 10, 1000)).toThrow(TypeError);
    });

    it("rejects invalid salt in solveDeepSeekPow", () => {
      expect(() => solveDeepSeekPow("DeepSeekHashV1", "a".repeat(64), "", 10, 1000)).toThrow(RangeError);
      expect(() => solveDeepSeekPow("DeepSeekHashV1", "a".repeat(64), 123, 10, 1000)).toThrow(TypeError);
    });

    it("rejects invalid expireAt in solveDeepSeekPow", () => {
      expect(() => solveDeepSeekPow("DeepSeekHashV1", "a".repeat(64), "salt", 10, -1)).toThrow(RangeError);
      expect(() => solveDeepSeekPow("DeepSeekHashV1", "a".repeat(64), "salt", 10, "1000")).toThrow(TypeError);
    });
  });
});
