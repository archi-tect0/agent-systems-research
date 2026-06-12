/**
 * Post-Quantum HKDF (HKDF-SHA3-256)
 *
 * RFC 5869 HKDF using SHA3-256 (Keccak sponge) instead of SHA-256 (Merkle-Damgård).
 *
 * Why SHA3-256?
 *   - Structurally independent from SHA-1/SHA-2: a cryptanalytic break in the
 *     Merkle-Damgård family does not affect Keccak.
 *   - 128-bit post-quantum security (Grover's algorithm halves 256-bit output → 128-bit PQ).
 *   - NIST-standardized (FIPS 202), available in Node.js crypto as "sha3-256".
 *
 * Dependencies: Node.js built-in "crypto" module only.
 */

import { createHmac } from "node:crypto";

const HASH_ALG = "sha3-256";
const HASH_LEN = 32; // SHA3-256 output: 32 bytes

// ── RFC 5869 extract step ──────────────────────────────────────────────────────
// Converts arbitrary-length IKM into a fixed-length pseudorandom key (PRK).
// If salt is empty, use a zero-filled block of HASH_LEN bytes (per RFC 5869 §2.2).
function extract(ikm: Buffer, salt: Buffer): Buffer {
  const s = salt.length > 0 ? salt : Buffer.alloc(HASH_LEN, 0);
  return createHmac(HASH_ALG, s).update(ikm).digest();
}

// ── RFC 5869 expand step ───────────────────────────────────────────────────────
// Derives `len` bytes of output keying material from the PRK.
// T(i) = HMAC-SHA3-256(PRK, T(i-1) || Info || counter_byte(i))
function expand(prk: Buffer, info: Buffer, len: number): Buffer {
  const n      = Math.ceil(len / HASH_LEN);
  let   t      = Buffer.alloc(0);
  const chunks: Buffer[] = [];

  for (let i = 1; i <= n; i++) {
    t = createHmac(HASH_ALG, prk)
      .update(t)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    chunks.push(t);
  }

  return Buffer.concat(chunks).subarray(0, len);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * HKDF-SHA3-256 key derivation.
 *
 * Drop-in replacement for `hkdfSync("sha256", ...)` with structural independence
 * from the SHA-2 family and 128-bit post-quantum security.
 *
 * @param ikm    Input key material (the raw secret — Buffer or hex string)
 * @param salt   Domain salt (string or Buffer; empty string → zero-filled salt)
 * @param info   Domain-separation label (e.g. "vault-key-v2")
 * @param len    Output length in bytes (max 255 * 32 = 8160)
 * @returns      Derived key as Buffer
 */
export function pqHkdf(
  ikm:  Buffer | string,
  salt: Buffer | string,
  info: string,
  len:  number,
): Buffer {
  if (len < 1 || len > 255 * HASH_LEN) {
    throw new RangeError(`pqHkdf: output length must be 1–${255 * HASH_LEN} bytes`);
  }
  const ikmBuf  = typeof ikm  === "string" ? Buffer.from(ikm,  "utf8") : ikm;
  const saltBuf = typeof salt === "string" ? Buffer.from(salt, "utf8") : salt;
  const prk     = extract(ikmBuf, saltBuf);
  return expand(prk, Buffer.from(info, "utf8"), len);
}

// ── Test vectors ───────────────────────────────────────────────────────────────
// Run with: node --loader ts-node/esm pq-hkdf.ts --test
if (process.argv[2] === "--test") {
  // Verify determinism and domain separation
  const secret = Buffer.from("test-master-secret");
  const salt   = "test-salt-v1";

  const k1 = pqHkdf(secret, salt, "domain-a", 32);
  const k2 = pqHkdf(secret, salt, "domain-a", 32);
  const k3 = pqHkdf(secret, salt, "domain-b", 32);

  console.log("domain-a (1st call):", k1.toString("hex"));
  console.log("domain-a (2nd call):", k2.toString("hex"));
  console.log("domain-b          :", k3.toString("hex"));
  console.log("Deterministic:", k1.equals(k2));
  console.log("Domain-separated:", !k1.equals(k3));

  // Verify output lengths
  const k64  = pqHkdf(secret, salt, "domain-a", 64);
  const k128 = pqHkdf(secret, salt, "domain-a", 128);
  console.log("64-byte output length OK :", k64.length  === 64);
  console.log("128-byte output length OK:", k128.length === 128);
}

// ── Example: vault key derivation ─────────────────────────────────────────────
if (process.argv[2] === "--demo") {
  import("node:crypto").then(({ randomBytes }) => {
    const masterSecret = randomBytes(32);

    // Derive separate keys for encryption and signing from the same master secret
    const encKey  = pqHkdf(masterSecret, "vault-v2", "aes-encryption-key",  32);
    const authKey = pqHkdf(masterSecret, "vault-v2", "hmac-auth-key",        32);
    const idKey   = pqHkdf(masterSecret, "vault-v2", "identity-root",        64);

    console.log("Encryption key:", encKey.toString("hex"));
    console.log("Auth key:      ", authKey.toString("hex"));
    console.log("Identity root: ", idKey.toString("hex"));
    console.log("All keys different:", !encKey.equals(authKey) && !encKey.equals(idKey.subarray(0, 32)));
  });
}
