# Batched Intent Collapse with Merkle Fan-Out

## Problem

A busy agent runtime resolves many independent requests against a large language model. In practice, most of those requests share the same heavy preamble: a system prompt, a tool schema, a compression dictionary, a snapshot of world state. When each request is sent on its own, that preamble is re-transmitted once per request. For N requests with a shared context of size C and per-request deltas of size d, the input cost is roughly `N × (C + d)` even though only `C + N × d` is genuinely distinct.

Because the shared context is usually far larger than the per-request delta, the duplicated preamble dominates the input token bill. The waste grows linearly with traffic and is highest exactly when the system is busiest — the worst time to be paying for redundant tokens.

A second concern is auditability. When a set of requests is folded into one combined call, it must be possible to prove afterwards *which* requests were in the batch and that none were altered, without re-sending their contents. A compact, verifiable anchor over the batch is needed so a later auditor can confirm batch membership from hashes alone.

## Design decisions

**Why collapse the shared context into a single call?**
The shared context is materialized once, hashed once, and placed in the combined payload once. Each request is reduced to only its delta — the part that differs from the shared base. This turns `N × (C + d)` into `C + N × d` of distinct input. The larger the shared context relative to the deltas, the larger the saving.

**Why virtual channel ids?**
Once N requests are merged into one call, their results come back interleaved. Each request is assigned a virtual channel id (1..N; 0 is reserved for meta/system) at collapse time. The combined payload carries these ids, the resolver echoes them on every result, and fan-out uses them as the demultiplexing key to route each answer back to its original caller. Without a stable channel id there is no reliable way to match an answer to its question.

**Why a Merkle root over the batch?**
The batch is anchored by computing a Merkle root over `[sharedContextHash, intentHash₀, intentHash₁, ...]`. This single root commits to the exact set and order of inputs. Anyone holding the leaves can recompute the root and confirm nothing was added, dropped, or modified — tamper detection without storing or re-sending the full contents. The result set carries its own Merkle root for a symmetric, auditable response trail.

**Why canonical (sorted-key) JSON before hashing?**
Hashes must be stable regardless of key ordering in the source objects. Canonicalization recursively sorts object keys before serialization so the same logical content always produces the same hash on any platform. Without it, two semantically identical inputs could hash differently and break verification.

**Why keep the resolver behind an interface?**
`fanOut` takes a `BatchResolver` callback rather than calling a model directly. This keeps the collapse → resolve → fan-out pipeline independent of any particular backend. The reference implementation uses a stubbed in-process resolver; a production deployment supplies one that issues a single model call.

## Algorithm

```
collapse(intents, sharedContext):
  sharedContextHash = sha256(canonical(sharedContext))
  for i, intent in intents:
    virtualChannelId = i + 1            // 0 reserved for meta/system
    leafHash = sha256(canonical({ intentId, virtualChannelId, delta }))
  merkleRoot = merkle([sharedContextHash, ...leafHashes])
  blockId    = sha256(merkleRoot + sharedContextHash)[0:16]
  return MacroBlock { blockId, sharedContext, sharedContextHash, intents, merkleRoot }

buildCombinedPayload(block):
  // shared context appears EXACTLY ONCE; each task carries only its delta
  return { blockId, merkleRoot, sharedContext, tasks: [{ intentId, virtualChannelId, delta }] }

fanOut(block, resolve):
  combined = buildCombinedPayload(block)
  raw      = resolve(combined)                  // one batched call
  byChannel = map(virtualChannelId -> payload)  // from raw
  for intent in block.intents:
    payload    = byChannel[intent.virtualChannelId] ?? null
    outputHash = sha256(canonical(payload))
  resultMerkleRoot = merkle(outputHashes)
  return ResultBlock { blockId, results, resultMerkleRoot }

verifyBlock(block):
  recomputed = merkle([sharedContextHash, ...intent.leafHash])
  return recomputed == block.merkleRoot
```

The Merkle helper duplicates the last leaf when a level has an odd number of nodes, and returns `sha256("empty")` for an empty leaf set.

## Reference implementation

See [`batched-intent-collapse.ts`](./batched-intent-collapse.ts) in this directory. It runs on Node.js built-ins only (the `crypto` module); the model call is represented by a `BatchResolver` callback so the pipeline can be exercised without any network access.

## Usage

```typescript
import {
  collapse,
  buildCombinedPayload,
  fanOut,
  verifyBlock,
  type Intent,
  type BatchResolver,
} from "./batched-intent-collapse.js";

const sharedContext = {
  systemPrompt: "You are a careful assistant.",
  toolSchemas: ["vault_read", "web_search", "send_message"],
  worldState: { city: "Lisbon", tz: "WET" },
};

const intents: Intent[] = [
  { intentId: "i-weather", delta: { task: "current weather" } },
  { intentId: "i-headline", delta: { task: "top tech headline" } },
  { intentId: "i-fx", delta: { task: "EUR/USD rate" } },
];

// 1. Collapse N intents + shared context into one Merkle-anchored block.
const block = collapse(intents, sharedContext);
console.log(block.blockId, block.merkleRoot, verifyBlock(block));

// 2. The combined payload sends the shared context only once.
const combined = buildCombinedPayload(block);

// 3. Provide a resolver (one batched call) and fan results back out by channel.
const resolve: BatchResolver = async (p) =>
  p.tasks.map((t) => ({
    virtualChannelId: t.virtualChannelId,
    payload: { answer: `result for ${(t.delta as { task: string }).task}` },
  }));

const resultBlock = await fanOut(block, resolve);
for (const r of resultBlock.results) {
  console.log(`ch${r.virtualChannelId} ${r.intentId}:`, r.payload);
}
console.log(resultBlock.resultMerkleRoot);
```

## Limitations and extensions

- **Saving depends on the context-to-delta ratio.** Collapse pays off when the shared context is large relative to per-intent deltas. For requests with little shared context, the overhead of building the block outweighs the benefit.
- **One shared context per block.** All intents in a block must share the same context. Requests with different contexts must be partitioned into separate blocks first; clustering intents by context overlap before collapsing improves the ratio.
- **Isolation is enforced by contract, not by construction.** When a real model resolves the combined call, per-intent isolation (no cross-contamination between tasks) must be enforced through the prompt and validated on the way out. The Merkle anchors detect tampering with inputs and outputs but do not by themselves guarantee the resolver kept tasks independent.
- **Batch size has practical ceilings.** Very large batches risk exceeding the model's context window and increase the blast radius of a single failed call. A maximum batch size and a fallback to smaller batches (or single calls) are worth adding.
- **The Merkle root commits to membership, not semantics.** It proves which inputs were present and unaltered, not that the answers are correct. Result validation against each intent's target schema is a separate, complementary step.
