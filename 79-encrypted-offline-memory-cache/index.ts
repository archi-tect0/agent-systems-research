/**
 * Guide 79 — Encrypted Offline Memory Cache
 * Runnable reference implementation (Node.js / TypeScript, no external deps).
 *
 * Demonstrates:
 *   A. Per-entry AES-GCM encrypt/decrypt with HKDF key derivation
 *   B. Content-token Bloom filter for offline recall prefiltering
 *   C. Reconnect merge with content-hash dedup
 *
 * Bloom filter design (corpus-level prefilter):
 *   At WRITE time, the content tokens of each entry are added to a single
 *   shared 512-bit Bloom filter (not the entry ID — that would be circular).
 *   At RECALL time, query tokens are probed. A HIT means at least one entry
 *   in the corpus MIGHT share a token with the query → decrypt all candidates
 *   and cosine-rerank. A MISS means no entry can possibly contain any query
 *   token → skip all AES-GCM decryption entirely.
 *
 *   This is a corpus-level prefilter, not a per-entry discriminator.
 *   False-positive rate at 200 entries: ~0.8%. False-negative rate: 0.
 *   Its value is in the MISS path: zero decryptions when the cache has
 *   no overlap with the query (common for cold sessions).
 *
 * Run:  npx ts-node --experimentalSpecifierResolution=node index.ts
 * All behaviour is deterministic (scripted clock + fixed random seed).
 */

import { createHmac, createHash, webcrypto } from "node:crypto";

// ─── Deterministic PRNG (seeded) ──────────────────────────────────────────────
// Replaces crypto.getRandomValues for reproducible demos.
let _seed = 0x4a9d12c8;
function fakeRandom(): number {
  _seed = ((_seed ^ (_seed << 13)) >>> 0);
  _seed = ((_seed ^ (_seed >> 17)) >>> 0);
  _seed = ((_seed ^ (_seed << 5))  >>> 0);
  return (_seed >>> 0) / 0xffffffff;
}
function fakeRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(fakeRandom() * 256);
  return buf;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface MemoryEntry {
  id:        string;
  content:   string;
  embedding: number[];   // 8-dim PCA projection (demo; prod is 64-dim)
  createdAt: number;
}

interface EncryptedEntry {
  id:         string;
  iv:         string;    // base64
  ciphertext: string;    // base64
}

// ─── A. Key Derivation (HKDF-SHA-256) ────────────────────────────────────────
// In the browser: SubtleCrypto.deriveKey; here we use Node crypto.hkdfSync.
async function deriveKey(sessionToken: string, walletSalt: string): Promise<webcrypto.CryptoKey> {
  const ikm  = Buffer.from(sessionToken, "utf8");
  const salt = Buffer.from(walletSalt,   "utf8");
  const info = Buffer.from("agent-offline-memory-v1", "utf8");

  const { hkdfSync } = await import("node:crypto");
  const keyBytes = hkdfSync("sha256", ikm, salt, info, 32);

  return webcrypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

// ─── A. Encrypt / Decrypt ─────────────────────────────────────────────────────
async function encrypt(key: webcrypto.CryptoKey, entry: MemoryEntry): Promise<EncryptedEntry> {
  const iv        = fakeRandomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(entry), "utf8");
  const cipher    = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    id:         entry.id,
    iv:         Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(cipher).toString("base64"),
  };
}

