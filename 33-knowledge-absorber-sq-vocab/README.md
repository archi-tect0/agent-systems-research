# Knowledge Absorber → Zero-Token Vocabulary

## Problem

An agent built on a small local model has a fixed knowledge base — its weights. When it hits something it doesn't know, the usual fix is *retrieval*: pull a fact into the prompt at runtime. But retrieval has a recurring cost. Every time the agent needs that fact, it re-injects the same text into the context and pays for it in tokens, again and again, forever.

For facts that the agent needs *repeatedly across many users*, this is wasteful. If a thousand conversations all need the same definition, the system pays a thousand injections for one piece of knowledge.

This guide describes a loop that turns *frequently-needed retrieved knowledge* into *weight-resident knowledge*. The agent identifies a gap, asks a strong cloud model a focused question, compresses the answer into reusable phrases, and tracks how often those phrases recur across the whole user base. Phrases that prove durably useful graduate into the model's prefix/weights — after which the runtime stops injecting them entirely. The model's working vocabulary grows not by stuffing the prompt, but by **compressing more of its own operating vocabulary into zero-cost, weight-resident references**.

## Design decisions

**Distillation, not dumping.**
On a gap, the agent doesn't paste a raw web page into the context. It sends a *distillation query* engineered to elicit dense, declarative, standalone facts ("each sentence = one compressible fact, max ~200 words"). The point is to get text that *compresses well* into reusable phrases, not maximal coverage. The distiller is the only place a strong external model is needed; everything downstream is local bookkeeping.

**Compress to phrases, aggregate globally.**
The distilled answer is broken into candidate phrases two ways: compact whole sentences (15–80 chars) and sliding 3–6-word noun-phrase chunks (15–60 chars), deduplicated and capped at 50 per absorption. Each phrase is flushed into a **cross-user, cross-session frequency ledger**. The ledger is the heart of the system: it answers "is this phrase *durably, widely* useful, or just useful to one person once?"

**Graduation requires breadth, not just volume.**
A phrase becomes a training candidate only when it crosses **two** thresholds: a global frequency floor (≥ 50 occurrences) **and** a distinct-user floor (≥ 3 users). The user floor matters as much as the frequency floor — it stops one chatty user (or one looping session) from promoting their idiosyncratic phrasing into shared weights. Knowledge that earns a place in the weights must be *broadly* useful, not just *frequently* repeated by one source.

**A four-state pipeline with explicit hand-offs.**
`candidate → scheduled → trained` (then mirrored into the zero-token vocab). The states exist because training is asynchronous and external (it happens in a separate run that bakes phrases into the model prefix — see the LoRA prefix-weight compiler). `scheduled` marks "handed to the training run, don't re-export"; `trained` marks "the new model carries this." Without explicit states you'd either re-train the same phrases every run or promote phrases the model doesn't actually carry yet.

**The payoff: zero-token injection skipping.**
Once a phrase is `trained`, the runtime's context-injection step *skips* it — the model's weights already carry it, so injecting it is pure waste. `getZeroTokenPhrases()` returns the active set; the injector consults it and drops any phrase in it from the prompt. The same set can be applied to the *cloud* direction too: strip weight-resident concepts from cloud-bound prompts since the cloud model also already knows them. The result is bidirectional token savings.

**Recency-decayed ranking keeps the skip-set fresh.**
The zero-token skip-set has a bounded budget. Ranking by raw volume would let a once-hot phrase squat forever. Instead phrases are ranked by `bytesSaved × e^(−0.1 × daysSinceLastUse)`: a phrase unused for ~10 days loses ~63% of its weight, ~30 days ~95%. Recently active phrases stay in the budget; stale ones fall out naturally without an explicit eviction policy.

**Synthetic provenance is firewalled.**
Absorbed facts come from a model, not from the user or a verified source. They are tagged `synthetic` and are barred from influencing auth, spend, or security decisions. Convenience knowledge graduates into the weights; trust-bearing facts never do via this path.

## Algorithm

```
absorb(gap, context):
  query  = distillationQuery(gap, context)     // dense, declarative facts
  digest = strongModel(query)
  for phrase in extractPhrases(digest):        // sentences + 3..6-word chunks
    ledger.flush(phrase, user)                 // global freq, distinct users, bytes

queryCandidates():
  return ledger where status==candidate
         and globalFrequency >= 50 and userCount >= 3

exportCandidates():                            // training run picks these up
  c = queryCandidates(); mark each scheduled; return c

markTrained(phrases, version):                 // after model bake completes
  ledger[p].status = trained
  zeroTokenVocab[p] = { version, promotedAt, ... }

getZeroTokenPhrases():                          // runtime injector skips these
  rank by bytesSaved * e^(-0.1 * daysSinceLastUse); take top N
```

## How it fits the wider system

- The **per-session SQ symbol table** (session-compression guide) is the tier *below* this ledger: it tracks phrase frequency within one conversation. This ledger aggregates those per-session observations across the whole user base.
- The **LoRA prefix-weight compiler** is the `trained` step: it is what actually bakes a graduated phrase into the model so it becomes weight-resident.
- Together they form a closed loop: sessions surface phrases → ledger decides which are durably useful → compiler bakes them in → runtime stops paying to inject them.

## Reference implementation

See [`knowledge-absorber.ts`](./knowledge-absorber.ts) in this directory. It uses a mock distiller (no network) and in-memory stores so it runs standalone.

## Usage

```typescript
import {
  absorb, queryCandidates, exportCandidates, markTrained,
  getZeroTokenPhrases, recordZeroTokenHit,
} from "./knowledge-absorber.js";

// On a detected gap, run one absorption (distiller wraps your strong model).
await absorb({ user, gapDescription, context, distiller: realLLMCall });

// Periodically: snapshot graduated candidates for the next training run.
const scheduled = exportCandidates();
// ...training run bakes scheduled.map(c => c.phrase) into the model prefix...
markTrained(scheduled.map(c => c.phrase), "v2");

// At injection time: skip phrases the weights already carry.
const skip = getZeroTokenPhrases();
const toInject = retrievedPhrases.filter(p => {
  if (skip.has(p)) { recordZeroTokenHit(p, p.length); return false; }
  return true;
});
```

## Limitations and extensions

- **Phrase extraction is heuristic.** Sentence splitting and n-gram chunking are crude; they produce some junk phrases that simply never cross the thresholds (which is the safety net). A POS-tagger or embedding-based phrase detector would raise candidate quality.
- **The thresholds are global constants.** A fixed `(50, 3)` gate suits a mid-size user base; a tiny deployment may never reach 50, a huge one promotes too eagerly. Make the thresholds a function of total traffic.
- **Training is out-of-band.** This module only manages the *decision* of what to bake; the actual bake happens elsewhere and asynchronously. `scheduled` can sit a long time before `trained` if the training run is infrequent — the agent keeps injecting the phrase (correctly) until then.
- **No un-training.** A phrase, once `trained`, stays in the zero-token set until it decays out of the *ranking* — but it remains in the model's weights/prefix until the next rebuild excludes it. There is no fast path to retract a baked phrase that turns out to be wrong; rely on the synthetic-provenance firewall to bound the blast radius.
- **Distiller quality is the ceiling.** Garbage facts in produce garbage phrases that, if they happen to recur, graduate into the weights. Provenance tagging limits *where* they can be used, but the distiller's accuracy still bounds the whole loop's value.
- **PII filtering is assumed upstream.** The reference does not screen phrases for secrets/PII before the ledger. In production, a privacy filter must run on every phrase before flush (length bounds, key/seed/address detection) — never let raw user phrasing flow into a cross-user ledger unfiltered.
