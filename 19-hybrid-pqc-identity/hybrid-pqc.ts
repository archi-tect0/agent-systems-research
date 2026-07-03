/**
 * Hybrid Post-Quantum Identity
 *
 * Zero-interaction, deterministically-derived post-quantum keypairs layered
 * on top of classical ECDSA/RSA so receipts and OIDC tokens stay verifiable
 * by legacy verifiers while gaining quantum resistance for PQ-aware ones.
 *
 *   - autoEnrollPqKeys()    : idempotent enrollment of ML-DSA-65 + SLH-DSA.
 *   - signHybridReceipt()   : classical ECDSA sig + detached PQ sig.
 *   - verifyHybridReceipt() : graceful degradation during migration.
 *   - signIdTokenHybrid()   : RS256 JWT + detached ML-DSA sig over the token.
 *
 * Keys are derived from SERVER_SECRET + account (never stored as plaintext);
 * only an AES-256-GCM-encrypted secret key is persisted, and even that is
 * re-derivable from the same inputs.
 *
 * Dependencies:
 *   - "@noble/post-quantum/ml-dsa.js"  (ml_dsa65)
 *   - "@noble/post-quantum/slh-dsa.js" (slh_dsa_sha2_128s)
 *   - Node.js built-in "crypto"
 */

import crypto from "crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";

// In production this comes from a secret manager. Stable: rotating it breaks
// re-derivation of every account's PQ key.
const SERVER_SECRET = Buffer.from(
  process.env.PQ_SERVER_SECRET ?? "0".repeat(64),
  "hex",
);

export type PqAlg = "ML-DSA-65" | "SLH-DSA-SHA2-128s";

const ALGS: Record<PqAlg, { seedLen: number;
                            keygen: (seed: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
                            sign: (sk: Uint8Array, msg: Uint8Array) => Uint8Array;
                            verify: (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean; }> = {
  "ML-DSA-65": {
    seedLen: 32, // ml_dsa65.lengths.seed
    keygen: (s) => ml_dsa65.keygen(s),
    // @noble/post-quantum's sign/verify take (message, key), not (key, message) —
    // reordered here so the rest of this file can use a consistent (key, message) wrapper.
    sign: (sk, m) => ml_dsa65.sign(m, sk),
    verify: (pk, m, sig) => ml_dsa65.verify(sig, m, pk),
  },
  "SLH-DSA-SHA2-128s": {
    seedLen: 48, // slh_dsa_sha2_128s.lengths.seed — NOT 32; differs from ML-DSA
    keygen: (s) => slh_dsa_sha2_128s.keygen(s),
    sign: (sk, m) => slh_dsa_sha2_128s.sign(m, sk),
    verify: (pk, m, sig) => slh_dsa_sha2_128s.verify(sig, m, pk),
  },
};

// ── Key derivation ───────────────────────────────────────────────────────────
//
// hardenedKdf stubs the diffusion-hardened KDF from guide 01 — swap it in for
// real side-channel hardening between the raw secret and keygen.

function hardenedKdf(account: string, info: string, bytes: number): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", SERVER_SECRET, Buffer.from(account), info, bytes),
  );
}

function keygenFor(account: string, alg: PqAlg) {
  // Seed length is algorithm-specific — ML-DSA-65 wants 32 bytes, SLH-DSA-SHA2-128s
  // wants 48. Using a fixed length for both throws a length-mismatch error.
  const seed = hardenedKdf(account, `pq-seed:${alg}:v1`, ALGS[alg].seedLen);
  return ALGS[alg].keygen(new Uint8Array(seed));
}

function kekFor(account: string): Buffer {
  return hardenedKdf(account, "pq-key", 32);
}

// ── AES-256-GCM at rest ──────────────────────────────────────────────────────

function encryptSecretKey(sk: Uint8Array, kek: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(sk)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("hex");
}

function decryptSecretKey(encHex: string, kek: Buffer): Uint8Array {
  const data = Buffer.from(encHex, "hex");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const dec = crypto.createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
  dec.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([dec.update(data.subarray(28)), dec.final()]));
}

// ── Persistence interface (wire to your DB) ──────────────────────────────────

export interface PqKeyRecord {
  account: string;
  alg: PqAlg;
  publicKey: string;       // hex
  encryptedSecretKey: string;
  active: boolean;
}
export interface PqKeyStore {
  get(account: string, alg: PqAlg): Promise<PqKeyRecord | null>;
  put(rec: PqKeyRecord): Promise<void>;   // ON CONFLICT DO NOTHING semantics
}

// ── Enrollment (idempotent, zero-interaction) ────────────────────────────────

export async function autoEnrollPqKeys(account: string, store: PqKeyStore): Promise<void> {
  const kek = kekFor(account);
  for (const alg of Object.keys(ALGS) as PqAlg[]) {
    const existing = await store.get(account, alg);
    if (existing?.active) continue; // idempotent
    const { publicKey, secretKey } = keygenFor(account, alg);
    await store.put({
      account,
      alg,
      publicKey: Buffer.from(publicKey).toString("hex"),
      encryptedSecretKey: encryptSecretKey(secretKey, kek),
      active: true,
    });
  }
}

// ── Hybrid receipt ───────────────────────────────────────────────────────────

export type EcdsaRecover = (payload: string, sig: string) => string; // returns signer address

export interface HybridReceipt {
  payload: string;
  pqSig: string | null;
  pqAlg: PqAlg | null;
  publicKey: string | null;
  ecdsaSig: string | null;
  ecdsaValid: boolean | null;
}

