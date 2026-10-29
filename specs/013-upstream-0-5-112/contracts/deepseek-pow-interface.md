# Contract: DeepSeek PoW Hash Module Interface

## 1. Scope & Objective
This contract establishes the formal module boundary and interface contract for `open-sse/lib/deepseek-pow-hash.js`. 

In upstream v0.5.112 (commit `d7bb71ce`), the proof-of-work hash algorithm was replaced with an inlined Keccak implementation derived from `@noble/hashes`. However, upstream dropped input validation safeguards. This contract defines the public exports, input constraints, computational guarantees, and the interface boundary for consumption by **Spec 015 (Web-Cookie Providers)**.

---

## 2. Public API Exports

```javascript
/**
 * Maximum permitted difficulty ceiling for the nonce search.
 * Protects server threads against CPU exhaustion / unbounded loops.
 */
export const MAX_DEEPSEEK_POW_DIFFICULTY = 250_000;

/**
 * Searches for an integer nonce in [0, difficulty) such that:
 *   DeepSeekHashV1(prefix + String(nonce)) == challenge (case-insensitive hex match)
 *
 * @param {string} prefix - Challenge salt/prefix string
 * @param {string} challenge - 64-character hex target digest
 * @param {number} difficulty - Search ceiling (integer in [1, 250000])
 * @returns {number} Nonce integer if solved; -1 if no candidate matched in the range
 * @throws {TypeError} If prefix is not a string or challenge is not 64 hex characters
 * @throws {RangeError} If difficulty is not a safe integer in [1, MAX_DEEPSEEK_POW_DIFFICULTY]
 */
export function findDeepSeekPowNonce(prefix, challenge, difficulty);
```

---

## 3. Algorithm & Cryptographic Invariants

1. **Hash Construction (`DeepSeekHashV1`)**:
   - Implements Keccak sponge permutation $\text{KECCAK-}p[1600, 24]$.
   - Matches NIST FIPS 202 SHA3-256 with rate $r = 1088\text{ bits} = 136\text{ bytes}$ and capacity $c = 512\text{ bits} = 64\text{ bytes}$, domain suffix `0x06`.
   - **Critical Variant**: Round 0 is skipped; only the final 23 rounds (rounds 1 through 23) are computed.
2. **Deterministic Output**:
   - The same `(prefix, challenge, difficulty)` tuple produces an identical nonce across all platforms (Linux x64, ARM64, macOS, Windows).
   - The solver validates nonces strictly sequentially from $0$ up to $\text{difficulty} - 1$.
3. **Pure JavaScript**:
   - Implemented with typed arrays (`Uint32Array`) and bitwise operations.
   - Zero external npm or native dependencies; zero Node-specific bindings.

---

## 4. Input Validation & Defense-in-Depth Contract

| Parameter | Type / Format Requirement | Failure Behavior |
|---|---|---|
| `prefix` | `typeof prefix === "string"` | `throw new TypeError("DeepSeek PoW prefix must be a string")` |
| `challenge` | `typeof challenge === "string" && /^[0-9a-fA-F]{64}$/.test(challenge)` | `throw new TypeError("DeepSeek PoW challenge must be a 64-character hex digest")` |
| `difficulty` | `Number.isSafeInteger(difficulty) && difficulty >= 1 && difficulty <= 250000` | `throw new RangeError("DeepSeek PoW difficulty must be an integer from 1 to 250000")` |

---

## 5. Downstream Consumer Boundary (Spec 015)
- In Spec 013, `open-sse/lib/deepseek-pow-hash.js` is delivered as a verified library accompanied by exhaustive unit tests in `tests/unit/deepseek-pow-hash.test.js`.
- It remains unreferenced by existing API providers in Spec 013.
- Spec 015 (Web-Cookie Providers) will import `findDeepSeekPowNonce` directly into the `deepseek-web` executor to solve browser session login and completion challenges.
