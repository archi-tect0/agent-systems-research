/**
 * Fibonacci-Harmonic Key Derivation Function (FH-KDF)
 *
 * A pre-conditioning layer applied before post-quantum key generation or
 * Shamir secret-shard expansion. Adds diffusion between the raw input key
 * material and the downstream operation without sacrificing the provable
 * security of standard HKDF.
 *
 * Algorithm overview:
 *   1. HKDF-SHA256 extract+expand → 64-byte base state  (domain: "fhkdf-v2-init")
 *   2. Reverse-Fibonacci permutation on the 64-byte state
 *   3. 8-round harmonic mixing using Q16 fixed-point integer arithmetic
 *      (each round followed by SHA-256 XOR avalanche diffusion)
 *   4. HKDF-SHA256 expand on the mixed state                (domain: "fhkdf-v2-final")
 *
 * Security sandwich: even if the custom passes have an unknown linear bias,
 * the final HKDF output is cryptographically bound by HMAC-SHA256.
 *
 * Dependencies: Node.js built-in "crypto" module only.
 */

import crypto from "crypto";

const STATE_LEN = 64;   // internal state size in bytes
const Q16       = 0x10000; // 65 536 — scale factor for Q16 fixed-point weights

// ── Step 1: Fibonacci permutation ─────────────────────────────────────────────

/**
 * Generate Fibonacci numbers up to maxVal (inclusive).
 * Example for maxVal=63: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55]
 */
function fibSequence(maxVal: number): number[] {
  const fibs: number[] = [1, 1];
  for (;;) {
    const next = fibs[fibs.length - 1] + fibs[fibs.length - 2];
    if (next > maxVal) break;
    fibs.push(next);
  }
  return fibs;
}

/**
 * Reverse-Fibonacci permutation.
 *
 * Generates the Fibonacci sequence up to STATE_LEN-1, reverses it, then
 * performs pair-wise byte swaps using the reversed indices (mod STATE_LEN).
 *
 * Purpose: break the contiguous byte-position regularity in the state
 * before harmonic mixing begins. The reversed Fibonacci index distribution
 * is non-uniform (denser near high values), which prevents the permutation
 * from accidentally re-creating a near-identity arrangement.
 */
function reverseFibPermutation(state: Buffer): Buffer {
  const out    = Buffer.from(state);
  const revFib = fibSequence(STATE_LEN - 1).reverse();
  for (let i = 0; i + 1 < revFib.length; i += 2) {
    const a = revFib[i]     % STATE_LEN;
    const b = revFib[i + 1] % STATE_LEN;
    if (a !== b) {
      const tmp = out[a];
      out[a]    = out[b];
      out[b]    = tmp;
    }
  }
  return out;
}

// ── Step 2: Harmonic mixing ────────────────────────────────────────────────────

/**
 * 8-round harmonic mixing with Q16 fixed-point arithmetic.
 *
 * Round r applies weight W = floor(65536 / r) (decreasing each round):
 *   next[i] = (cur[i]*W + cur[(i+1)%64]*(65536-W) + 32768) >> 16
 *
 * The +32768 (0x8000) implements round-half-up without any floating-point.
 * Results are bit-identical across all JS engines and CPU architectures.
 *
 * After each round: XOR with SHA-256(round_byte || pre-mix state) for avalanche.
 * This ensures every output byte depends on all input bytes through the hash.
 */
function harmonicMixRounds(state: Buffer, rounds: number): Buffer {
  let cur = Buffer.from(state);
  for (let r = 1; r <= rounds; r++) {
    const W  = (Q16 / r) | 0;   // integer division — platform-invariant
    const NW = Q16 - W;
    const next = Buffer.alloc(STATE_LEN);

    for (let i = 0; i < STATE_LEN; i++) {
      next[i] = ((cur[i] * W + cur[(i + 1) % STATE_LEN] * NW + 0x8000) >> 16) & 0xff;
    }

    // Avalanche: XOR with SHA-256(r || pre-mix state)
    const digest = crypto
      .createHash("sha256")
      .update(Buffer.from([r]))
      .update(cur)
      .digest();
    for (let i = 0; i < STATE_LEN; i++) {
      next[i] = (next[i] ^ digest[i % 32]) & 0xff;
    }
    cur = next;
  }
  return cur;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * FH-KDF — derive up to 64 bytes of hardened key material.
 *
 * @param ikm         Input key material (the raw secret)
 * @param salt        Domain salt — should be unique per use-case
 * @param info        Domain-separation string (e.g. "pq-keygen-v1")
 * @param outputBytes Number of bytes to derive (max 64)
 */
export function fhKdf(
  ikm:         Buffer,
  salt:        Buffer,
  info:        string,
  outputBytes: number,
): Uint8Array {
  if (outputBytes > STATE_LEN) {
    throw new Error(`fhKdf: single-call cap is ${STATE_LEN} bytes — use fhKdfExpand for larger outputs`);
  }

  // Security sandwich step 1: standard HKDF extract+expand → 64-byte base state
  const base = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, `fhkdf-v2-init:${info}`, STATE_LEN)
  );

  // Diffusion passes
  const permuted = reverseFibPermutation(base);
  const mixed    = harmonicMixRounds(permuted, 8);

  // Security sandwich step 2: HKDF-expand on mixed state — binds output to original domain
  return new Uint8Array(
    Buffer.from(crypto.hkdfSync("sha256", mixed, salt, `fhkdf-v2-final:${info}`, outputBytes))
  );
}

/**
 * FH-KDF expand — arbitrary output length, chunked in 64-byte blocks.
 * Each block uses a distinct info suffix so blocks are independent.
 *
 * @param ikm         Input key material
 * @param salt        Domain salt
 * @param info        Base domain-separation string
 * @param outputBytes Total bytes to derive
 */
export function fhKdfExpand(
  ikm:         Buffer,
  salt:        Buffer,
  info:        string,
  outputBytes: number,
): Uint8Array {
  const result = new Uint8Array(outputBytes);
  let offset = 0;
  let chunk  = 0;
  while (offset < outputBytes) {
    const size  = Math.min(STATE_LEN, outputBytes - offset);
    const block = fhKdf(ikm, salt, `${info}:c${chunk}`, size);
    result.set(block, offset);
    offset += size;
    chunk++;
  }
  return result;
}

// ── Example usage ──────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const masterSecret = crypto.randomBytes(32);
  const salt         = Buffer.from("my-application-salt-v1");

  // Derive 32 bytes for post-quantum seed hardening
  const pqSeed = fhKdf(masterSecret, salt, "pq-keygen-v1", 32);
  console.log("PQ seed (32 bytes):", Buffer.from(pqSeed).toString("hex"));

  // Derive 96 bytes for Shamir shard expansion
  const shardKey = fhKdfExpand(masterSecret, salt, "shard-expansion-v1", 96);
  console.log("Shard key (96 bytes):", Buffer.from(shardKey).toString("hex"));

  // Verify determinism: same inputs → same outputs
  const pqSeed2 = fhKdf(masterSecret, salt, "pq-keygen-v1", 32);
  console.log("Deterministic:", Buffer.from(pqSeed).equals(Buffer.from(pqSeed2)));
}