export async function signHybridReceipt(
  account: string,
  payload: string,
  store: PqKeyStore,
  opts: { alg?: PqAlg; ecdsaSig?: string; ecdsaRecover?: EcdsaRecover } = {},
): Promise<HybridReceipt> {
  const alg = opts.alg ?? "ML-DSA-65";
  const rec = await store.get(account, alg);
  if (!rec) throw new Error(`no enrolled ${alg} key for ${account}`);

  const sk = decryptSecretKey(rec.encryptedSecretKey, kekFor(account));
  const pqSig = ALGS[alg].sign(sk, new TextEncoder().encode(payload));

  let ecdsaValid: boolean | null = null;
  if (opts.ecdsaSig && opts.ecdsaRecover) {
    ecdsaValid = opts.ecdsaRecover(payload, opts.ecdsaSig).toLowerCase() === account.toLowerCase();
  }

  return {
    payload,
    pqSig: Buffer.from(pqSig).toString("hex"),
    pqAlg: alg,
    publicKey: rec.publicKey,
    ecdsaSig: opts.ecdsaSig ?? null,
    ecdsaValid,
  };
}

export async function verifyHybridReceipt(
  receipt: HybridReceipt,
  account: string,
  store: PqKeyStore,
  ecdsaRecover?: EcdsaRecover,
): Promise<{ ecdsaValid: boolean | null; pqValid: boolean | null; overallValid: boolean }> {
  let ecdsaValid: boolean | null = null;
  if (receipt.ecdsaSig && ecdsaRecover) {
    ecdsaValid = ecdsaRecover(receipt.payload, receipt.ecdsaSig).toLowerCase() === account.toLowerCase();
  }

  let pqValid: boolean | null = null;
  if (receipt.pqSig && receipt.pqAlg) {
    const rec = await store.get(account, receipt.pqAlg);
    if (rec) {
      pqValid = ALGS[receipt.pqAlg].verify(
        Buffer.from(rec.publicKey, "hex"),
        new TextEncoder().encode(receipt.payload),
        Buffer.from(receipt.pqSig, "hex"),
      );
    }
  }

  // Neither present layer failed, and at least one affirmatively passed.
  const overallValid =
    ecdsaValid !== false && pqValid !== false && (ecdsaValid === true || pqValid === true);

  return { ecdsaValid, pqValid, overallValid };
}

// ── Hybrid OIDC token ────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface HybridIdToken {
  idToken: string;
  pqSig: string;
  pqAlg: PqAlg;
  pqKid: string;
}

/**
 * Produce an RS256 id-token plus a detached ML-DSA-65 signature that covers the
 * ENTIRE RS256 token string. Forgery now requires breaking RSA *and* ML-DSA.
 */
export async function signIdTokenHybrid(
  payload: Record<string, unknown>,
  rsaPrivateKeyPem: string,
  rsaKid: string,
): Promise<HybridIdToken> {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: rsaKid })));
  const body = b64url(Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...payload })));
  const signingInput = `${header}.${body}`;
  const rsaSig = b64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), rsaPrivateKeyPem));
  const idToken = `${signingInput}.${rsaSig}`;

  // PQ keypair derived from the current RSA kid — rotates automatically with it.
  const seed = hardenedKdf(`oidc:${rsaKid}`, "oidc-mldsa:v1", 32);
  const { secretKey } = ml_dsa65.keygen(new Uint8Array(seed));
  const pqSig = ml_dsa65.sign(new TextEncoder().encode(idToken), secretKey);

  return { idToken, pqSig: Buffer.from(pqSig).toString("hex"), pqAlg: "ML-DSA-65", pqKid: `pq-${rsaKid}` };
}

/** PQ JWK for JWKS publication (draft JOSE PQC representation). */
export function oidcPqJwk(rsaKid: string): { kty: string; alg: string; kid: string; x: string } {
  const seed = hardenedKdf(`oidc:${rsaKid}`, "oidc-mldsa:v1", 32);
  const { publicKey } = ml_dsa65.keygen(new Uint8Array(seed));
  return { kty: "PQK", alg: "ML-DSA-65", kid: `pq-${rsaKid}`, x: Buffer.from(publicKey).toString("base64url") };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  void (async () => {
    const mem = new Map<string, PqKeyRecord>();
    const store: PqKeyStore = {
      async get(a, alg) { return mem.get(`${a}:${alg}`) ?? null; },
      async put(rec) { const k = `${rec.account}:${rec.alg}`; if (!mem.has(k)) mem.set(k, rec); },
    };

    const account = "0x1111111111111111111111111111111111111111";
    await autoEnrollPqKeys(account, store);
    await autoEnrollPqKeys(account, store); // idempotent
    console.log("enrolled algs:", [...mem.keys()]);

    const receipt = await signHybridReceipt(account, JSON.stringify({ to: "0xabc", amount: "1.0" }), store);
    const result = await verifyHybridReceipt(receipt, account, store);
    console.log("receipt verify:", result);

    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const tok = await signIdTokenHybrid({ sub: account, aud: "client-1" }, rsa.privateKey.export({ type: "pkcs1", format: "pem" }) as string, "kid-1");
    const pqOk = ml_dsa65.verify(
      Buffer.from(tok.pqSig, "hex"),
      new TextEncoder().encode(tok.idToken),
      Buffer.from(oidcPqJwk("kid-1").x, "base64url"),
    );
    console.log("oidc pq sig valid:", pqOk);
  })();
}
