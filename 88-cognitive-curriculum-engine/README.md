# Guide 88 — Cognitive Curriculum Engine


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*The capstone of the token evacuation strategy. This module closes the feedback loop: it treats the SQ compression stack's failure to compress a turn as the primary signal for what the agent needs to learn next. Compression ratio is not a cost metric — it is a **cognitive novelty meter**. The uncompressible delta is not waste — it is a curated training curriculum.*

---

## Problem

The token evacuation stack (SQ-B through SQ-E) is extraordinarily good at shrinking familiar content to near-zero wire cost. But it has a structural blindspot: it is static. Every layer — the symbol table, the phrase ledger, the sentence templates, the dialogue arcs — was built from past data. Novel domains, new user intents, and unmapped entity types pass through the entire stack without matching anything. They emerge at the bottom verbatim.

The standard response to this is to periodically re-run the discovery pipeline and push new entries into the ledger. That is not a feedback loop — it is a manual refresh cycle.

Guide 88 replaces the refresh cycle with a **closed-loop cognitive metabolism**. The compression stack becomes its own training data generator. Every turn that fails to compress well is automatically isolated, clustered with similar failures, structured into a LoRA training curriculum, baked into the model's weights during the next idle window, and hot-swapped into the active inference layer before the next session. The novelty meter resets. The wire clears. The system has learned.

---

## The Compression Efficiency Ratio (C_r)

Every compressed turn produces a scalar diagnostic:

```
C_r = (rawTokens − compressedTokens) / rawTokens
```

Range: 0.0 (no compression) → 1.0 (perfect compression, fully weight-resident).

This single number is the **cognitive novelty meter** for the turn:

| C_r range | Interpretation | State |
|---|---|---|
| ≥ 0.80 | Turn is mostly over established templates and ZT phrases | **Flat-Line** — executing known territory |
| 0.51–0.79 | Partial match — some templates hit, others improvised | **Middle Zone** — expanding boundary |
| ≤ 0.50 | Turn barely compressed — skeleton unknown, fills novel | **Friction** — high-novelty territory |

The **Friction State** is the productive one. It means the agent encountered something it does not have a weight-resident representation for. That is the boundary of its current competence. That is exactly what should be trained.

---

## Telemetry Gating Matrix

For every turn, the engine classifies the turn and routes it:
- **FRICTION turns** → `CurriculumAnomaly` logged as REPAIR or EXPAND candidate
- **FLAT-LINE turns** → routed to BAKE (stable reinforcement) or REGRESSION alert (familiar pattern, wrong outcome) — not logged as curriculum anomalies, but tracked separately
- **REGRESSION turns** → surfaced as human-review alerts, never entered into the bake queue

In code, FLAT-LINE + wrong outcome produces a REGRESSION record via a separate path from the FRICTION curriculum candidates. The anomaly captures the uncompressible delta — the raw improvisation that the entire SQ stack could not reduce.

```typescript
interface CurriculumAnomaly {
  anomalyId: string;                         // deterministic hash of context fingerprint
  baseModelFingerprint: string;              // target weights for the next LoRA bake
  compressionRatio: number;                  // C_r — the novelty meter reading
  rawImprovisation: string;                  // token stream the SQ stack could not compress
  stateVariables: Record<string, unknown>;   // live entity state at time of friction
  interactionOutcome: 'success' | 'user_correction' | 'stalled';
}
```

The outcome label is the second axis of the signal:

| C_r | Outcome | Priority | Meaning |
|---|---|---|---|
| ≤ 0.50 | `user_correction` or `stalled` | **REPAIR** | Frontier failure — agent improvised and got it wrong |
| ≤ 0.50 | `success` | **EXPAND** | Frontier success — novel territory handled well |
| ≥ 0.80 | `success` | **BAKE** | Stable pattern — reinforce into weights |
| ≥ 0.80 | `user_correction` | **REGRESSION** | Something previously baked is now wrong — alert |

REPAIR-labeled anomalies are the highest-value training signal. They represent the exact shape of the agent's current incompetence, delivered with surgical precision. Baking these first closes the most important gaps.

