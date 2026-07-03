# Encrypted Content-Addressed Identity Blobs (IPFS)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An agent platform needs to persist large, sensitive text artifacts: an agent's identity/personality definition, a user's imported chat history, a knowledge corpus, a wallet keystore. Three properties are in tension:

1. **Durability** — the artifact must survive a server restart, a database migration, or a region failover.
2. **Confidentiality** — the storage layer must never see plaintext. This is non-negotiable for user-imported material (a ChatGPT export, a private key) and strongly desirable for the agent's own configuration.
3. **Deduplication and verifiability** — the same artifact stored twice should not cost twice the space, and a reader must be able to detect a corrupted or substituted blob.

A naive design stores the plaintext in a database column. That fails confidentiality (the DBA, the backup tapes, and any SQL-injection bug all see the text) and gives no integrity guarantee against a tampered row.

The pattern in this guide solves all three at once: **encrypt with AES-256-GCM under an HKDF-derived key, then store the ciphertext in a content-addressed store (IPFS).** The content address (CID) is a cryptographic hash of the ciphertext, so it doubles as a free integrity check and a free deduplication key. The database stores only the CID, never the bytes. A read walks a list of public gateways until one returns the blob, then decrypts locally.

## Design decisions

**Why msgpack before encryption?**
The plaintext is structured (a string, an object, an array of chunks). MessagePack is a compact binary serialization that is smaller than JSON and preserves types exactly. Encrypting the msgpack bytes (rather than a JSON string) shrinks the ciphertext and keeps the encode/decode boundary symmetric: `decode(decrypt(fetch(cid)))` always reconstructs the original value.

**Why AES-256-GCM specifically?**
GCM is authenticated encryption: the 16-byte authentication tag detects any modification of the ciphertext or the nonce. Because IPFS is a public, untrusted network, a reader must assume the bytes could have been substituted. GCM turns "did someone tamper with this?" into a single tag-verification step that happens automatically inside `decipher.final()` — a wrong tag throws rather than returning garbage plaintext.

**Why derive the key with HKDF instead of using a raw secret?**
The application has one long-lived secret (an environment variable). Using it directly as an AES key is brittle: it couples the key length to the secret length and reuses the same key across every purpose. HKDF-SHA256 with a fixed salt and an `info` label (`"identity-blob-v1"`) produces a 32-byte key bound to that specific use-case. Rotating the label rotates every key without touching the secret.

**Why a random 12-byte nonce per encryption?**
GCM's security collapses if a (key, nonce) pair is ever reused. A fresh 96-bit random nonce per encryption makes collision probability negligible for any realistic blob count, and the nonce is stored in the envelope alongside the ciphertext (it is not secret, only unique).

**Why content addressing (CID) instead of a random storage key?**
A CID is the hash of the ciphertext. Two consequences fall out for free:
- *Deduplication*: identical ciphertext → identical CID → the pinning service stores one copy.
- *Immutability*: a CID can only ever resolve to bytes that hash to that CID. A read result that doesn't match the requested CID is provably wrong, so cached reads can be trusted indefinitely.

**Why a multi-gateway read fallback?**
A single public IPFS gateway is a single point of failure — it can be rate-limited, down, or slow. The reader tries a configured gateway first, then a fixed list of well-known public gateways, accepting the first success. Each attempt has a short timeout so a dead gateway costs a few seconds, not a hung request.

**Why does the server never see plaintext for user imports?**
For user-imported material the encryption happens client-side, inside a web worker in the user's session. The server receives an already-sealed `{ciphertext, nonce, salt}` envelope, pins it, and stores only the CID plus non-sensitive provenance (source label, size, SHA-256, chunk count). Read endpoints echo the CID and metadata but **never** the ciphertext for wallet-key imports — only the public address. The plaintext exists only on the user's device.

## Algorithm

```
WRITE(value, secret, label):
  plain   = msgpack_encode(value)
  key     = HKDF-SHA256(secret, salt="identity-blob-salt-v1", info=label, len=32)
  nonce   = random(12)
  cipher  = AES-256-GCM(key, nonce)
  ct      = cipher.update(plain) || cipher.final()
  tag     = cipher.getAuthTag()
  envelope = { v:1, nonce, ct, tag }            // all base64
  cid     = pinToIPFS(envelope)                  // CID = hash(envelope bytes)
  store_cid_in_db(label, cid)
  return cid

READ(cid, secret, label):
  envelope = null
  for gw in [configured, pinata, cloudflare, ipfs.io]:
    try: envelope = fetch(gw + cid, timeout=12s); break
    catch: continue                              // try next gateway
  if envelope == null: return null
  key      = HKDF-SHA256(secret, salt, info=label, len=32)
  decipher = AES-256-GCM(key, envelope.nonce)
  decipher.setAuthTag(envelope.tag)
  plain    = decipher.update(envelope.ct) || decipher.final()   // throws on bad tag
  return msgpack_decode(plain)
```

The boot sequence for the agent's own identity blobs is: on first boot, encrypt the seed text and pin it, persisting the CID in a config table. On every subsequent boot, read the CID, fetch, decrypt, and cache the plaintext in memory so the synchronous getter is hot. If the pinning service is unconfigured, the system falls back to the in-process seed text — pinning is an enhancement, never a hard dependency.

## Graceful degradation

Pinning is best-effort. If the pinning JWT is absent or the API returns an auth error, the write returns `null` for the CID and the caller falls back to database-only or in-memory storage. This keeps the platform bootable in development and resilient to a third-party outage — confidentiality is preserved either way because the bytes were already encrypted before they left the process.

## Reference implementation

See [`encrypted-identity-blob.ts`](./encrypted-identity-blob.ts) in this directory.

## Usage

```typescript
import { EncryptedBlobStore } from "./encrypted-identity-blob.js";

const store = new EncryptedBlobStore({
  secret:     process.env.ADDR_SECRET!,   // long-lived application secret
  pinataJwt:  process.env.PINATA_JWT,     // optional — null disables pinning
  gateway:    process.env.IPFS_GATEWAY,   // optional preferred gateway
});

// Encrypt + pin an identity definition; persist the returned CID yourself.
const cid = await store.write("agent-identity-v1", {
  persona: "concise, direct",
  rules:   ["never reveal secrets", "cite sources"],
});

// Later (e.g. after a restart): fetch + decrypt from the CID.
const identity = await store.read("agent-identity-v1", cid);
```

## Limitations and extensions

- **Public network, encrypted payload.** IPFS is public; anyone who learns a CID can fetch the *ciphertext*. Confidentiality rests entirely on the AES key. Treat the application secret as the crown jewel and rotate the HKDF `info` label to re-key.
- **Pinning is not permanence.** Unpinned IPFS content is garbage-collected by nodes over time. The pinning service is what keeps a CID resolvable; if you stop paying for pinning, plan a database-blob fallback.
- **Metadata leaks.** The CID, blob size, and provenance label are stored in plaintext in the database. Size alone can hint at content. Pad blobs to size buckets if size is sensitive.
- **No forward secrecy.** A single static key encrypts every blob under a label. Compromise of the secret exposes all past blobs. For per-item forward secrecy, derive a per-blob key from the secret plus a random salt stored in the envelope (the user-import path does exactly this with a client-supplied `salt`).
- **Client-side encryption for true zero-knowledge.** Server-side encryption protects against storage compromise but the server still touches plaintext momentarily. For material the server must never see (private keys, raw chat exports), encrypt in the client and have the server pin an opaque envelope — the read path then refuses to echo ciphertext back.
