# On-Demand Encrypted Knowledge-Blob Injection


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A capable assistant needs to "know" how to operate many apps, tools, and domains. Baking all of that knowledge into one static system prompt is wasteful: the model pays the token cost of every capability on every turn, even capabilities it never uses in that conversation. As the number of supported capabilities grows, the base prompt grows with it, and the per-turn cost grows whether or not any given capability is invoked.

There is also a disclosure concern. A monolithic prompt exposes the full surface of what the assistant can do to anyone who can read the context, even when most of that surface is irrelevant to the current request.

The goal is to keep the base prompt small and constant, and to bring in a capability's knowledge only for the turn that actually needs it. Knowledge should be stored compactly and confidentially, fetched on demand when an incoming turn matches a capability, used for that turn, and then removed so nothing accumulates and the prompt stays bounded.

## Design decisions

**Why store knowledge as compressed, encrypted, content-addressed blobs?**
Each capability's knowledge fragment is serialized to JSON, deflated, and encrypted with AES-256-GCM. The blob is then stored under a content id derived from the hash of its ciphertext (`cid = sha256(ct)`). Compression keeps blobs small; encryption keeps them confidential at rest; content addressing means identical content always yields the same id and any change to the ciphertext changes the id, so the store is self-verifying.

**Why a per-capability derived key?**
The encryption key is derived with HKDF-SHA256 from a master secret, a random per-blob salt, and an info string scoped to the capability id (`knowledge-blob:<appId>`). Each blob therefore has its own key, and the salt makes every publication of the same content produce distinct ciphertext. Compromise of one blob's key does not generalize to others.

**Why match intent in the clear but keep knowledge encrypted?**
The router keeps each capability's intent patterns in plaintext so it can decide *whether* a turn needs a capability without decrypting anything. Only after a match does it fetch and decrypt the blob. The cheap, frequent operation (matching) stays cheap; the expensive, sensitive operation (decryption) happens only when warranted.

**Why inject for a single turn and then evict?**
Decrypted knowledge is placed in a turn-scoped context window, used while the turn runs, and cleared afterwards via `evictAll()`. Because nothing carries over between turns, the resident context never grows unbounded — the base prompt remains small regardless of how many capabilities exist or how many were touched in earlier turns.

**Why authenticated encryption?**
AES-256-GCM verifies the auth tag on decryption. A corrupted or tampered blob fails authentication and `loadBlob` throws rather than returning forged knowledge. The pipeline fails closed: bad ciphertext never becomes injected context.

## Algorithm

```
publish(spec, masterSecret, store):
  salt = random(16); iv = random(12)
  key  = HKDF-SHA256(masterSecret, salt, "knowledge-blob:" + spec.appId, 32)
  ct   = AES-256-GCM(key, iv, deflate(JSON(spec)))
  blob = { appId, salt, iv, tag, ct }
  cid  = sha256(ct); store[cid] = blob
  return cid

load(cid, masterSecret, store):
  blob = store[cid]                       // throws if missing
  key  = HKDF-SHA256(masterSecret, blob.salt, "knowledge-blob:" + blob.appId, 32)
  packed = AES-256-GCM-decrypt(key, blob.iv, blob.tag, blob.ct)   // throws on auth fail
  return JSON(inflate(packed))

turn(router, userMessage):
  appId = matchIntent(userMessage)        // substring match on plaintext patterns
  if appId:
    fragment = inject(appId)              // load + decrypt, add to turn window
    run turn with activeContext()
  evictAll()                              // clear turn-scoped knowledge
```

## Reference implementation

See [`on-demand-knowledge-blobs.ts`](./on-demand-knowledge-blobs.ts) in this directory. It runs on Node.js built-ins only (`crypto` for HKDF/AES-GCM/SHA-256 and `zlib` for deflate); the in-memory `ContentStore` keyed by content hash stands in for a content-addressed network such as IPFS.

## Usage

```typescript
import {
  ContentStore,
  KnowledgeRouter,
  publishBlob,
  loadBlob,
  type BlobSpec,
} from "./on-demand-knowledge-blobs.js";

const store = new ContentStore();
const router = new KnowledgeRouter(store, "master-secret");

// Register capabilities; each is published as an encrypted, content-addressed blob.
router.register({
  appId: "mail",
  name: "Mail",
  intentPatterns: ["send email", "check mail", "inbox", "compose"],
  knowledge: "Mail: use send_message(recipient, body) to send; read_inbox() to list.",
});

// A turn arrives: match intent, inject knowledge, run, then evict.
const turn = "Can you check mail for me?";
const appId = router.matchIntent(turn);
if (appId) {
  const fragment = router.inject(appId);
  console.log(router.activeContext().length); // knowledge resident during the turn
}
router.evictAll();
console.log(router.activeContext().length);    // 0 — nothing accumulates

// Lower-level publish/load are also exported:
const spec: BlobSpec = {
  appId: "vault",
  name: "Vault",
  intentPatterns: ["open vault"],
  knowledge: "Vault: read_vault(slug) / write_vault(slug, blob).",
};
const cid = publishBlob(spec, "master-secret", store);
const loaded = loadBlob(cid, "master-secret", store);
```

## Limitations and extensions

- **Substring intent matching is coarse.** `matchIntent` does a case-insensitive substring check against patterns. It is fast and predictable but can miss paraphrases and trigger on incidental overlaps. A production router may add embedding similarity or a small classifier ahead of the blob fetch.
- **Master secret management is out of scope.** All per-blob keys derive from one master secret; rotating that secret, or scoping it per user, is the caller's responsibility.
- **No caching layer in the reference.** Each `inject` reloads and re-decrypts. A real deployment caches decrypted specs with a TTL to avoid repeated fetch-and-decrypt for hot capabilities.
- **Content store is in-memory.** The bundled `ContentStore` is a `Map`. Pointing it at a real content-addressed network (IPFS or similar) adds availability and durability but introduces fetch latency and gateway failure handling.
- **Distinct from related designs.** This injects *dynamic* capability knowledge per turn, unlike static identity blobs (which carry fixed, always-resident identity material) and unlike an HTML/UI bridge (which renders surfaces rather than feeding model context).
