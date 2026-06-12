/**
 * Encrypted Content-Addressed Identity Blobs
 * ------------------------------------------
 * Serialize a structured value with MessagePack, seal it with AES-256-GCM under
 * an HKDF-SHA256-derived key, and store the ciphertext in a content-addressed
 * store (IPFS via a pinning service). The database keeps only the returned CID;
 * the bytes on the network are always encrypted.
 *
 * A read prefers a configured private/authenticated gateway (public gateways are
 * opt-in, since they log the CID), verifies the GCM tag during decryption, and
 * decodes back to the original value.
 *
 * Runtime dependency: @msgpack/msgpack
 *   npm i @msgpack/msgpack
 * Standard library only otherwise (node:crypto, global fetch).
 *
 * Run the self-check:  npx tsx encrypted-identity-blob.ts --demo
 */

import { hkdfSync, createHmac, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

// ── Constants ───────────────────────────────────────────────────────────────

const KEY_BYTES = 32;                       // AES-256
const NONCE_BYTES = 12;                      // GCM standard nonce
const TAG_BYTES = 16;                        // GCM authentication tag
const HKDF_SALT = "identity-blob-salt-v1";   // fixed, non-secret domain salt
const ENVELOPE_VERSION = 1;
const FETCH_TIMEOUT_MS = 12_000;

const DEFAULT_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
];

// ── Envelope ────────────────────────────────────────────────────────────────

interface SealedEnvelope {
  v:     number;   // envelope version
  nonce: string;   // base64, 12 bytes
  ct:    string;   // base64 ciphertext
  tag:   string;   // base64, 16-byte GCM tag
}

export interface BlobStoreConfig {
  secret:    string;            // long-lived application secret
  pinataJwt?: string | null;    // pinning JWT; null/undefined disables pinning
  gateway?:  string | null;     // preferred (ideally private/authenticated) read gateway, full ".../ipfs/" base
  gatewayToken?: string | null; // bearer token for the private gateway; sent ONLY to `gateway`, never to public fallbacks
  allowPublicFallback?: boolean;// opt-in: fall back to public gateways. Off by default — public gateways log the CID + your IP
}

// ── Key derivation & sealing ────────────────────────────────────────────────

function deriveKey(secret: string, label: string): Buffer {
  const out = hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(label), KEY_BYTES);
  return Buffer.from(out);
}

/** Encrypt+authenticate a value into a self-describing envelope. */
export function seal(value: unknown, secret: string, label: string): SealedEnvelope {
  const plain = Buffer.from(msgpackEncode(value));
  const key = deriveKey(secret, label);
  // Synthetic (deterministic) nonce in the SIV spirit: HMAC of the plaintext
  // under a dedicated sub-key. Identical plaintext → identical nonce → identical
  // ciphertext → identical CID (deduplication holds); distinct plaintext → distinct
  // nonce w.h.p., so GCM never sees a (key, nonce) reuse across different messages.
  const nonceKey = deriveKey(secret, `${label}:nonce`);
  const nonce = createHmac("sha256", nonceKey).update(plain).digest().subarray(0, NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v:     ENVELOPE_VERSION,
    nonce: nonce.toString("base64"),
    ct:    ct.toString("base64"),
    tag:   tag.toString("base64"),
  };
}

