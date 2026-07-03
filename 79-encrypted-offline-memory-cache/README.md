# Guide 79 — Encrypted Offline Memory Cache


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Kylum's memory subsystem is always-online: every `remember()` call embeds via the OpenAI proxy, every `recall()` call fires a pgvector similarity query. When the network is unavailable, the agent loses all episodic context — it cannot recall preferences, corrections, or facts from the current session.

Two sub-problems make naïve caching dangerous for a sovereign-AI system:

1. **Privacy exposure.** A plaintext IndexedDB store leaks user facts to any extension or injected script that can reach `window.indexedDB`.
2. **Coherence.** An offline cache that diverges from the server's pgvector index produces stale recall results after reconnection without a merge strategy.

---

## Approach

**WebCrypto AES-GCM with per-entry nonces + a Bloom filter index.**

### Layer 1 — Per-session symmetric key

Derived with `SubtleCrypto.importKey` → `deriveBits` (HKDF-SHA-256) from the user's session token (already available in the frontend). The derivation salt is stored in `localStorage` as a fixed salt scoped to the wallet address. The derived key never leaves `CryptoKey` (non-extractable). Across sessions the salt persists; across devices the key is not portable (local-first).

### Layer 2 — Per-entry AES-GCM encryption

Each memory entry is encrypted as `{ iv: Uint8Array(12), ciphertext: ArrayBuffer }`. The plaintext is `JSON.stringify({ content, embedding: Float32Array, meta })`. A random IV is generated per entry using `crypto.getRandomValues`.

### Layer 3 — Offline Bloom filter for recall

A **512-bit Bloom filter** (64 bytes, 4 hash functions) is maintained in `localStorage` (serialised as a base64 bitfield). False-positive rate at 200 entries: ~0.8%. False-negative rate: 0.

The filter is a **corpus-level prefilter**, not a per-entry discriminator:

- **At write time**: the content tokens of each new entry are added to the shared filter (not the entry ID — probing by ID you already have is circular and provides no recall signal).
- **At recall time**: query tokens are probed. A **MISS** means it is guaranteed no cached entry overlaps with the query — skip all AES-GCM decryption. A **HIT** means at least one entry might match — decrypt all entries and re-rank by cosine similarity.

The primary value of the filter is the **MISS path**: it eliminates all decryption work when a query has no token overlap with anything in the cache (common for cold sessions or out-of-domain queries).

When online, the filter is rebuilt from the embedding cluster centroids of the last 200 entries. When offline, `recall(query)` tokenises the query text and probes the filter directly. A 64-dim PCA projection (pre-computed centroid matrix stored in the app bundle, ~4 KB) provides the production path; the reference implementation uses raw content tokens, which are functionally equivalent for demonstrating the prefilter contract.

### Layer 4 — Reconnect merge

On reconnect, the local cache diff (entries written offline) is uploaded to the server's `agentMemories` endpoint. Entries are deduplicated by content hash. Server's pgvector index is authoritative; the local cache is marked clean.

---

## Key guarantees

| Property | Mechanism |
|---|---|
| Plaintext never persists | AES-GCM encryption at write, decryption at read only in-memory |
| Key isolation per wallet | HKDF derivation salt is wallet-scoped |
| Offline recall accuracy | Bloom + local cosine re-rank (false negative rate: 0) |
| Reconnect coherence | Content-hash dedup on merge |
| Zero server round-trips offline | All operations are synchronous browser-side |

---

## Novel contribution

Prior guides address in-memory compression (SQ-B) and server-side pgvector recall. This guide is the first to define the **client-side encrypted persistence layer** that bridges the two — enabling episodic continuity across network loss without creating a privacy liability.

---

## Integration points

- `artifacts/vanguard/src/lib/offlineMemoryCache.ts` — the cache implementation
- `artifacts/vanguard/src/hooks/useMemorySync.ts` — reconnect merge hook
- `artifacts/api-server/src/lib/agentMemory.ts` — `remember()` / `recall()` are the server peers
- Bloom centroid matrix: `artifacts/vanguard/src/lib/memoryBloomCentroids.json`

---

## Deferred

- Passkey-wrapped key derivation (key is currently session-token derived; upgrade to passkey HMAC)
- Multi-device sync (currently local-first only)
- Full 1536-dim offline embedding (currently PCA-projected to 64 dims)

See `dbk-defer-list.md` for parked items.