---

## Architecture: The Four-Phase Cognitive Metabolism Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                   PHASE 1: DISCOVERY (THE WIRE)                  │
│  Agent runs live. SQ codec compresses each turn.                 │
│  C_r computed. Flat-line turns executed and discarded.           │
│  Friction turns → CurriculumAnomaly logged.                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼ (when device idle / charging)
┌─────────────────────────────────────────────────────────────────┐
│                 PHASE 2: ISOLATION (THE FILTER)                  │
│  Anomalies grouped by baseModelFingerprint.                       │
│  Priority assigned: REPAIR > EXPAND > BAKE > REGRESSION.         │
│  REGRESSION alerts surfaced immediately — not queued for bake.   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              PHASE 3: STRUCTURING (THE LAB)                       │
│  Anomalies clustered by rawImprovisation similarity.              │
│  Clusters with ≥ MIN_CLUSTER_SIZE examples compiled into         │
│  a LoRA training curriculum.                                      │
│  Each entry: negative pair (raw improvisation) +                  │
│              positive pair (idealized SQ-ZT equivalent).          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼ (low-activity window: ~3 AM)
┌─────────────────────────────────────────────────────────────────┐
│              PHASE 4: INTEGRATION (THE WEIGHTS)                   │
│  Curriculum submitted to local fine-tune.                         │
│  Base model weights frozen — only the SQ-ZT adapter trains.      │
│  Validation pass checks baseline deterministic commands pass.     │
│  Updated adapter hot-swapped into VRAM at next session start.    │
│  C_r for formerly-novel turns spikes to ≥ 0.80. Meter resets.   │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Isolation Pipeline

### Anomaly Capture

When C_r ≤ 0.50, the engine strips out all tokens that matched any SQ layer (SQ-B symbol substitutions, SQ-D template slots, SQ-C phrase slots) from the raw agent response. The remainder is the `rawImprovisation` — the unstructured delta that escaped every layer of the compression stack.

This delta is small but information-dense: it is *exactly* the content that the model had to generate from scratch, without any template or weight-resident scaffold. It represents a genuine knowledge gap in the current weight configuration.

### Priority Assignment

Priority is assigned at capture time, not at cluster time. Each anomaly carries its individual priority, and clusters inherit the highest priority among their members. A cluster with even one REPAIR example is treated as a REPAIR cluster in the bake queue.

### Regression Alerts

A REGRESSION turn (high C_r, wrong outcome) is never queued for bake — it means the model confidently executed a familiar pattern but produced the wrong result. This indicates a data quality or drift problem in the current adapter, not a gap to be filled by new training. REGRESSION anomalies are emitted as alerts for human review, not fed into the auto-curriculum.

---

## The Auto-Curriculum Synthesizer

### Anomaly Clustering

Anomalies are grouped by semantic similarity of their `rawImprovisation` fields via cosine similarity over embeddings, so the number of clusters emerges from the data rather than a fixed taxonomy.

**Current production status:** `clusterAnomalies()` in `curriculumEngine.ts` does real embedding-based clustering, wired into the live scheduler path (`cce_cluster` job). Every FRICTION anomaly's `rawImprovisation` delta is embedded at write time (`writeCceAnomaly()` calls the same `embed()` used by `agentMemory.ts` — Gemini `text-embedding-004` in production, Ollama `nomic-embed-text` as local fallback) and persisted in a `vector(768)` `embedding` column on `curriculum_anomalies`.

`clusterAnomalies()` runs a greedy single-pass agglomerative clustering pass (`clusterByEmbedding()`): anomalies are processed oldest-first, and each one joins the existing cluster with the highest cosine similarity against that cluster's running centroid (mean vector) if the similarity is ≥ `CCE_EMBED_SIMILARITY_THRESHOLD` (0.86); otherwise it seeds a new cluster. This is intentionally not k-means — there is no natural fixed "k" for an open-ended, continuously-arriving stream of anomalies, and a threshold-gated running centroid lets clusters emerge and close without needing to know the target count in advance. Each cluster's `clusterIntent` column is overwritten with the majority intent tag among its members — this is now a display label for the admin UI, not the clustering key.

