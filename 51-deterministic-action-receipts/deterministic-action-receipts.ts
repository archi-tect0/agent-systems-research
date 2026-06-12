/**
 * Deterministic Action Receipts
 *
 * Every action an autonomous agent runs on a user's behalf is turned into a
 * signed, self-verifying receipt:
 *
 *   1. The action is serialised with a canonical (recursively key-sorted) JSON
 *      encoder so the same logical object always produces the same bytes.
 *   2. Those bytes are SHA-256 hashed.
 *   3. The hash is signed with a signature key that is DERIVED DETERMINISTICALLY
 *      from (server secret, wallet) via HKDF — no key is ever stored.
 *
 * Because the key can always be re-derived from (secret, wallet), and because
 * the receipt carries the public key + signature + payload, a receipt written
 * today stays verifiable forever from its own contents — independent of any
 * database row or future server state.
 *
 * The signature algorithm is behind a small adapter interface. Production swaps
 * in a post-quantum signer (ML-DSA-65 from `@noble/post-quantum`); this file
 * ships an Ed25519 adapter built entirely on Node's `crypto` module so the demo
 * runs with no external dependency while keeping faithful sign/verify semantics
 * (deterministic keygen from a seed, asymmetric verification with a public key).
 *
 * Dependencies: Node.js built-in "crypto" module only.
 */

import crypto from "crypto";

// ── Signature adapter interface ───────────────────────────────────────────────

/**
 * A pluggable signature scheme. Production uses ML-DSA-65 (post-quantum);
 * the bundled Ed25519 adapter keeps the demo dependency-free.
 *
 * The contract every adapter must honour:
 *   - keygenFromSeed is deterministic: same 32-byte seed → same keypair.
 *   - verify only ever sees the PUBLIC key (raw bytes), never the secret.
 */
export interface SignatureAdapter {
  alg: string;
  keygenFromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: unknown };
  sign(message: Uint8Array, secretKey: unknown): Uint8Array;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

// Ed25519 PKCS8 / SPKI DER wrappers: a fixed prefix followed by the 32 raw bytes.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX  = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Ed25519 adapter built on Node `crypto`. Deterministic keygen from a 32-byte
 * seed (the seed is wrapped into a PKCS8 DER blob), asymmetric verification
 * from the raw 32-byte public key. Stands in for a real ML-DSA-65 adapter.
 */
export const ed25519Adapter: SignatureAdapter = {
  alg: "Ed25519",

  keygenFromSeed(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
    const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
    const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicKey  = crypto.createPublicKey(privateKey);
    const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
    return { publicKey: new Uint8Array(rawPub), secretKey: privateKey };
  },

  sign(message: Uint8Array, secretKey: unknown): Uint8Array {
    return new Uint8Array(crypto.sign(null, Buffer.from(message), secretKey as crypto.KeyObject));
  },

  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]);
    const pub = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message), pub, Buffer.from(signature));
  },
};

// ── Canonical JSON ────────────────────────────────────────────────────────────

/**
 * Stable JSON serialiser — object keys are sorted recursively so the same
 * logical value always produces the same byte string regardless of insertion
 * order. This is what makes a receipt reproducible by any future verifier.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

// ── Deterministic key derivation ──────────────────────────────────────────────

const SEED_LABEL = "action-receipt-signing-key-v1";

/**
 * Derive a deterministic 32-byte signing seed from (secret, wallet).
 * No key material is stored — it is re-derivable on demand, forever.
 */
export function deriveSigningSeed(secret: Buffer, wallet: string, label: string = SEED_LABEL): Uint8Array {
  const salt = Buffer.from(wallet.toLowerCase());
  return new Uint8Array(crypto.hkdfSync("sha256", secret, salt, label, 32));
}

// ── Receipt API ───────────────────────────────────────────────────────────────

export type ReceiptInput = {
  wallet:    string;
  kind:      "approval" | "intent" | "scheduler";
  toolName:  string;
  payload:   Record<string, unknown>;
  status:    "executed" | "succeeded" | "failed";
  actionId?: string | null;
  intentId?: string | null;
};

export type Receipt = {
  v:            1;
  wallet:       string;
  kind:         string;
  toolName:     string;
  actionId:     string | null;
  intentId:     string | null;
  status:       string;
  payload:      Record<string, unknown>;
  signedAt:     string;
  payloadHash:  string;  // hex
  signature:    string;  // base64
  publicKey:    string;  // base64
  signatureAlg: string;
};

