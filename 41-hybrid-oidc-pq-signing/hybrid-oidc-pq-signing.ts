/**
 * Hybrid RSA + Post-Quantum OIDC Token Signing
 *
 * Hardens an existing RS256 OIDC provider against a future quantum adversary
 * without breaking legacy clients. Every ID token carries:
 *
 *   1. A standard RS256 JWT  (header.payload.rsa_sig)         — legacy-verifiable
 *   2. A DETACHED post-quantum signature over that full token — PQ-verifiable
 *
 * The post-quantum keypair is DERIVED deterministically from the RSA key id
 * (`kid`) + a server secret via HKDF. Nothing extra is stored: the PQ key
 * rotates automatically whenever the RSA key rotates, and is fully
 * re-derivable from (kid, secret).
 *
 * The PQ signer is kept behind a small adapter interface (`PqSigner`) so this
 * file RUNS on Node built-ins using an HMAC-based stub. In production you swap
 * in an `@noble/post-quantum` ML-DSA-65 adapter (see README) without changing
 * any of the token plumbing.
 *
 * Dependencies: Node.js built-in "crypto" only (stub signer). Real deployment
 * additionally uses "@noble/post-quantum/ml-dsa.js".
 */

import crypto from "crypto";

// ── Post-quantum signer adapter ───────────────────────────────────────────────
//
// The whole point of the adapter is that the token logic never imports the PQ
// library directly. A real ML-DSA-65 adapter looks like:
//
//   import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
//   const realSigner: PqSigner = {
//     alg: "ML-DSA-65",
//     keygen: (seed) => {
//       const kp = ml_dsa65.keygen(new Uint8Array(seed));
//       return { publicKey: Buffer.from(kp.publicKey), secretKey: Buffer.from(kp.secretKey) };
//     },
//     sign:   (sk, msg) => Buffer.from(ml_dsa65.sign(new Uint8Array(sk), msg)),
//     verify: (pk, msg, sig) => ml_dsa65.verify(new Uint8Array(pk), msg, new Uint8Array(sig)),
//   };

export interface PqSigner {
  alg: string;
  keygen(seed: Buffer): { publicKey: Buffer; secretKey: Buffer };
  sign(secretKey: Buffer, msg: Uint8Array): Buffer;
  verify(publicKey: Buffer, msg: Uint8Array, sig: Buffer): boolean;
}

/**
 * Built-in HMAC stub standing in for ML-DSA-65. It mimics the keygen/sign/verify
 * shape but is SYMMETRIC (HMAC-SHA256) so the file runs without any external
 * dependency: keygen returns the same value as both publicKey and secretKey.
 * NOT post-quantum and NOT asymmetric — for demonstration only. A real ML-DSA-65
 * adapter returns a distinct public key and verifies with signature math.
 */
export function createHmacStubSigner(): PqSigner {
  return {
    alg: "STUB-HMAC-SHA256",
    keygen(seed: Buffer) {
      const key = crypto.createHash("sha256").update(seed).update("pq-stub").digest();
      return { publicKey: key, secretKey: key };
    },
    sign(secretKey: Buffer, msg: Uint8Array) {
      return crypto.createHmac("sha256", secretKey).update(msg).digest();
    },
    verify(publicKey: Buffer, msg: Uint8Array, sig: Buffer) {
      const expected = crypto.createHmac("sha256", publicKey).update(msg).digest();
      return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
    },
  };
}

// ── Deterministic PQ key derivation ───────────────────────────────────────────

/**
 * Derive the post-quantum keypair from (kid, secret). No storage: same inputs
 * always reproduce the same keypair, and rotating the RSA kid rotates this too.
 */
export function derivePqKeyPair(
  signer: PqSigner,
  kid: string,
  secret: string,
): { publicKey: Buffer; secretKey: Buffer; pqKid: string } {
  const seed = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.from(kid), "oidc-pq-v1", 32),
  );
  const kp = signer.keygen(seed);
  return { ...kp, pqKid: `pq-${kid}` };
}

// ── RS256 layer ───────────────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf as never).toString("base64url");
}

export function signIdToken(
  rsaPrivateKey: crypto.KeyObject,
  kid: string,
  payload: Record<string, unknown>,
  expiresInSec = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify({ iat: now, exp: now + expiresInSec, ...payload }));
  const sigInput = `${header}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(sigInput), {
    key: rsaPrivateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${sigInput}.${sig.toString("base64url")}`;
}

/** Legacy verifier: RS256 only. PQ-unaware clients use exactly this path. */
export function verifyRs256(
  token: string,
  rsaPublicKey: crypto.KeyObject,
): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const valid = crypto.verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: rsaPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload["exp"] === "number" && payload["exp"] < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Hybrid signing & verification ─────────────────────────────────────────────

export interface HybridToken {
  idToken: string;   // standard RS256 JWT — legacy clients use only this
  pqSig: string;     // detached PQ signature (hex) over the entire idToken
  pqAlg: string;
  pqKid: string;
}

/**
 * Produce the RS256 JWT plus a detached PQ signature over the full token string.
 * Breaking RSA alone cannot forge a token — the attacker must also forge the PQ
 * signature, whose key is derived from a secret never present in the token.
 */