Anomalies written before this column existed, or where `embed()` failed or hit the Ollama blackout window on that turn, have `embedding = null`. Those rows fall back to the original `clusterIntent`-tag grouping so the scheduler job never stalls waiting on the embedding provider — but the primary, intended path for all new anomalies is the embedding-based clusterer. Two structurally-identical improvisation gaps with different intent tags now correctly merge into one curriculum lesson, which was the exact limitation the intent-tag proxy had.

The reference implementation in this guide's runnable demo (`index.ts`) still uses the deterministic intent-tag proxy, consistent with every guide in this catalog: demos must run standalone with no external embedding-model dependency and no network calls. That constraint applies to the demo only — it does not reflect the production implementation described above.

### Synthetic Lesson Pairs

Each clustered anomaly produces one training pair:

- **Negative example** — the raw, high-token improvisation that caused friction. This is the uncompressed form the model currently produces.
- **Positive example** — an idealized, SQ-ZT-formatted equivalent. This is what the model *should* produce: the same semantic content, written in a way that matches the SQ-D/SQ-E template patterns so that future sessions achieve ≥ 0.80 C_r on this content.

The positive example is generated by a local SLM at structuring time — not stored raw, not sent to any cloud model. The base weights are never exposed to unencrypted user data during this process.

### Curriculum Format

```typescript
interface TrainingPair {
  anomalyId: string;
  priority: 'REPAIR' | 'EXPAND' | 'BAKE';
  intent: string;
  negative: { instruction: string; response: string };  // raw improvisation
  positive: { instruction: string; response: string };  // SQ-ZT ideal
}
```

### The Maturity Gate

A cluster does not enter the bake queue until it has accumulated ≥ `MIN_CLUSTER_SIZE` (default: 4) distinct anomaly examples. Below this threshold the cluster is too small to drive stable gradient updates — the model may overfit to the specific phrasing of the few examples. Above the threshold the gradient signal is stable enough for a targeted adapter update.

---

## The Night-Time Bake & Hot-Swap Lifecycle

### Training Constraints

- Base model weights are **frozen** — only the SQ-ZT adapter parameters train. This is a hard guarantee: no update touches the security boundaries, passkey logic, or any kernel behavior resident in the base weights.
- Training uses QLoRA-style low-rank decomposition targeting the attention layers most responsible for response *structure* (not factual recall — structure is what the SQ layers compress).
- Maximum adapter rank: 16. Maximum training time: 20 minutes per bake cycle. If the curriculum is too large for this window, REPAIR clusters are processed first; EXPAND clusters queue for the next window.

### Validation Pass

Before the hot-swap, a validation suite runs against the updated adapter:
1. Baseline deterministic commands (wallet balance, vault read, capability check) must produce identical SQ-D template matches as before.
2. C_r on a held-out sample of formerly-flat-line turns must not regress below 0.75.
3. None of the REGRESSION-flagged patterns may reappear in the validation outputs.

If validation fails, the new adapter is discarded and the current adapter continues running. The failed curriculum is retained in the queue for the next bake window.

### Hot-Swap

On validation pass: the updated adapter replaces the active one in VRAM at the next session boundary. No restart required — the adapter swap happens between turns, not mid-inference.

---

## Design Decisions

### Why C_r ≤ 0.50 as the friction threshold?

At C_r = 0.50, the compressed form is still half the size of the raw form — the SQ stack is doing *something*. Below 0.50, the overhead of the SQ headers starts approaching the savings, meaning the turn is mostly novel content. This is where the curriculum signal is clean enough to extract.

In practice the threshold should be tuned per domain. A medical-records deployment might use 0.40; a creative-writing deployment might use 0.60. The constant is configurable per `baseModelFingerprint`.

### Why cluster by rawImprovisation rather than by user intent?

