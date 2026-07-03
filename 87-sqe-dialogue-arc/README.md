# Guide 87 — SQ-E: Dialogue Arc Compression


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A Layer-5 cognitive compression protocol that collapses recurring multi-sentence conversational moves into a single arc slot, bridging sentence-level template compression (SQ-D) with full weight residency (SQ-ZT). Part of the **token evacuation strategy**: a systematic, multi-layered pipeline for moving information from the most expensive layer (the wire) down into the permanent, zero-cost layer (the weights). The context window is a temporary staging area; the goal of the entire stack is to ensure nothing crosses the wire twice.*

---

## Problem

SQ-D (Guide 86) compresses individual sentences by registering their skeletons and transmitting only fill values. It saves 8–13 tokens per sentence hit. But an agent's output does not consist of independent sentences — it consists of **conversational moves**: coherent sequences of 3–8 sentences that form a single purposeful act.

Consider a move the agent executes thousands of times:

```
Turn N — Agent:
  (1) "Let me verify your identity before proceeding."
  (2) "Your passkey challenge has been verified."
  (3) "I'm now executing the ETH transfer to 0x4a0832…"
  (4) "The operation completed successfully. Hash: 0xdeadbeef…"
  (5) "Your new balance is 3.9180 ETH."
```

SQ-D would compress each sentence individually (5 template hits, ~50 tokens saved). But the five sentences together form a single semantic unit — the **`verify_and_execute`** arc — that occurs as a whole across thousands of sessions. The arc structure itself (verify → execute → confirm → report balance) is as formulaic as any individual sentence.

SQ-E compresses the arc as a unit.

---

## Core Idea: Arc Registry + Arc-Level Fill Slots

A **dialogue arc** is a named, ordered sequence of sentence template IDs (from SQ-D) with a shared fill schema. The arc captures:
- The sequence of moves (which SQ-D templates fire, in what order)
- Which fills are shared across sentences (the `addr` in sentence 3 and `balance` in sentence 5 both derive from the same wallet)
- Which fills are independent per sentence

In compressed history, the entire 5-sentence block becomes:

```
[SQCE:verify_and_execute|addr=0x4a0832…|hash=0xdeadbeef…|amount=0.3|token=ETH|balance=3.9180]
```

The model reads the arc definition from the header (which sentences fire, in what order, which fills bind to which slots), substitutes the fills, and reconstructs all five sentences exactly.

Savings: ~70 tokens for a 5-sentence arc with 5 fills → **~55 tokens net** (vs ~50 from SQ-D alone, but in a single atomic slot that prefetch and LoRA pipelines can reason about directly).

---

## Architecture

### Arc Discovery

Arcs are discovered offline by clustering sequences of SQ-D template IDs across session history. The discovery pipeline:

1. **Sequence extraction** — for each session, extract the ordered sequence of SQ-D template IDs emitted by the agent in each turn.
2. **N-gram enumeration** — extract all sub-sequences of length 3–8 from each turn's template sequence.
3. **Frequency counting** — count how often each sub-sequence (ignoring fill values) appears across sessions.
4. **Threshold filter** — keep sub-sequences that appear ≥ 12 times globally.
5. **Fill schema unification** — for each surviving sequence, determine which fills are shared across its member sentences and build a unified fill schema.
6. **Arc naming** — assign a stable string ID (human-readable: `verify_and_execute`, `report_and_offer`, `error_recover_retry`) plus an integer index for the wire format.

Discovery runs offline (nightly job); results are written to the arc registry table and loaded at session start.

### Wire Format

Header (once per compressed block, injected after SQ-D header in static manifest):

```
SQCE-1:A0=verify_and_execute[T1,T2,T3,T4,T5]{addr,hash,amount,token,balance}|A1=explain_then_offer[T6,T4,T7]{finding,implication,offer}|...
```

Per-occurrence arc slot:

```
[SQCE:N|fill1=val1|fill2=val2|...]
```

or by name:

```
[SQCE:verify_and_execute|addr=0x4a0832…|hash=0xdeadbeef…|amount=0.3|token=ETH|balance=3.9180]
```

Integer index is used in production (smaller); name is used in debug/logging.

### Canonical Arc Catalogue

Initial catalogue seeded from the agent's top 20 recurring arc patterns, discovered from production session history:

