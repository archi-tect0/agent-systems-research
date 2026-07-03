# Guide 85 — SQ-C: Linguistic Multiplexing


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A Layer-3 cognitive compression protocol that replaces explicit phrase tokens with probabilistic slot markers, offloading decompression entirely onto the language model's attention mechanism. Part of the token evacuation strategy — see Guide 87 (SQ-E) for the full stack definition.*

---

## Problem

SQ-B (Guide 03) compresses repeated session phrases by substituting them for short codes (`∫a7`, `∫t3`, …) using a Zero-Turn phrase ledger. This is lossless and fast but hits a hard floor: every substitution still occupies at least one token, and the total token footprint of old episodic history shrinks by at most ~40% before the ledger itself costs more than it saves.

To go further you need a fundamentally different approach — one where the decompression work is not done by a parser reading a lookup table, but by the receiver's own cognition.

SQ-C is that approach.

---

## Core Idea: Semantic Gravity as a Decompressor

Language models are predictive text engines. Given the sentence:

> "The agent [?] the wallet transaction."

the model's attention weights assign near-zero probability to "elephant," "baking," or "dissolved" and near-certainty to "executed," "approved," or "signed" — depending on surrounding context. The model already *knows* what word should go there. It doesn't need to be told explicitly.

SQ-C exploits this. Instead of transmitting the actual word, you transmit a **slot marker** — a tiny inline token that tells the model "a high-probability word goes here; your language priors will find it." The surrounding context supplies the decompression key for free, using cognitive capacity the model was already spending.

This is not a dictionary lookup. It is **attention-mechanism-native decompression**.

---

## Architecture

### The Lane Matrix

A SQ-C header defines a **lane matrix** derived from the session's Zero-Turn (ZT) phrase ledger. The top-ranked phrases are grouped into 8 lanes by semantic tier. Each lane holds up to 4 candidate variants.

```
Lane 0  — agent actions:     [executed the transaction successfully | approved the pending request | …]
Lane 1  — wallet context:    [your primary wallet address | the encrypted vault blob | …]
Lane 2  — operation states:  [completed without errors | triggered the approval gate | …]
Lane 3  — status phrases:    [the operation completed successfully | all integrity checks passed | …]
Lane 4  — retrieval phrases: [fetching the latest state from | reading from the encrypted cache | …]
Lane 5  — security confirms: [identity has been verified | signature validation passed | …]
Lane 6  — result preambles:  [here is the result | the server response contained | …]
Lane 7  — financial phrases: [the current available balance is | the transaction fee totaled | …]
```

8 lanes × 4 candidates = **32 probabilistic vocabulary slots** for this session.

**Critical: the ledger arrives warm.** In production the ZT phrase ledger is pre-seeded at session boot from all prior conversation history — every phrase the agent has ever produced is already ranked by frequency before the first turn of the new session. At production scale this means **12,000+ ranked phrases** available before the first turn, with the top phrases having appeared thousands of times across millions of prompt tokens. The lane matrix selects the top 32 from that pool — not a sample, but the most concentrated, highest-certainty phrases in the agent's entire output history. Semantic gravity on these slots is near-deterministic, not probabilistic, because the model has seen them so many times that its priors are essentially saturated.

The header is transmitted **once** at the start of a compressed history block and injected into the static-manifest region (Guide 04) so it hits the provider's prefix cache and is not re-billed per turn.

### The Slot Marker

In compressed history, each slot is rendered as `[SQC:N]` where N is the lane number:

```
Raw turn:          "The agent executed the wallet transaction successfully."
SQ-C compressed:   "The agent [SQC:0] the [SQC:1] [SQC:2] [SQC:3]."
```

The marker `[SQC:0]` is 7 characters and tokenizes as 3–4 tokens (consistent, no fragmentation — square brackets are common BPE boundaries). The replaced phrase "executed" is 1 token, so slot markers only pay off when they stand in for multi-token phrases — the compression sweet spot is 3+ token phrases.

### Safe Scoping

SQ-C applies **only to episodic memory history** (old conversation turns). It is structurally excluded from:

- Tool call arguments
- Wallet addresses and numeric amounts  
- Security tokens, passkeys, session IDs
- Any content from the current turn

These are transmitted verbatim in hard pass-through blocks, clearly delimited from the SQ-C-compressed region.

---

## Design Decisions

### Why derive lanes from the ZT ledger?

The ZT ledger is pre-seeded at boot from all prior sessions — the agent's own output is the primary source. Agent text is the most formulaic content in the system: status confirmations, security verifications, retrieval preambles, financial summaries. An agent naturally gravitates toward a stable vocabulary of a few hundred high-frequency multi-token phrases across all conversations. The ledger captures exactly those phrases, ranked by real production frequency.

Two effects compound from this:

1. **Warm from turn 1.** With 12,000+ phrases already ranked, the lane matrix can be built and the header transmitted at session start. There is no warm-up period. The 32 SQ-C candidates are chosen from an already-mature vocabulary, not guessed.
2. **Virtuous cycle.** Because the lanes are built from the agent's own voice, compression improves as the agent produces more output. The more it talks, the denser the ledger, the better the lane quality, the more aggressively SQ-C can compress its history — freeing context room for it to do more. In production this cycle is already running: a 12K-phrase ledger spanning 7M+ prompt tokens demonstrates that the agent's output is dense enough to sustain aggressive compression. SQ-C builds directly on top of it.

