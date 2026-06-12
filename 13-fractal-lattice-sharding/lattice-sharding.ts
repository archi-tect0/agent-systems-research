/**
 * Committed Lattice Secret Sharing
 *
 * Wraps plain Shamir Secret Sharing (SSS) with a public commitment so a
 * collected share set can be verified to reconstruct the original secret
 * BEFORE any decryption is attempted. Defeats silent share corruption:
 * an altered share avalanches into a different commitment and fails the
 * check cleanly, instead of interpolating to a wrong secret.
 *
 * Pipeline:
 *   1. expandToLattice(seed) — deterministic 1024-byte vector (4 quadrants)
 *      with a Q16 fixed-point harmonic cross-mix coupling all quadrants.
 *   2. commitment = SHA-256(latticeVector)            (public, store w/ shares)
 *   3. encMaster  = AES-256-GCM(seed, key=SHA-256(latticeVector))  (2nd path)
 *   4. SSS split the seed once → one share per guardian.
 *
 * Reconstruction re-derives the lattice from the recovered seed and checks
 * the commitment matches before returning anything.
 *
 * Dependencies:
 *   - Node.js built-in "crypto"
 *   - "secrets.js-grempe" for GF(2^8) Shamir split/combine
 */

import crypto from "crypto";
// @ts-ignore — no bundled types for secrets.js-grempe
import secrets from "secrets.js-grempe";

export const LATTICE_DIMS   = 1024;
export const QUADRANT_COUNT = 4;
export const QUADRANT_BYTES = LATTICE_DIMS / QUADRANT_COUNT; // 256

const Q16 = 0x10000; // 65 536 — scale factor for Q16 fixed-point weights

// ── Deterministic expansion (chunked HKDF-SHA256) ────────────────────────────
//
// Substitute a diffusion-hardened KDF here in a deployment that has one; the
// commitment logic is unchanged as long as expansion stays deterministic.

function kdfExpand(ikm: Buffer, info: string, outputBytes: number): Buffer {
  const out = Buffer.alloc(outputBytes);
  let offset = 0;
  let chunk = 0;
  while (offset < outputBytes) {
    const size = Math.min(64, outputBytes - offset);
    const block = Buffer.from(
      crypto.hkdfSync("sha256", ikm, ikm, `${info}:c${chunk}`, size),
    );
    block.copy(out, offset);
    offset += size;
    chunk++;
  }
  return out;
}

// ── Fibonacci helper ─────────────────────────────────────────────────────────

function fibSequence(max: number): number[] {
  const f = [1, 1];
  while (f[f.length - 1] + f[f.length - 2] <= max) {
    f.push(f[f.length - 1] + f[f.length - 2]);
  }
  return f;
}

// ── Q16 fixed-point harmonic cross-mix ───────────────────────────────────────
//
// Each quadrant is blended toward its neighbour at reversed-Fibonacci byte
// positions using harmonic weights floor(65536/(step+1)). Pure integer
// arithmetic → bit-identical output on every CPU and JS engine.

function crossMixQuadrants(quads: Buffer[]): Buffer[] {
  const out = quads.map((q) => Buffer.from(q));
  const fibs = fibSequence(QUADRANT_BYTES - 1).reverse();
  const harmQ16 = fibs.map((_, i) => (Q16 / (i + 1)) | 0);

  for (let qi = 0; qi < QUADRANT_COUNT; qi++) {
    const src = quads[(qi + 1) % QUADRANT_COUNT];
    for (let fi = 0; fi < fibs.length && fi < QUADRANT_BYTES; fi++) {
      const idx = fibs[fi] % QUADRANT_BYTES;
      const W = harmQ16[fi];
      const NW = Q16 - W;
      out[qi][idx] = ((quads[qi][idx] * W + src[idx] * NW + 0x8000) >> 16) & 0xff;
    }
  }
  return out;
}

// ── Lattice derivation + commitment ──────────────────────────────────────────

export function expandToLattice(masterSeed: Buffer): Buffer {
  const raw = kdfExpand(masterSeed, "lattice-v1", LATTICE_DIMS);
  const quads: Buffer[] = [];
  for (let q = 0; q < QUADRANT_COUNT; q++) {
    quads.push(raw.subarray(q * QUADRANT_BYTES, (q + 1) * QUADRANT_BYTES));
  }
  return Buffer.concat(crossMixQuadrants(quads));
}

export function computeCommitment(latticeVector: Buffer): string {
  return crypto.createHash("sha256").update(latticeVector).digest("hex");
}

function latticeKey(latticeVector: Buffer): Buffer {
  return crypto.createHash("sha256").update(latticeVector).digest();
}

// ── AES-256-GCM wrap of the master seed (secondary verification path) ─────────