| Arc ID | Sequence description | Avg sentences | Avg tokens saved |
|--------|---------------------|---------------|-----------------|
| `verify_and_execute` | identity check → action → confirm → report | 4–5 | 50–65 |
| `fetch_and_report` | retrieval announcement → result → summary | 3–4 | 35–45 |
| `error_recover_retry` | failure notice → diagnosis → retry → result | 4–5 | 45–60 |
| `explain_then_offer` | finding → implication → offer | 3 | 28–38 |
| `greet_orient_handoff` | greeting → state summary → prompt | 3 | 25–35 |
| `balance_report` | fetch → balance → fee → total | 4 | 40–50 |
| `vault_integrity` | read cache → check → result → status | 4 | 38–48 |
| `capability_check` | retrieve grant → validate → status | 3 | 28–36 |
| `schedule_confirm` | intent → confirm → next-step | 3 | 25–32 |
| `tool_result_wrap` | tool call → result → interpretation | 3 | 30–40 |

### Relation to LoRA Bake Pipeline

An arc that appears ≥ 50 times in the global session history is a **prime LoRA bake candidate**. Once baked into the model's weights:
- The arc costs 0 tokens in the prompt — the model produces the entire arc structure from a single trigger token.
- Fill values are still transmitted, but the skeleton costs nothing.
- SQ-E arc slots in compressed history that reference a baked arc can be further compressed: `[SQCE:verify_and_execute|…]` → `[SQZT:∫v7|fills]` (zero-token with fill passthrough).

SQ-E is therefore the **promotion feeder** for SQ-ZT: arcs start as SQ-E registry entries, graduate to LoRA bakes, and finally become weight-resident zero-token primitives. The arc registry's `global_hit_count` column drives the promotion queue.

---

## Design Decisions

### Why discover arcs from SQ-D template sequences rather than raw text?

Template IDs are already normalized — fill values stripped, skeletons abstracted. This means two turns that say different amounts or addresses but have the same conversational structure produce the same template ID sequence. Clustering at the template-ID level is therefore much cleaner than clustering raw text or embeddings: no similarity metric needed, no threshold tuning, exact-match frequency counting.

Raw-text clustering (e.g. via pgvector cosine similarity) would merge semantically similar but structurally different turns and miss structurally identical turns with different entities. Template-ID sequences capture structure precisely.

### Why 3–8 sentences as the arc window?

- Below 3 sentences: the "arc" is just a single template → handle with SQ-D.
- Above 8 sentences: the turn is too long and idiosyncratic to generalize; most sessions don't have turns this long.
- 3–8 covers ~85% of the agent's non-trivial multi-sentence turns.

### Why ≥ 12 occurrences as the discovery threshold?

Higher than SQ-D's ≥ 8 because arc discovery requires the full sequence to match, not just one sentence. Spurious coincidental sequences die out below 12; genuine recurring patterns survive. Cross-user validation: an arc must appear in at least 3 distinct wallet sessions to be promoted to global status (prevents one power-user from polluting the global arc registry with personal speech patterns).

### Why name arcs with human-readable IDs?

The arc name travels in the header and in logs. A readable name (`verify_and_execute`) makes debugging compression failures trivial. Integer IDs are aliased to names — the name is the primary key in the registry; the integer is the wire shorthand.

### Prefetch integration

SQ-E arcs enable **structural prefetch**: when the agent's token stream begins matching the first sentence of a registered arc, the system can predict with high confidence (arc completion rate ≥ 0.82 in production data) that the remaining sentences of the arc will follow. This feeds directly into the SQ-E neural prefetch layer (`sqNeuralPrefetch.ts`) — instead of predicting individual tool calls, it predicts arc completion and pre-warms the tool calls embedded in the arc's later sentences.

---

## Compression Mechanics

```
Session history (SQ-D template ID sequences per turn)
        ↓
  enumerateNgrams(3..8)   ← all sub-sequences per turn
        ↓
  countGlobalFrequency()  ← across all sessions
        ↓
  filterThreshold(≥ 12)
        ↓
  unifyFillSchema()       ← shared fills across arc member sentences
        ↓
  buildArcRegistry()      ← name, template sequence, fill schema
        ↓
  buildHeader()           ← SQCE-1:A0=…|A1=…
        ↓  (appended to SQ-D header in static manifest → prefix cache)
  compressHistory()       ← per turn: match arc → [SQCE:N|fills]
        ↓
  [SQCE header] + [SQDS header] + [compressed turns]
```