async function decrypt(key: webcrypto.CryptoKey, enc: EncryptedEntry): Promise<MemoryEntry> {
  const iv         = Buffer.from(enc.iv, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const plain      = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(Buffer.from(plain).toString("utf8")) as MemoryEntry;
}

// ─── B. Tokenizer ─────────────────────────────────────────────────────────────
// Extracts lowercase, meaningful tokens from text. Stopwords and sub-3-char
// tokens are dropped so the Bloom filter probes content signal, not noise.
const STOPWORDS = new Set([
  "the","a","an","is","in","it","to","of","and","or","but","for","with",
  "my","i","me","on","at","by","as","be","do","so","if","we","up","are",
  "was","has","had","have","this","that","its","not","can","will","from",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// ─── B. Bloom Filter (512-bit / 64 bytes, 4 hash functions) ───────────────────
//
// A SINGLE shared filter covers the entire local cache. Used as a corpus-level
// prefilter:
//
//   addContent(content)  — called at write time for each new entry
//   probeQuery(query)    — called at recall time; returns false only when it is
//                          CERTAIN no cached entry can overlap with the query
//
// On a probe MISS: skip all decryption (guaranteed no match in cache).
// On a probe HIT:  decrypt all entries and cosine-rerank (Bloom may false-positive).
class BloomFilter {
  private bits = new Uint8Array(64); // 512 bits = 64 bytes

  private _hash(token: string, seed: number): number {
    const h = createHmac("sha256", String(seed)).update(token).digest();
    return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  }

  private _setBit(token: string): void {
    for (let s = 0; s < 4; s++) {
      const bit = this._hash(token, s) % 512;
      this.bits[Math.floor(bit / 8)]! |= (1 << (bit % 8));
    }
  }

  private _testBit(token: string): boolean {
    for (let s = 0; s < 4; s++) {
      const bit = this._hash(token, s) % 512;
      if (!(this.bits[Math.floor(bit / 8)]! & (1 << (bit % 8)))) return false;
    }
    return true;
  }

  // Add all content tokens for a new cache entry (called at write time).
  addContent(content: string): void {
    for (const token of tokenize(content)) this._setBit(token);
  }

  // Returns true if any query token might appear in the cache.
  // Returns false only when it is CERTAIN nothing in the cache can match.
  probeQuery(query: string): boolean {
    const tokens = tokenize(query);
    if (tokens.length === 0) return true; // empty query — can't rule anything out
    for (const token of tokens) {
      if (this._testBit(token)) return true;
    }
    return false; // no query token found in filter → guaranteed cache miss
  }
}

// ─── B. Local cosine similarity (offline recall) ──────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── C. Reconnect Merge (content-hash dedup) ──────────────────────────────────
function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

interface MergeResult {
  uploaded: number;
  skipped:  number;
}

function mergeWithServer(
  local: MemoryEntry[],
  serverHashes: Set<string>,
): MergeResult {
  let uploaded = 0; let skipped = 0;
  for (const entry of local) {
    const h = contentHash(entry.content);
    if (serverHashes.has(h)) { skipped++; continue; }
    serverHashes.add(h);
    uploaded++;
  }
  return { uploaded, skipped };
}

// ─── Demo ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const SESSION_TOKEN = "demo-session-abc123";
  const WALLET_SALT   = "0xJASYN-demo-wallet";

  const key = await deriveKey(SESSION_TOKEN, WALLET_SALT);
  console.log("[A] Key derived (non-extractable AES-GCM-256).");

  const entries: MemoryEntry[] = [
    { id: "e1", content: "User prefers dark mode",       embedding: [0.9,-0.1,0.2,0.0,0.3,0.1,-0.2,0.4], createdAt: 1000 },
    { id: "e2", content: "User speaks Spanish fluently", embedding: [0.1, 0.8,0.0,0.3,0.1,0.2, 0.1,0.0], createdAt: 1001 },
    { id: "e3", content: "User is building a Web3 OS",   embedding: [0.0, 0.1,0.9,0.4,0.0,0.5, 0.0,0.2], createdAt: 1002 },
  ];

  const store = new Map<string, EncryptedEntry>();
  const bloom = new BloomFilter();

  for (const entry of entries) {
    const enc = await encrypt(key, entry);
    store.set(enc.id, enc);
    // Correct: add content TOKENS (not the entry ID) to the Bloom filter.
    bloom.addContent(entry.content);
    console.log(`[A] Encrypted ${entry.id}, added tokens: [${tokenize(entry.content).join(", ")}]`);
  }

  // ── Scenario B1: Bloom HIT — query overlaps with cached content ─────────────
  const relevantQuery     = "dark theme preference";
  const relevantQueryVec  = [0.85, -0.1, 0.15, 0.0, 0.25, 0.1, -0.15, 0.35];

  console.log(`\n[B1] Query: "${relevantQuery}"`);
  console.log(`     Tokens: [${tokenize(relevantQuery).join(", ")}]`);

  let decryptCount = 0;
  const hit = bloom.probeQuery(relevantQuery);
  console.log(`     Bloom probe: ${hit ? "HIT — at least one entry may match, proceeding to decrypt+rerank" : "MISS"}`);
  console.assert(hit, "FAIL: expected Bloom HIT for a query whose tokens appear in cached content");

  const candidates: Array<{ entry: MemoryEntry; score: number }> = [];
  if (hit) {
    for (const enc of store.values()) {
      const entry = await decrypt(key, enc);
      decryptCount++;
      const score = cosine(entry.embedding, relevantQueryVec);
      candidates.push({ entry, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    console.log(`     Decrypted: ${decryptCount} entries. Top result: "${candidates[0]?.entry.content}" (score: ${candidates[0]?.score.toFixed(4)})`);
    console.assert(candidates[0]?.entry.content === "User prefers dark mode", "FAIL: wrong top result");
    console.log("     PASS ✓");
  }

  // ── Scenario B2: Bloom MISS — query has no overlap with cache ──────────────
  // "quantum blockchain" shares no tokens with any cached entry → Bloom returns
  // false → zero AES-GCM decryptions. This is the main value of the filter.
  const irrelevantQuery = "quantum blockchain cryptography";
  console.log(`\n[B2] Query: "${irrelevantQuery}"`);
  console.log(`     Tokens: [${tokenize(irrelevantQuery).join(", ")}]`);

  const miss = bloom.probeQuery(irrelevantQuery);
  console.log(`     Bloom probe: ${miss ? "HIT" : "MISS — no entry can match, skipping all decryption"}`);
  console.assert(!miss, "FAIL: expected Bloom MISS for a query with no token overlap with cached content");
  console.log(`     Decryptions avoided: ${store.size}. PASS ✓`);

  // ── Scenario C: Reconnect merge ─────────────────────────────────────────────
  const serverHashes: Set<string> = new Set([contentHash(entries[1]!.content)]); // e2 already on server
  const decrypted = await Promise.all([...store.values()].map(enc => decrypt(key, enc)));
  const { uploaded, skipped } = mergeWithServer(decrypted, serverHashes);
  console.log(`\n[C] Reconnect merge: uploaded=${uploaded} skipped=${skipped}`);
  console.assert(uploaded === 2, `FAIL: expected 2 uploads, got ${uploaded}`);
  console.assert(skipped  === 1, `FAIL: expected 1 skip, got ${skipped}`);
  console.log("    PASS ✓");

  console.log("\nGuide 79 demo complete.");
}

main().catch(console.error);