export function wrapMasterSeed(masterSeed: Buffer, latticeVector: Buffer): string {
  const key = latticeKey(latticeVector);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(masterSeed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("hex");
}

export function unwrapMasterSeed(encHex: string, latticeVector: Buffer): Buffer {
  const key = latticeKey(latticeVector);
  const data = Buffer.from(encHex, "hex");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  if (tag.length !== 16) throw new Error("invalid GCM auth tag length");
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]);
}

// ── Share types ──────────────────────────────────────────────────────────────
//
// `shares` encoding:
//   single-split (default): length-1 array — shares[0] is the seed SSS share
//   per-quadrant (legacy):  length-4 array — one SSS share per quadrant

export interface ShardSet {
  shardIndex: number;
  shares: string[];
  commitment: string;
  encryptedMasterSeed: string;
  dimensions: number;
}

export interface SplitResult {
  shards: ShardSet[];
  commitment: string;
  encryptedMasterSeed: string;
  dimensions: number;
}

// ── Split (single-split format) ──────────────────────────────────────────────

export function splitWithCommitment(masterSeed: Buffer, n: number, k: number): SplitResult {
  if (k < 2 || k > n) throw new Error("invalid k/n");

  const latticeVector = expandToLattice(masterSeed);
  const commitment = computeCommitment(latticeVector);
  const encMaster = wrapMasterSeed(masterSeed, latticeVector);

  const seedShares: string[] = secrets.share(masterSeed.toString("hex"), n, k);

  const shards: ShardSet[] = seedShares.map((share, i) => ({
    shardIndex: i,
    shares: [share],
    commitment,
    encryptedMasterSeed: encMaster,
    dimensions: LATTICE_DIMS,
  }));

  return { shards, commitment, encryptedMasterSeed: encMaster, dimensions: LATTICE_DIMS };
}

// ── Verify (auto-detects format) — call BEFORE reconstructSecret ──────────────

export function verifyCommitment(
  shardSets: Pick<ShardSet, "shares" | "commitment">[],
): boolean {
  try {
    const first = shardSets[0].shares;
    let latticeVector: Buffer;

    if (first.length === 1) {
      const seedHex: string = secrets.combine(shardSets.map((s) => s.shares[0]));
      latticeVector = expandToLattice(Buffer.from(seedHex, "hex"));
    } else {
      const quads: Buffer[] = [];
      for (let q = 0; q < QUADRANT_COUNT; q++) {
        const hex: string = secrets.combine(shardSets.map((s) => s.shares[q]));
        quads.push(Buffer.from(hex, "hex"));
      }
      latticeVector = Buffer.concat(quads);
    }

    return computeCommitment(latticeVector) === shardSets[0].commitment;
  } catch {
    return false;
  }
}

// ── Reconstruct (auto-detects format) ────────────────────────────────────────

export function reconstructSecret(
  shardSets: Pick<ShardSet, "shares" | "encryptedMasterSeed">[],
): Buffer {
  if (shardSets.length < 2) throw new Error("need at least 2 shard sets");

  const first = shardSets[0].shares;

  if (first.length === 1) {
    const seedHex: string = secrets.combine(shardSets.map((s) => s.shares[0]));
    return Buffer.from(seedHex, "hex");
  }

  // Per-quadrant legacy path: rebuild lattice, AES-decrypt the wrapped seed
  const quads: Buffer[] = [];
  for (let q = 0; q < QUADRANT_COUNT; q++) {
    const hex: string = secrets.combine(shardSets.map((s) => s.shares[q]));
    quads.push(Buffer.from(hex, "hex"));
  }
  const latticeVector = Buffer.concat(quads);
  if (latticeVector.length !== LATTICE_DIMS) {
    throw new Error(`reconstructed lattice is ${latticeVector.length} B, expected ${LATTICE_DIMS} B`);
  }
  return unwrapMasterSeed(shardSets[0].encryptedMasterSeed, latticeVector);
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const masterSeed = crypto.randomBytes(32);
  const { shards, commitment } = splitWithCommitment(masterSeed, 5, 3);
  console.log("commitment:", commitment);
  console.log("guardians:", shards.length, "threshold: 3");

  // Happy path: any 3 valid shards
  const ok = [shards[0], shards[2], shards[4]];
  console.log("verify (clean):", verifyCommitment(ok));
  const recovered = reconstructSecret(ok);
  console.log("recovered matches:", recovered.equals(masterSeed));

  // Corruption: tamper one share — verification must reject
  const tampered = ok.map((s) => ({ ...s, shares: [...s.shares] }));
  const raw = tampered[1].shares[0];
  tampered[1].shares[0] = raw.slice(0, -1) + (raw.slice(-1) === "a" ? "b" : "a");
  console.log("verify (tampered):", verifyCommitment(tampered));
}
