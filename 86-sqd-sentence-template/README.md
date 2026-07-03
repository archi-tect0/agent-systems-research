# Guide 86 — SQ-D: Sentence Template Compression


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A Layer-4 cognitive compression protocol that collapses recurring sentence skeletons to a single slot marker plus explicit fill values, offloading skeleton reconstruction to the model while transmitting only the variable parts that change. Part of the token evacuation strategy — see Guide 87 (SQ-E) for the full stack definition.*

---

## Problem

SQ-C (Guide 85) replaces multi-token phrases with probabilistic lane slots like `[SQC:0]`, relying on semantic gravity to reconstruct the original phrase. It achieves real savings on the phrase level — but it cannot touch the sentence level, because a full sentence contains both formulaic structure (compressible) and variable fills (addresses, amounts, entity names) that must be transmitted exactly.

Consider a sentence the agent emits dozens of times per session:

> "I've retrieved your ETH vault with 17 entries, last updated 2 minutes ago."

SQ-C would compress "I've retrieved your" and "vault with" but must pass through "ETH", "17", and "2 minutes ago" verbatim inside `[SQC:PASS]` fences — leaving the structural skeleton fully intact and costing ~18 tokens. The skeleton is redundant: the agent has written this sentence thousands of times. Only the three fills differ.

SQ-D is the layer that compresses the skeleton explicitly.

---

## Core Idea: Skeleton Registry + Inline Fills

A **sentence template** separates a recurring sentence into:
- **Skeleton** — the invariant syntactic frame ("I've retrieved your `{asset}` vault with `{count}` entries, last updated `{time}`."), stored once in the session header.
- **Fill values** — the variable parts (`asset=ETH`, `count=17`, `time=2 minutes ago`), transmitted inline per occurrence.

In compressed history the sentence becomes:

```
[SQDS:4|asset=ETH|count=17|time=2 minutes ago]
```

The model reads the skeleton from the header, substitutes the fills, and reconstructs the full sentence exactly — zero semantic gravity ambiguity, because fills are transmitted verbatim.

This is **lossless at the fill level, lossy only on the skeleton** (which the model already knows). Fill values are never approximated.

---

## Architecture

### Template Registration

At session start a **template registry** is built from the ZT phrase ledger plus offline analysis of assistant message history. A template is registered when:

1. The same sentence skeleton appears ≥ 8 times across all sessions (frequency threshold).
2. The skeleton contains ≥ 1 fill slot (otherwise it is a pure ZT phrase, handled by SQ-B/SQ-C).
3. The skeleton body is ≥ 6 tokens (below this the header cost exceeds the savings).

Each template is assigned an integer ID and a fill schema (ordered list of slot names with type hints).

```
Template 0:  "I've retrieved your {asset} vault with {count} entries, last updated {time}."
Template 1:  "Your {wallet_type} wallet balance is {amount} {token}."
Template 2:  "The {operation} completed successfully — tx hash {hash}."
Template 3:  "I'm checking your {capability} grant — status: {status}."
Template 4:  "Fetching {resource} from {source} — this may take a moment."
...
```

> **Single-sentence constraint (production note):** each skeleton must be a true single sentence — no `. ` sequence inside, because the compression pipeline splits on `. ` before template matching. Joining clauses with em-dash (`—`) is the standard workaround in this reference. A production implementation should use a proper sentence boundary detector (e.g. SBD via spaCy or Punkt) so skeletons can contain colons and other mid-sentence punctuation without this constraint.

### Wire Format

Header (once per compressed block, injected into static manifest):

```
SQDS-1:T0="I've retrieved your {asset} vault with {count} entries, last updated {time}."|T1="Your {wallet_type} wallet balance is {amount} {token}."|...
```

Per-occurrence slot marker:

```
[SQDS:N|slot1=value1|slot2=value2|...]
```

Fill values are URL-encoded to allow `|` and `=` inside values. Pass-through of addresses is automatic — fill values are always transmitted verbatim, so no `[SQDS:PASS]` fence is needed.

### Fill Type System

| Type    | Pattern                                | Example         |
|---------|----------------------------------------|-----------------|
| `addr`  | `0x[0-9a-f]{40}`                       | `0x4a0832…`     |
| `hash`  | `0x[0-9a-f]{64}`                       | `0xdeadbeef…`   |
| `num`   | `[0-9]+(\.[0-9]+)?`                    | `17`, `4.218`   |
| `token` | uppercase ticker 2-6 chars             | `ETH`, `USDC`   |
| `dur`   | `\d+ (second|minute|hour|day)s? ago`   | `2 minutes ago` |
| `str`   | anything else                          | `dispatch_write` |

Type hints travel in the header schema as documentation. In the reference implementation they are **advisory** — used to detect address/hash fills so they can be verified for verbatim round-trip, but not enforced as strict gates. A production implementation should validate `addr`/`hash` fills against their patterns before substituting into any downstream tool call or UI display, to catch wire-format corruption early.

### Safe Scoping

SQ-D applies only to **episodic history turns** — never to:
- Tool call arguments
- The current live turn
- Any content inside existing `[SQC:PASS]` blocks
- System-critical JSON objects

Fill values that are wallet addresses or transaction hashes receive `addr`/`hash` type tags; the decoder validates the pattern before accepting them.

---

