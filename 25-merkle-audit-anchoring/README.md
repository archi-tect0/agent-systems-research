# Merkle Audit Anchoring


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A system that takes consequential actions — moving funds, changing permissions, blocking traffic — needs an audit log that is *tamper-evident*. A plain append-only table is not enough: anyone with write access to the database (an admin, a compromised service, a buggy migration) can delete or rewrite a row and leave no trace.

The classic fix is to publish each event to an external immutable medium. But publishing every event individually is expensive — if "immutable medium" means a blockchain transaction, you pay a fee and wait for confirmation per event, which does not scale to thousands of audit rows per hour.

The pattern in this guide gives tamper-evidence at batch cost: **group a time-window of audit events into a Merkle tree, and anchor only the single 32-byte root.** One anchor commits to every event in the batch. Later, for any individual event, you can produce a short *inclusion proof* — a logarithmic-size list of sibling hashes — that anyone can check against the anchored root. If even one byte of one event was altered, no valid proof exists.

## Design decisions

**Why a Merkle tree instead of a hash chain?**
A hash chain (each row hashes the previous) also detects tampering, but verifying that a *specific* old event is intact forces you to re-hash the entire chain from that point. A Merkle tree gives O(log n) inclusion proofs: to prove event #4000 of 8000 is in the batch you supply ~13 sibling hashes, not 4000 rows.

**Why anchor a batch root rather than each event?**
The root is a single fixed-size value (32 bytes) that cryptographically commits to *all* leaves. Anchoring it once — to a blockchain, a notary, an append-only WORM bucket, or even a printed page — commits to the entire batch. This decouples anchoring cost from event volume.

**Why hash the leaves and sort them?**
Each leaf is `SHA-256` of a canonical JSON projection of the event (id, type, actor, metadata, timestamp). Hashing first means the tree only ever handles fixed-length 32-byte hex strings, and the canonical projection guarantees the same event always hashes identically. Sorting the leaves makes the tree deterministic regardless of row arrival order, so a verifier who re-reads the same events rebuilds the identical tree and root.

**Why sort the two children inside `hashPair` as well?**
`hashPair(a, b)` concatenates the lexicographically smaller hash first before hashing. This makes the parent independent of left/right argument order, which simplifies proof verification: the verifier does not need to track which side each sibling was on to *recompute* a parent — though this implementation still records `left`/`right` positions in the proof for clarity and to match the recompute step exactly. The sorted-pair convention also matches widely-deployed Merkle libraries, easing interop.

**Why carry odd nodes up unchanged?**
When a layer has an odd number of nodes, the last one is promoted to the next layer without being paired (rather than duplicated). This is a simple, unambiguous rule that keeps the tree well-defined for any leaf count and avoids the second-preimage quirk of duplicating the final leaf.

**Why cache the tree after building it?**
Generating an inclusion proof requires the whole layer structure, not just the root. After a batch is built, the tree (and each event's leaf hash) is cached keyed by event id, so a later proof request is a pure in-memory lookup. On a cache miss (process restarted) the proof path rebuilds the tree from the batch's stored time window — the inputs are deterministic, so the rebuilt tree is identical.

## Algorithm

```
BUILD(leaves):
  if leaves empty: return tree over [ sha256("") ]
  layer0 = sort(leaves)                    // deterministic ordering
  layers = [layer0]
  cur = layer0
  while len(cur) > 1:
    next = []
    for i in 0,2,4,...:
      if i+1 < len(cur): next.push(hashPair(cur[i], cur[i+1]))
      else:              next.push(cur[i])   // odd node promoted unchanged
    layers.push(next); cur = next
  return { root: cur[0], leaves: layer0, layers }

hashPair(a, b) = sha256( a < b ? a+b : b+a )

PROVE(tree, leafHash):
  idx = index of leafHash in tree.leaves
  for each layer except the root:
    sibling = idx is odd ? layer[idx-1] : layer[idx+1]
    if sibling exists: record (sibling, position = idx odd ? "left" : "right")
    idx = floor(idx / 2)
  return { leaf: leafHash, proof: siblings, positions, root: tree.root }

VERIFY(proof):
  h = proof.leaf
  for i in 0..len(proof.proof):
    h = positions[i] == "left" ? hashPair(sibling[i], h) : hashPair(h, sibling[i])
  return h == proof.root
```

Anchoring wraps `BUILD` over one time window: select all audit events with `periodStart <= createdAt < periodEnd`, hash each into a leaf, build the tree, persist a batch row holding the root, the count, the window, and a status (`pending` until the root is committed to the external medium, then `anchored`). An empty window still produces a batch row whose root is `sha256("")`, so every window is accounted for.

## Reference implementation

See [`merkle-audit-anchor.ts`](./merkle-audit-anchor.ts) in this directory. It uses only the Node `crypto` standard library — no external dependencies.

## Usage

```typescript
import { buildMerkleTree, generateProof, verifyProof, hashEvent } from "./merkle-audit-anchor.js";

// 1. At the end of an anchoring window, hash each event into a leaf.
const leaves = events.map(hashEvent);

// 2. Build the tree; anchor ONLY tree.root externally.
const tree = buildMerkleTree(leaves);
anchorExternally(tree.root);            // blockchain tx, notary, WORM bucket, ...

// 3. Later, prove a single event was in the batch.
const proof = generateProof(tree, hashEvent(someEvent));
if (proof) {
  const intact = verifyProof(proof);     // checks against proof.root
}
```

## Limitations and extensions

- **Anchoring is out of scope here.** This module builds the tree and proofs; *where* you publish the root (a blockchain, a transparency log, a notarized PDF) is a separate decision. The strength of the guarantee equals the immutability of that medium.
- **The root only proves inclusion, not completeness.** A proof shows "event X was in batch B". It does not by itself prove that an event was *not* silently dropped before the batch was built. Chain batch roots (each batch references the previous root) to get an append-only guarantee across batches.
- **Canonical serialization is load-bearing.** If the JSON projection of an event is non-deterministic (key reordering, floating-point formatting, timezone drift in timestamps), the rebuilt leaf hash will differ and proofs will fail. Pin a canonical form.
- **Sorted leaves lose original order.** Because leaves are sorted, the tree does not encode event ordering. If order matters, include a monotonic sequence number inside each event's hashed projection.
- **No proof-of-time.** The batch records a window but the root says nothing about *when* it was anchored unless the external medium timestamps it. Use a medium that provides ordering/time (a blockchain block height, an RFC 3161 timestamp).