/** The subset of fields that are canonicalised and hashed (the "body"). */
function receiptBody(r: {
  wallet: string; kind: string; toolName: string;
  actionId: string | null; intentId: string | null;
  status: string; payload: Record<string, unknown>; signedAt: string;
}): Record<string, unknown> {
  return {
    v:        1,
    wallet:   r.wallet,
    kind:     r.kind,
    toolName: r.toolName,
    actionId: r.actionId,
    intentId: r.intentId,
    status:   r.status,
    payload:  r.payload,
    signedAt: r.signedAt,
  };
}

/**
 * Build and sign a receipt for an action.
 * `signedAt` defaults to now but can be pinned for reproducible tests.
 */
export function createReceipt(
  input:   ReceiptInput,
  secret:  Buffer,
  adapter: SignatureAdapter,
  signedAt: string = new Date().toISOString(),
): Receipt {
  const wallet   = input.wallet.toLowerCase();
  const actionId = input.actionId ?? null;
  const intentId = input.intentId ?? null;

  const body = receiptBody({
    wallet, kind: input.kind, toolName: input.toolName,
    actionId, intentId, status: input.status, payload: input.payload, signedAt,
  });
  const canonical   = canonicalJSON(body);
  const payloadHash = crypto.createHash("sha256").update(canonical).digest();

  const seed = deriveSigningSeed(secret, wallet);
  const { publicKey, secretKey } = adapter.keygenFromSeed(seed);
  const signature = adapter.sign(new Uint8Array(payloadHash), secretKey);

  return {
    v:            1,
    wallet,
    kind:         input.kind,
    toolName:     input.toolName,
    actionId,
    intentId,
    status:       input.status,
    payload:      input.payload,
    signedAt,
    payloadHash:  payloadHash.toString("hex"),
    signature:    Buffer.from(signature).toString("base64"),
    publicKey:    Buffer.from(publicKey).toString("base64"),
    signatureAlg: adapter.alg,
  };
}

/**
 * Verify a receipt purely from its own contents.
 * Returns false if the recomputed hash disagrees (tamper) or the signature
 * does not check out against the embedded public key.
 */
export function verifyReceipt(receipt: Receipt, adapter: SignatureAdapter): boolean {
  if (receipt.signatureAlg !== adapter.alg) return false;
  try {
    const body = receiptBody(receipt);
    const expected = crypto.createHash("sha256").update(canonicalJSON(body)).digest("hex");
    if (expected !== receipt.payloadHash) return false; // body was altered
    return adapter.verify(
      Buffer.from(receipt.signature, "base64"),
      Buffer.from(receipt.payloadHash, "hex"),
      Buffer.from(receipt.publicKey, "base64"),
    );
  } catch {
    return false;
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const secret = crypto.randomBytes(32);
  const wallet = "0xABCdef0000000000000000000000000000001234";

  const receipt = createReceipt({
    wallet,
    kind:     "approval",
    toolName: "transfer_tokens",
    payload:  { to: "0xfeed...", amount: "25.0", asset: "USDC", chain: "base" },
    status:   "executed",
    actionId: "act_001",
  }, secret, ed25519Adapter, "2024-01-01T00:00:00.000Z");

  console.log("Receipt:");
  console.log(JSON.stringify(receipt, null, 2));

  console.log("\nVerify (untampered):", verifyReceipt(receipt, ed25519Adapter));

  // Re-derivation: a second process with the same (secret, wallet) gets the
  // same public key — no key storage needed.
  const r2 = createReceipt({
    wallet, kind: "approval", toolName: "transfer_tokens",
    payload: { to: "0xfeed...", amount: "25.0", asset: "USDC", chain: "base" },
    status: "executed", actionId: "act_001",
  }, secret, ed25519Adapter, "2024-01-01T00:00:00.000Z");
  console.log("Deterministic key + signature:", r2.publicKey === receipt.publicKey && r2.signature === receipt.signature);

  // Tamper detection: change the amount after signing.
  const tampered = { ...receipt, payload: { ...receipt.payload, amount: "2500.0" } };
  console.log("Verify (tampered amount):", verifyReceipt(tampered, ed25519Adapter));

  // Forgery attempt: keep the hash, swap the signature.
  const forged = { ...receipt, signature: Buffer.from(crypto.randomBytes(64)).toString("base64") };
  console.log("Verify (forged signature):", verifyReceipt(forged, ed25519Adapter));
}
