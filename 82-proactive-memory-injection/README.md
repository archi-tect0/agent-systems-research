# Guide 82 — Proactive Memory Pre-injection


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Eliminates the recall round-trip by surfacing episodic memory before the LLM speaks.*

---

## Problem

Kylum's memory subsystem (pgvector + `agentMemoriesV2` table) is episodic and queryable, but the default access path is reactive: the agent must spend a tool-call round-trip calling `recall_memory` before it can reference stored facts.

This creates two failure modes on sovereign-AI workloads:

1. **Cold first reply.** On the first token of a response, the model has no episodic context. It either hedges ("I don't know your preference") or guesses. A second turn is wasted confirming what the memory already knows.
2. **Silent omission.** Some models never call `recall_memory` unprompted even when context would improve the reply — they satisfice on the conversation window.

Neither is acceptable for a Jarvis-grade assistant whose job is to act on everything the user has ever told it.

---

## Design decisions

### Why inject into the RAG block rather than a second system message

Most LLM APIs enforce a single leading system message. Adding a second `role: "system"` entry either fails, silently merges, or triggers undefined model behaviour. The system prompt already has an established RAG section (`preloadedRagKnowledge`) that the model is trained to consume. Appending the memory block there is robust across all backend adapters (OpenAI, Anthropic, Gemini, Ollama, relay).

### Why pre-inject instead of caching the tool call result

A cached `recall_memory` result still requires a full tool-call round-trip on the first turn of a session before the cache warms. Pre-injection bypasses the round-trip entirely by running `searchMemory()` in the pre-flight phase, in parallel with RAG retrieval, before the system prompt is assembled.

### Gating conditions

Pre-injection runs only when all three conditions hold:

1. Not an early-interrupt turn (the turn is synthetic / abort).
2. Not a proactive scheduler turn (`__proactive__` content) — no user intent to ground the query.
3. User message is ≥ 8 characters — very short messages ("ok", "yes") produce noisy recall results with high false-positive rate at k=4.

### k=4, query cap 350 chars

Four results covers the "working memory" horizon without bloating the system prompt. The query is capped at 350 characters: embedding models are trained on sentence-length inputs; truncation at 350 chars preserves semantic intent while bounding the embedding latency to < 80 ms.

### Non-fatal

`searchMemory()` calls the OpenAI embeddings proxy. If the proxy is unavailable (cold restart, rate limit), the pre-injection silently skips and the model falls back to explicit `recall_memory` calls. A failing pre-injection must never block the turn.

### Instruction to suppress re-fetch

Injected memories carry the header:
```
RECALLED FROM LONG-TERM MEMORY (pre-injected — act on these, do not call recall_memory to re-fetch):
```
Without this, models that see relevant memories in the context still call `recall_memory` out of habit, wasting a round-trip and potentially producing a slightly different ranked result.

---

## The injection site

```
phase-2 pre-flight batch completes (parallel RAG + DB reads)
          │
          ▼
caps resolved (effective write grant set)
          │
          ▼                               ← serial await, not parallel
[NEW] searchMemory({ wallet, query: rawContent[:350], k: 4 })
          │ k results or []
          ▼
_ragWithRecall = preloadedRagKnowledge + "\n\n" + memories block
          │
          ▼
buildSystemPrompt(..., _ragWithRecall, ...)
          │
          ▼
LLM call — model already has episodic context on token 1
```

**Note on parallelism:** The phase-2 batch (RAG retrieval, personality load, message insert) runs as `Promise.allSettled`. The proactive recall runs *after* that batch completes, as a serial `await` before prompt assembly. A future optimisation could overlap it with the tail of phase-2, but the current implementation is deliberately simple: the added latency is typically < 80 ms (embedding + pgvector query) and this is the same order of operations as any other pre-flight step.

---

## Properties

| Property | Mechanism |
|---|---|
| Zero extra round-trips | Injected in pre-flight, not via tool call |
| Safe on all backends | Appended to existing RAG block — no second system message |
| Re-fetch suppression | Explicit header instructs model not to call `recall_memory` |
| Non-blocking | try/catch — turn proceeds even if embedding fails |
| Scoped to real turns | Guards on `!earlyInterrupt && !isProactive && length >= 8` |
| Consistent ranking | Same `searchMemory()` path as explicit recall — pgvector cosine |
| Write-side trace | All consequential write tools (`set_conviction`, `remember_entity`, `create_goal`, `declare_will`, `add_lesson`, `reflect`, `archive_entity`, `complete_goal`) fire `rememberMemory()` after the DB write — injecting the write event into the same episodic store that pre-injection reads from. Pre-injection can only surface what was written; the auto-remember calls close the write loop. |
| Active query complement | The `self_check` tool lets the agent query live DB state on-demand (7 domains: convictions, vault, calendar, goals, will, reflections, world model, + semantic fallback) without waiting for the next turn's pre-injection cycle. Useful when the agent needs to verify state mid-turn rather than at turn start. |

---

## Limitations

The reference implementation uses a simple dot-product cosine over a flat array of embeddings. The production system uses pgvector's `<=>` operator with an IVFFLAT index — results are approximate but sub-100 ms at tens of thousands of entries. This guide demonstrates the pre-injection *pattern*, not the embedding index.

---

## Files

- `artifacts/api-server/src/routes/agent.ts` — pre-injection at `_ragWithRecall` block (before `buildSystemPrompt` call)
- `artifacts/api-server/src/lib/agentMemoryV2.ts` — `searchMemory()` implementation
- `artifacts/api-server/src/lib/agent/prompt.ts` — `buildSystemPrompt()` — receives `_ragWithRecall` as 9th arg

---

## Deferred

- Personalised k per wallet (users with sparse memory get k=2; users with dense episodic store get k=8)
- Relevance threshold gate — skip injection if best cosine score < 0.72 (avoids noisy low-confidence recalls)
- Streaming pre-fetch — begin embedding before phase-2 batch completes by issuing the embed call earlier in the turn pipeline