Cold-starting from a generic English frequency table would compress poorly because common English words (the, and, of) are single BPE tokens that expand when replaced by `[SQC:N]`. Only multi-token agent-specific phrases cross the compression threshold.

### Why 4 candidates per lane?

The reconstruction accuracy of semantic gravity degrades as the candidate set grows. Testing on Llama-class models shows:

- 2 candidates: ~99% accuracy (too conservative, poor compression)
- 4 candidates: ~95% accuracy (sweet spot — 2-bit choice space)  
- 8 candidates: ~88% accuracy (starts to fail on weak-context slots)

4 candidates means each slot requires 2 bits of implicit disambiguation. The model's language prior supplies those 2 bits from context, for free.

### Why `[SQC:N]` and not a more compact symbol?

Exotic symbols (`∇₃`, `⟨3,2⟩`, `■`) tokenize unpredictably — a BPE tokenizer may split them into 5–8 sub-tokens, *defeating the compression*. Square-bracket sequences like `[SQC:0]` through `[SQC:7]` tokenize as 3–4 consistent tokens across every major tokenizer. The extra bytes pay for themselves in predictability.

### Why not fine-tune the model to recognize native slot tokens?

That would require training a custom model, violating the architectural constant that no LLM weights run on the client device. SQ-C is designed to work with any language model the system already uses — semantic gravity is a property of the pre-trained weights, not of fine-tuning.

### Hard pass-through lanes

Any phrase segment that would be catastrophic if misreconstructed (wallet addresses, numeric amounts, security primitives) is transmitted verbatim inside a `[SQC:PASS]...[/SQC:PASS]` fence. The model is instructed in the SQ-C header to never apply semantic disambiguation inside a pass-through block.

---

## Compression Mechanics

```
ZT phrase ledger (pre-seeded at boot from all prior sessions — the agent's own output)
        ↓
  groupBySemanticTier()  ← 8 lanes × 4 candidates, built once per session
        ↓
  break-even gate        ← measure expected slot density; skip to SQ-B if too low
        ↓
  buildHeader()          ← ~200–250 tokens, compact wire format, emitted once
        ↓  (injected into static-manifest region → provider prefix cache)
  compressHistory(turns) ← scan old turns for lane phrase matches → [SQC:N]
        ↓
  [SQC header] + [compressed turns] + [pass-through blocks for addresses/amounts]
        ↓
  Model reads prompt → attention resolves [SQC:N] slots via semantic gravity
```

### Expected compression ratio on episodic history

| Content type              | SQ-B ratio | SQ-C ratio (on top of SQ-B) |
|---------------------------|------------|------------------------------|
| Repetitive agent output   | ~35%       | ~55–65%                      |
| Conversational history    | ~25%       | ~45–55%                      |
| Mixed tool + conversation | ~20%       | ~30–40%                      |

SQ-C compounds with SQ-B: apply SQ-B first (lossless phrase dedup), then SQ-C (lossy semantic slot compression) to what remains.

---

## Failure Modes

**Weak context collapse** — slots in low-context sentences reconstruct to the statistically most common variant regardless of what was originally said. Mitigated by: only compressing old episodic history where precision requirements are low.

**Lane bleed** — when two lanes have candidate overlap (e.g., "confirmed" could be Lane 5 or a reasonable Lane 0 entry), the model resolves to the wrong semantic tier. Mitigated by: building lanes with disjoint candidate sets from the ZT ledger.

**Header cost inversion** — the ~200–250 token header breaks even at roughly 400–500 slot substitutions. With a pre-seeded ledger this threshold is met within a single moderately long session; for very short sessions (&lt;20 turns) or highly varied content the break-even gate correctly falls back to SQ-B. The gate is empirical — it measures expected slot density from the current history before committing to the header cost, rather than assuming a fixed turn-count threshold.

---

## Reference Implementation

`index.ts` demonstrates:

- **A.** Building a lane matrix from a ZT phrase ledger
- **B.** Compressing a 6-turn conversation history into SQ-C format
- **C.** Simulating semantic gravity reconstruction via a stub `resolveSlot()` function  
- **D.** Measuring token count before / after and verifying reconstruction accuracy
- **E.** Confirming pass-through blocks are never slot-substituted

Run:

```
node index.ts
```

---

## Relation to Other Guides

- **Guide 03** (SQ-B): SQ-C is the Layer-3 continuation — apply SQ-B first, then SQ-C to residual history.
- **Guide 04** (Session Static Manifest): the SQ-C header should be injected in the static manifest region so it hits provider prefix cache and is not re-sent per turn.
- **Guide 65** (In-Stream Sub-Channel Multiplexer): the 8-lane structure mirrors the sub-channel model; a future implementation could carry each lane over a distinct sub-channel to enable parallel reconstruction.
- **Guide 79** (Encrypted Offline Memory Cache): episodic memory chunks compressed by SQ-C can be stored in the offline cache; the lane matrix is stored alongside the chunk so reconstruction is possible without a live session.