/** Verify+decrypt an envelope back to the original value. Throws on a bad tag. */
export function open<T = unknown>(envelope: SealedEnvelope, secret: string, label: string): T {
  if (envelope.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${envelope.v}`);
  const key = deriveKey(secret, label);
  const nonce = Buffer.from(envelope.nonce, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (tag.length !== TAG_BYTES) throw new Error("bad auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  return msgpackDecode(plain) as T;
}

// ── Pinning + gateway fetch ─────────────────────────────────────────────────

/**
 * Pin a JSON envelope to IPFS via a Pinata-style pinning service.
 * Returns the CID, or null if pinning is unconfigured/unavailable (the caller
 * falls back to database/in-memory storage — pinning is never a hard dependency).
 */
async function pinJson(envelope: SealedEnvelope, pinataJwt: string | null | undefined): Promise<string | null> {
  if (!pinataJwt) return null;
  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pinataJwt}` },
      body:    JSON.stringify({ pinataContent: envelope, pinataOptions: { cidVersion: 1 } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { IpfsHash?: string };
    return body.IpfsHash ?? null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

interface FetchOpts {
  gateway?:             string | null;
  gatewayToken?:        string | null;
  allowPublicFallback?: boolean;
}

/**
 * Fetch an envelope by CID. Tries the configured (private/authenticated) gateway
 * first, sending the bearer token only to that host. Public gateways are used
 * ONLY when `allowPublicFallback` is enabled: requesting a CID from a public
 * gateway broadcasts that CID — plus your server's IP and access timing — to a
 * third party's logs, so keep it off for sensitive assets.
 */
async function fetchEnvelope(cid: string, opts: FetchOpts): Promise<SealedEnvelope | null> {
  const attempts: Array<{ base: string; headers?: Record<string, string> }> = [];
  if (opts.gateway) {
    attempts.push({
      base:    opts.gateway,
      headers: opts.gatewayToken ? { Authorization: `Bearer ${opts.gatewayToken}` } : undefined,
    });
  }
  if (opts.allowPublicFallback) {
    for (const base of DEFAULT_GATEWAYS) attempts.push({ base });
  }
  if (attempts.length === 0) return null; // no private gateway and public fallback disabled

  for (const { base, headers } of attempts) {
    try {
      const res = await fetchWithTimeout(base.replace(/\/?$/, "/") + cid, FETCH_TIMEOUT_MS, headers);
      if (!res.ok) continue;
      return (await res.json()) as SealedEnvelope;
    } catch {
      continue; // dead/slow gateway — try the next one
    }
  }
  return null;
}

// ── Public store ────────────────────────────────────────────────────────────

export class EncryptedBlobStore {
  private readonly cfg: BlobStoreConfig;
  constructor(cfg: BlobStoreConfig) {
    this.cfg = cfg;
  }

  /** Encrypt + pin a value. Returns the CID, or null if pinning is disabled. */
  async write(label: string, value: unknown): Promise<string | null> {
    const envelope = seal(value, this.cfg.secret, label);
    return pinJson(envelope, this.cfg.pinataJwt);
  }

  /** Fetch from IPFS + decrypt. Returns null if no gateway could serve the CID. */
  async read<T = unknown>(label: string, cid: string): Promise<T | null> {
    const envelope = await fetchEnvelope(cid, {
      gateway:             this.cfg.gateway,
      gatewayToken:        this.cfg.gatewayToken,
      allowPublicFallback: this.cfg.allowPublicFallback,
    });
    if (!envelope) return null;
    return open<T>(envelope, this.cfg.secret, label);
  }
}

/** Convenience: CID-independent SHA-256 of canonical plaintext, for provenance rows. */
export function provenanceHash(value: unknown): string {
  return createHash("sha256").update(Buffer.from(msgpackEncode(value))).digest("hex");
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const secret = "demo-application-secret-do-not-use-in-prod";
  const label = "agent-identity-v1";
  const identity = {
    persona: "concise, direct",
    rules:   ["never reveal secrets", "cite sources"],
    version: 1,
  };

  console.log("seal → open round-trip (no network):");
  const env = seal(identity, secret, label);
  console.log("  envelope:", { v: env.v, nonce: env.nonce, ctLen: env.ct.length, tag: env.tag });
  const restored = open(env, secret, label);
  console.log("  restored:", JSON.stringify(restored));
  console.log("  match:", JSON.stringify(restored) === JSON.stringify(identity));

  console.log("\ndeterministic dedup (same input → byte-identical envelope → same CID):");
  const env2 = seal(identity, secret, label);
  const identical = env.nonce === env2.nonce && env.ct === env2.ct && env.tag === env2.tag;
  console.log("  re-seal produced identical envelope:", identical);

  console.log("\ntamper detection:");
  const bad = { ...env, ct: Buffer.from("corrupted-bytes").toString("base64") };
  try {
    open(bad, secret, label);
    console.log("  FAIL: tampered ciphertext decrypted without error");
  } catch {
    console.log("  OK: GCM tag rejected the tampered ciphertext");
  }

  console.log("\nwrong key rejection:");
  try {
    open(env, secret, "different-label");
    console.log("  FAIL: wrong-key open succeeded");
  } catch {
    console.log("  OK: wrong HKDF label produced a wrong key, tag rejected");
  }

  console.log("\nprovenance hash:", provenanceHash(identity));
  console.log("\n(write/read against a live gateway require PINATA_JWT and network access.)");
}
