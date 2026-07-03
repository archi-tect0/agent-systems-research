# Guide 100 — Automatic Post-Turn Self-Audit and Style-Drift Correction


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A background, best-effort reviewer that checks every turn against known style/personality commitments, flags specific violations with actionable adjustments, and nudges a persistent preference profile — all without ever touching the user-visible response.*

---

## Problem

Without a background reviewer, an agent's known personality and style commitments (brevity, tone, structure, honesty about its own limitations) silently drift over time because nothing is checking each individual turn against those commitments. A human only notices after several bad turns have already happened, if they notice at all — there's no cheap, continuous, per-turn quality signal.

## Design decisions

- **Classify each turn into a small number of interaction modes** (tool-driven, memory-directed, reasoning-heavy, personality/open-ended, general-conversational) using cheap keyword/marker heuristics on the user message, the tool used, and the reply — not an extra LLM call. This keeps the whole audit pass nearly free and strictly non-blocking.
- **Each mode owns its own small rule-set of audit checks**, rather than one universal rule-set applied everywhere. An overly long reply to a short prompt matters in general conversation; a suspicious "I don't have feelings" hedge only matters in personality-mode turns; jargon density only matters in reasoning-heavy turns. Scoping checks to their mode keeps false-positive noise down.
- **Every flag maps deterministically to a specific suggested adjustment string**, not just a bare complaint — a downstream consumer (a later turn's prompt-builder, or a human skimming an audit log) needs an actionable line, not a vague "something was off."
- **Small numeric style deltas are estimated from the same turn and folded into a persistent preference profile via a slow EMA**, separate from the flags. Flags are per-turn and immediate; the profile is cross-session and should only move gradually — the same "no single turn should swing a durable preference" principle as Guide 99's rating weights and Guide 98's calibrated constants.
- **The entire pass runs asynchronously, after the user-visible response has already been sent, and any internal failure is swallowed rather than surfaced.** A background quality check must never be able to delay, block, or crash the actual user-facing turn — that would make the cure worse than the disease.

## Algorithm

```
mode  = classify(userMessage, toolUsed, reply)          // cheap heuristic classifier
flags = ruleset[mode](userMessage, reply)               // mode-scoped checks only
adjustments = flags.map(f => adjustmentTextFor(f))

delta = detectStyleDelta(userMessage, reply)             // small numeric deltas: brevity, formality, depth
prefs[dimension] = prefs[dimension] * (1 - α) + delta[dimension] * α   // slow EMA, per dimension

persist({ turnId, mode, flags, adjustments })            // best-effort; failures are logged and swallowed
persist(prefs)                                           // best-effort
// runs after the response has already been returned to the user
```

## Reference implementation

`index.ts` runs several synthetic turns through the classifier and rule sets: a verbose reply to a short prompt (should flag length), a tool-driven turn with thin, unhelpful prose (should flag under-explanation), a reasoning-heavy turn dense with unexplained jargon (should flag jargon density), a personality-mode turn containing a hedge phrase (should flag the hedge), and one clean turn that should produce zero flags. It also demonstrates that implicit preference deltas accumulate gradually across repeated similar turns rather than jumping after one.

```bash
node index.ts
```

## Limitations and extensions

- Heuristic classification and rule checks will misfire sometimes — a reasoning-heavy turn that happens to use domain jargon the user actually understands isn't really a style problem. Treat flags as a signal to a human or a later review pass, not an automatic behavioral override.
- This is a detection-and-suggestion layer, not an enforcement layer — nothing here rewrites the reply that was already sent. Combine it with Guide 98's calibration pattern if you want the *thresholds* used by these rule-sets themselves to self-tune from labeled outcomes over time.
- The mode classifier and rule-sets are intentionally small and fixed here for auditability; a system with many more interaction modes should keep the same "cheap heuristic, mode-scoped rules" shape rather than growing into a full second LLM call per turn.
