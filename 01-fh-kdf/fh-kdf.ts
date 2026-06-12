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
 *   2. Seeded full-block (Fisher-Yates) permutation on the 64-byte state
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

// ── Step 1: Seeded full-block permutation ─────────────────────────────────────

/**
 * Seeded Fisher-Yates permutation over the entire 64-byte state.
 *
 * The swap order is derived deterministically from the state itself via a
 * SHA-256 keystream in counter mode, so the permutation is platform-invariant
 * (integer ops + SHA-256 only) yet still touches every byte position.
 *
 * Purpose: break the contiguous byte-position regularity in the state before
 * harmonic mixing begins. Unlike a fixed index list (e.g. a reversed Fibonacci
 * sequence, whose terms grow too fast to cover the block), a keyed Fisher-Yates
 * pass visits all 64 indices, so no contiguous run of bytes is left in place
 * for a side-channel attacker to track.
 */
function keyedPermutation(state: Buffer): Buffer {
  const out = Buffer.from(state);

  // Deterministic keystream: SHA-256("fhkdf-v2-perm" || state || counter)
  let pool    = Buffer.alloc(0);
  let cursor  = 0;
  let counter = 0;
  const nextByte = (): number => {
    if (cursor >= pool.length) {
      pool = crypto
        .createHash("sha256")
        .update("fhkdf-v2-perm")
        .update(state)
        .update(Buffer.from([
          (counter >>> 24) & 0xff,
          (counter >>> 16) & 0xff,
          (counter >>> 8)  & 0xff,
          counter          & 0xff,
        ]))
        .digest();
      counter++;
      cursor = 0;
    }
    return pool[cursor++];
  };

  // Fisher-Yates: for i from STATE_LEN-1 down to 1, swap out[i] with out[j], j in [0, i]
  for (let i = STATE_LEN - 1; i > 0; i--) {
    const r   = (nextByte() << 8) | nextByte();   // 16 bits of entropy per draw
    const j   = r % (i + 1);
    const tmp = out[i];
    out[i]    = out[j];
    out[j]    = tmp;
  }
  return out;
}

// ── Step 2: Harmonic mixing ────────────────────────────────────────────────────

/**
 * 8-round harmonic mixing with Q16 fixed-point arithmetic.
 *
 * Round r applies a harmonic neighbor weight NW = floor(65536 / r) (decreasing
 * each round) and a self weight W = 65536 - NW (growing toward 65536):
 *   next[i] = (cur[i]*W + cur[(i+1)%64]*NW + 32768) >> 16
 *
 * Early rounds blend neighbors heavily (r=1 → NW=65536, full neighbor pull),
 * later rounds only fine-tune (r=8 → NW=8192, light blend). This is the
 * decaying-dispersion behaviour the design intends; tying the harmonic term to
 * the neighbor weight also avoids the degenerate r=1 "no blend" case that a
 * decreasing self weight would produce.
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
    const NW = (Q16 / r) | 0;   // neighbor weight — harmonic decay (heavy early, light late)
    const W  = Q16 - NW;        // self weight — grows toward 65536, platform-invariant
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
  const permuted = keyedPermutation(base);
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