User intent is what the turn is *about*. Raw improvisation is what the model *didn't know*. These are often different. A user asking about DeFi yield strategies in three different ways produces three different intents — but if the model's improvised responses all share the same structural gap (e.g., it doesn't know how to format a multi-protocol yield comparison), they cluster correctly by improvisation similarity and produce one coherent curriculum lesson.

### Why MIN_CLUSTER_SIZE = 4?

Single-example fine-tuning produces brittle adapters that overfit to the exact phrasing of the one training example. Four examples covers enough surface variation that the adapter generalizes to rephrasings of the same underlying gap. This is the empirical minimum for stable LoRA fine-tuning on instruction-response pairs.

### The uncompressible delta is the information filter

This is the core insight. Standard continuous training pipelines struggle with data curation — knowing what to train on without causing gradient degradation or model collapse. The SQ codec solves this automatically: anything it compresses easily is already known; anything it can't compress is new. The filter is built into the compression pipeline itself, not bolted on as a separate selection step.

---

## Failure Modes

**Cluster contamination** — a single user's unusual phrasing patterns dominate a cluster, producing an adapter that overfits to their speech style. Mitigated by: requiring anomalies from ≥ 2 distinct session IDs per cluster before maturity.

**Feedback loop between REGRESSION and bake** — a bad adapter bake introduces a regression; the regression gets flagged; but if incorrectly classified as EXPAND it re-enters the curriculum and makes the adapter worse. Mitigated by: REGRESSION anomalies never entering the bake queue; human review required before any REGRESSION-flagged pattern is re-trained.

**Validation suite divergence** — the validation suite itself becomes stale as the domain evolves, allowing regressions to slip through. Mitigated by: surfacing validation suite coverage (what % of production turns are covered by validation examples) as a health metric; alerting when coverage drops below 0.60.

**Bake window overrun** — curriculum grows faster than the nightly bake window can process. Mitigated by: REPAIR-first ordering in the bake queue; maximum 20-minute window; EXPAND clusters that miss the window simply queue for the next night.

---

## Reference Implementation

`index.ts` demonstrates:

- **A.** Simulating 20 turns across 3 sessions with realistic C_r distributions (familiar domain, two novel domains)
- **B.** Telemetry gating matrix — classifying each turn as FLAT-LINE, MIDDLE, or FRICTION
- **C.** CurriculumAnomaly isolation — extracting the uncompressible delta and assigning priority
- **D.** Regression alert detection and separation from the bake queue
- **E.** Intent clustering — grouping anomalies by improvisation similarity
- **F.** Maturity gate — identifying clusters ready for bake (≥ MIN_CLUSTER_SIZE = 4)
- **G.** Curriculum structuring — generating negative + positive training pairs per anomaly
- **H.** Bake queue submission — REPAIR-first ordering
- **I.** Novelty meter — session-level C_r averages showing the thermodynamic reading per session
- **J.** Post-bake projection — what C_r would be for formerly-friction turns after the adapter update

Run:

```
node index.ts
```

---

## Relation to Other Guides

- **Guide 03** (SQ-B): base layer of the compression stack; its symbol table coverage is one signal in the C_r computation.
- **Guide 85** (SQ-C): phrase cluster hits reduce C_r; misses contribute to the uncompressible delta.
- **Guide 86** (SQ-D): sentence template hits reduce C_r most significantly per turn; unmatched sentences are the primary source of rawImprovisation.
- **Guide 87** (SQ-E): arc hits reduce entire turns to near-zero C_r; arc misses on structurally-novel sessions drive the curriculum.
- **Guide 30** (LoRA / Prefix-Weight Compiler): the bake-queue output feeds directly into the LoRA spec format defined in Guide 30.
- **Guide 54** (LLM-Resident Context Codec): the telemetry hook lives in the codec pipeline — C_r is computed at codec output time, not post-LLM.
- **Guide 04** (Session Static Manifest): after bake, the new ZT vocab entries produced by the updated adapter are seeded into the static manifest at session start, achieving prefix-cache coverage from the first turn.