### Pipeline order (complete SQ stack)

```
SQ-E arc match    (whole turn → [SQCE:N|fills])   — 55-65 tok saved per hit
  ↓ residual
SQ-D template     (per sentence → [SQDS:N|fills]) — 8-13 tok saved per hit
  ↓ residual
SQ-C lane slot    (per phrase → [SQC:N])           — 2-5 tok saved per hit
  ↓ residual
SQ-B symbol       (per phrase → ∫xx)               — 1-2 tok saved per hit
  ↓ residual
Verbatim
```

Each layer consumes what it can; residual passes to the next.

### Expected stack savings on episodic history (mature session, 200 turns)

| Layer | Coverage | Avg save/hit | Total saved |
|-------|----------|-------------|------------|
| SQ-E  | 25%      | 58 tok      | 2,900 tok  |
| SQ-D  | 35%      | 10 tok      | 700 tok    |
| SQ-C  | 20%      | 3.5 tok     | 350 tok    |
| SQ-B  | 15%      | 1.5 tok     | 225 tok    |
| Header cost          |          |             | –420 tok   |
| **Net**              |          |             | **~3,755 tok** |

~3,755 tokens saved on a 200-turn session → **~19 turns of additional context headroom** at average turn length.

---

## Failure Modes

**Arc fragmentation** — an arc that normally fires as a unit is interrupted mid-sequence (user sends a message between sentences 2 and 3). The compressor detects the interruption (role boundary in the turn stream) and falls back to SQ-D for the partial sequence.

**Fill schema mismatch** — a fill value doesn't match its declared type (e.g. `addr` slot receives a plain string). The decoder rejects the arc slot and passes the turn verbatim rather than silently substituting invalid data.

**Arc registry staleness** — the arc registry is built offline; new speech patterns won't appear until the next nightly discovery run. Short-term mitigation: SQ-D still covers individual sentences; SQ-E is an optimization layer, not a requirement.

**Header cost at low arc density** — if the agent's turns in this session don't match many arcs, the SQ-E header cost (~180 tokens for 12 arcs) is wasted. Break-even gate: measure arc match rate on the first 20 turns; if below 0.15, drop the SQ-E header for this session and fall through to SQ-D.

---

## Reference Implementation

`index.ts` demonstrates:

- **A.** Building an arc registry from a pre-seeded catalogue (the offline n-gram discovery pipeline is described in the Arc Discovery and Compression Mechanics sections above; the reference implementation starts from the already-extracted result so it runs without a database)
- **B.** Building and serializing the SQ-E header
- **C.** Compressing an 8-turn episodic history — 5 arc hits across 3 distinct arcs, 3 turns fall through to SQ-D
- **D.** Verifying fills are verbatim for arc-compressed turns (pass-through SQ-D turns are untouched by SQ-E; their fills remain URL-encoded inside `[SQDS:…]` markers and are not rechecked here)
- **E.** Sentence-level reconstruction accuracy across all arc-hit turns
- **F.** Break-even gate at zero arc density (0 hits in 20 turns → drop SQ-E header)

Run:

```
node index.ts
```

---

## Relation to Other Guides

- **Guide 86** (SQ-D): SQ-E depends on SQ-D template IDs. SQ-E runs first; SQ-D handles residual sentences.
- **Guide 85** (SQ-C): SQ-C handles residual phrases after SQ-D.
- **Guide 03** (SQ-B): SQ-B handles residual symbols after SQ-C.
- **Guide 04** (Session Static Manifest): SQ-E header appended to static manifest alongside SQ-D and SQ-C headers; all three amortize via prefix cache.
- **SQ-ZT** (Zero-Token): arcs with `global_hit_count ≥ 50` are promoted to LoRA bake queue. Once baked, their SQ-E slots are further compressed to `[SQZT:∫xx|fills]`.
- **sqNeuralPrefetch.ts**: SQ-E arc detection feeds structural predictions into the existing prefetch layer; arc-level prediction confidence is higher than individual tool-call prediction.