## Design Decisions

### Why transmit fills explicitly rather than via semantic gravity?

SQ-C's semantic gravity works for high-frequency formulaic phrases where the model's prior is nearly saturated (e.g. "executed the transaction successfully" → probability ~0.6 on the top candidate). It does not work for fills:

- "ETH" vs "BTC" vs "USDC" — equally plausible, context-dependent, single error is catastrophic.
- "17" vs "23" vs "142" — no semantic gravity, pure data.
- "0x4a0832e0…" — 40-char address, zero tolerance for error.

Fills must be transmitted verbatim. SQ-D's savings come entirely from compressing the skeleton, not the fills.

### Why register templates in the header rather than inline?

A per-occurrence inline skeleton would cost more than the original sentence. The header amortizes the skeleton cost across all hits. With 20 templates at ~15 tokens each, the header costs ~300 tokens and breaks even at ~35 hits. A session with 200 turns and 40% template coverage (~80 hits) yields net savings of 580 tokens after header cost.

### Why ≥ 8 occurrences as the threshold?

Below 8 occurrences the template has appeared in too few sessions to be reliably extracted from the ZT ledger and may represent a one-user idiosyncracy. At ≥ 8 occurrences across sessions the skeleton is cross-user stable enough to register globally. Per-user high-frequency templates (≥ 4 occurrences for a single wallet) can be registered locally without reaching the global threshold.

### Interaction with SQ-C

SQ-C and SQ-D operate on different granularities and do not interfere. In a compressed history block:

1. **SQ-D first**: scan each sentence for template matches → emit `[SQDS:N|fills]`.
2. **SQ-C second**: scan remaining uncompressed sentences for lane phrase matches → emit `[SQC:N]`.
3. **SQ-B last**: remaining verbatim text runs through the ZT symbol table for symbol substitution.

A sentence that matches a SQ-D template is consumed entirely; SQ-C does not re-scan it.

---

## Compression Mechanics

```
Assistant message history (cross-session)
        ↓
  extractSkeletons()   ← regex-based fill detection per sentence
        ↓
  clusterBySkeleton()  ← exact-match grouping after fill normalization
        ↓
  rankByFrequency()    ← filter to ≥ 8 global occurrences
        ↓
  buildTemplateRegistry() ← assign IDs, extract fill schema
        ↓
  buildHeader()        ← SQDS-1:T0="..."|T1="..."
        ↓  (injected into static manifest → prefix cache)
  compressHistory()    ← per sentence: match template → [SQDS:N|fills]
        ↓
  [SQDS header] + [compressed turns with [SQDS:N|…] markers]
```

### Expected compression on episodic history

| Turn content                    | Tokens raw | Tokens SQ-D |
|---------------------------------|------------|-------------|
| Template hit (avg 3 fills)      | ~18        | ~8          |
| Template hit (addr fill)        | ~22        | ~9          |
| Non-template sentence           | ~14        | ~14 (pass)  |

Net savings per template hit: **8–13 tokens**. With a warm 12K-phrase ledger the initial template extraction identifies 40–80 stable templates covering ~35-50% of the agent's sentence output.

---

## Failure Modes

**Fill extraction error** — the regex fill detector mislabels a structural word as a fill slot, producing a skeleton too specific to match. Mitigated by: requiring ≥ 8 occurrences before registration (spurious skeletons don't accumulate).

**Template collision** — two semantically different sentences produce the same skeleton after fill extraction. Mitigated by: including the first 3 structural words of the skeleton in the match key; false collisions are caught at compression time when fill values don't validate against the fill schema.

**Header bloat** — registering too many templates bloats the header past the break-even point. Mitigated by: capping at 64 templates per session; ranking by (frequency × avg_tokens_saved) and taking the top 64.

**Fill boundary ambiguity** — a fill value that contains `|` or `=` corrupts the wire format. Mitigated by: URL-encoding fill values before serialization.

---

## Reference Implementation

`index.ts` demonstrates:

- **A.** Building a template registry from a pre-seeded catalogue (representative of what offline extraction from real session history would produce — the extraction/clustering pipeline is described in the Compression Mechanics section above; the reference implementation starts from the already-extracted result so it runs without a database)
- **B.** Building and serializing the SQ-D header
- **C.** Compressing a 6-turn history using template matching
- **D.** Break-even gate: the 6-turn demo correctly falls back (11 hits < 19-hit threshold); extrapolation to 500 turns shows net-positive savings
- **E.** Decompressing by substituting fills into the registered skeleton
- **F.** Verifying exact fill round-trip (no semantic gravity — fills are verbatim)

Run:

```
node index.ts
```

---

## Relation to Other Guides

- **Guide 85** (SQ-C): SQ-D runs before SQ-C in the compression pipeline. SQ-D consumes whole-sentence matches; SQ-C handles residual multi-token phrases in non-matching sentences.
- **Guide 03** (SQ-B): runs last, after SQ-D and SQ-C have consumed what they can.
- **Guide 04** (Session Static Manifest): SQ-D header injected alongside SQ-C header in the static manifest region; both amortize over the session via prefix cache.
- **Guide 87** (SQ-E): SQ-E clusters sequences of SQ-D-matched template slots into dialogue arc slots, compressing at the paragraph level. SQ-E depends on SQ-D having already identified sentence-level templates.