export function signIdTokenHybrid(opts: {
  rsaPrivateKey: crypto.KeyObject;
  kid: string;
  payload: Record<string, unknown>;
  signer: PqSigner;
  secret: string;
  expiresInSec?: number;
}): HybridToken {
  const idToken = signIdToken(opts.rsaPrivateKey, opts.kid, opts.payload, opts.expiresInSec);
  const { secretKey, pqKid } = derivePqKeyPair(opts.signer, opts.kid, opts.secret);
  const sig = opts.signer.sign(secretKey, new TextEncoder().encode(idToken));
  return { idToken, pqSig: sig.toString("hex"), pqAlg: opts.signer.alg, pqKid };
}

/**
 * Full hybrid verification. Confirms BOTH the RS256 signature and the detached
 * PQ signature. Returns the decoded payload only when both layers pass.
 */
export function verifyHybrid(
  hybrid: HybridToken,
  rsaPublicKey: crypto.KeyObject,
  signer: PqSigner,
  pqPublicKey: Buffer,
): { ok: boolean; rsaValid: boolean; pqValid: boolean; payload: Record<string, unknown> | null } {
  const payload = verifyRs256(hybrid.idToken, rsaPublicKey);
  const rsaValid = payload !== null;
  const pqValid = signer.verify(
    pqPublicKey,
    new TextEncoder().encode(hybrid.idToken),
    Buffer.from(hybrid.pqSig, "hex"),
  );
  return { ok: rsaValid && pqValid, rsaValid, pqValid, payload: rsaValid && pqValid ? payload : null };
}

// ── JWKS publication ──────────────────────────────────────────────────────────

/**
 * Build a JWKS document advertising both the RSA public key (RS256) and the PQ
 * public key (draft JOSE "PQK" representation). PQ-aware relying parties pick up
 * the extra key; legacy clients simply ignore the unknown `kty`.
 */
export function getJwks(opts: {
  rsaPublicKey: crypto.KeyObject;
  kid: string;
  pqPublicKey: Buffer;
  pqKid: string;
  pqAlg: string;
}): { keys: Record<string, unknown>[] } {
  const rsaJwk = opts.rsaPublicKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    keys: [
      { ...rsaJwk, use: "sig", kid: opts.kid, alg: "RS256" },
      { kty: "PQK", alg: opts.pqAlg, use: "sig", kid: opts.pqKid, x: opts.pqPublicKey.toString("base64url") },
    ],
  };
}

// ── Extension: relative redirect-URI same-origin validator ─────────────────────
//
// A registered redirect URI may be stored as a relative path ("/app/"). An
// incoming absolute URI is then accepted ONLY if it shares the server's origin
// (scheme + host + port). This blocks cross-origin code delivery:
// "https://evil.example/app/" must NOT match a stored "/app/".

export function redirectUriMatches(
  stored: string,
  incoming: string,
  serverOrigin?: string,
): boolean {
  // Absolute stored URI: exact string match.
  if (/^https?:\/\//i.test(stored)) return stored === incoming;
  // Relative stored URI: require a known origin and same-origin incoming URI.
  if (!serverOrigin) return false;
  try {
    const incomingUrl = new URL(incoming);
    const allowedUrl = new URL(serverOrigin);
    const sameOrigin =
      incomingUrl.protocol === allowedUrl.protocol &&
      incomingUrl.hostname === allowedUrl.hostname &&
      incomingUrl.port === allowedUrl.port;
    return sameOrigin && incomingUrl.pathname === stored;
  } catch {
    return false;
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `rsa-${Math.floor(Date.now() / 1000).toString(36)}`;
  const secret = "demo-session-secret";
  const signer = createHmacStubSigner();

  const { publicKey: pqPub, pqKid } = derivePqKeyPair(signer, kid, secret);

  console.log("=== Hybrid RSA + PQ OIDC token ===");
  const hybrid = signIdTokenHybrid({ rsaPrivateKey: privateKey, kid, payload: { sub: "alice", scope: "openid" }, signer, secret });
  console.log("idToken (truncated):", hybrid.idToken.slice(0, 48) + "...");
  console.log("pqAlg / pqKid     :", hybrid.pqAlg, "/", hybrid.pqKid);
  console.log("pqSig (truncated) :", hybrid.pqSig.slice(0, 32) + "...");

  console.log("\n=== Legacy RS256-only client ===");
  const legacy = verifyRs256(hybrid.idToken, publicKey);
  console.log("RS256 payload:", legacy);

  console.log("\n=== PQ-aware client (full hybrid verify) ===");
  console.log(verifyHybrid(hybrid, publicKey, signer, pqPub));

  console.log("\n=== Tamper detection (flip one PQ-sig byte) ===");
  const tampered: HybridToken = { ...hybrid, pqSig: (hybrid.pqSig[0] === "a" ? "b" : "a") + hybrid.pqSig.slice(1) };
  console.log(verifyHybrid(tampered, publicKey, signer, pqPub));

  console.log("\n=== JWKS ===");
  const jwks = getJwks({ rsaPublicKey: publicKey, kid, pqPublicKey: pqPub, pqKid, pqAlg: signer.alg });
  console.log(JSON.stringify(jwks.keys.map((k) => ({ kty: k["kty"], alg: k["alg"], kid: k["kid"] })), null, 2));

  console.log("\n=== Redirect-URI same-origin validator ===");
  const origin = "https://app.example";
  console.log('stored "/app/" + incoming https://app.example/app/ :', redirectUriMatches("/app/", "https://app.example/app/", origin));
  console.log('stored "/app/" + incoming https://evil.example/app/:', redirectUriMatches("/app/", "https://evil.example/app/", origin));
}
