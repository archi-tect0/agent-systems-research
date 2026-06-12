# Resilient Multi-Provider LLM Routing

## Problem

A production conversational agent depends on a frontier LLM that it does not control. Hosted models go down, rate-limit, return HTTP 200 with an empty body, or briefly degrade. If the agent has exactly one upstream, every one of those events becomes a user-visible outage.

The naive fix — "try provider A, on error try provider B" — has two failure modes that only show up under real traffic:

1. **State leakage between providers.** If "is the upstream down?" is a single module-global boolean, the moment provider A latches it, *every* request starts going to the fallback, including requests that would route to a healthy provider B. One provider's outage takes down the whole fleet.

2. **Context-size mismatch on the fallback tier.** The last-resort fallback is usually a small local model with a short context window (~4K tokens). The request was built for a large cloud context: full system prompt, every tool schema, tens of thousands of characters of history — easily 100K+ tokens. Sent verbatim, the small model silently truncates to its last few thousand tokens, discarding the identity header and producing a generic base-model reply. The fallback "works" but the agent stops being itself.

This guide covers a router that addresses both: **per-instance health isolation** and **context re-encoding for the fallback tier**, wrapped in two routing strategies (named fast-fail and auto-waterfall).

## Design decisions

**Two strategies, one interface.**
Every provider and every router implements the same `LLMBackend.chat()` contract, so they nest. A `PrimaryWithFallback` can wrap a single provider, or a `WaterfallBackend` can be itself the fallback of a `PrimaryWithFallback`. The caller never knows or cares how deep the cascade goes.

- **Named mode (`PrimaryWithFallback`)** — you have explicitly chosen a provider (e.g. via a `LLM_BACKEND=groq` env var). Fast-fail: try the named primary, and on failure latch to one fallback. This is the predictable, low-variance path for a deployment that wants a specific model.
- **Auto mode (`WaterfallBackend`)** — an ordered chain (e.g. Relay → Gemini → Cerebras → Groq → OpenRouter → local). Each request walks the chain until something succeeds. This maximizes availability when you don't care which provider answers.

**Per-instance `HealthGuard`, never a module global.**
Each provider slot owns its own `HealthGuard`. A guard tracks one provider's latch state and runs one recovery probe. Because the state is per-instance, provider A latching has zero effect on provider B's routing decision. This is the single most important correctness property of the design.

**Soft vs. hard failures.**
A 429 / quota / "rate limit" error is *soft*: the provider is healthy, just throttled this instant. Latching on a 429 would needlessly park traffic on the fallback for minutes. So soft failures do **not** latch — the very next turn retries the primary. Only hard failures (connection refused, 5xx, auth error) latch.

**Bounded latch with a recovery probe.**
A latched guard runs a cheap 1-token probe every `PROBE_INTERVAL_MS` (5 min). On a successful probe it restores. A `HARD_LATCH_RESET_MS` (30 min) ceiling force-restores even if the probe never fires, so a stuck probe can never strand a provider forever.

**Re-encode, don't truncate, for the local tier.**
`trimForLocalFallback()` rebuilds the request specifically for the small model: keep the first system message capped to the identity header (~300 tokens), keep only the last few conversation messages each hard-truncated, and strip tool schemas (small models emit unreliable tool-call JSON). The result fits the small context window by construction instead of being truncated by the runtime.

**Empty-body is a failure.**
Some providers return HTTP 200 with a valid but empty stream (a soft rate-limit or model warm-up). The router treats "zero content produced" the same as an exception and cascades, so the user gets a real reply instead of silence.

## Algorithm

```
HealthGuard:
  latch(isRateLimit):
    if isRateLimit: return          // soft — stay on primary
    fallback = true; latchedAt = now

  probe loop (every PROBE_INTERVAL_MS):
    if not fallback: return
    if now - latchedAt > HARD_LATCH_RESET_MS: restore(); return
    try probeFn(); restore()
    catch: stay latched

PrimaryWithFallback.chat(input):
  if guard.fallback: return fallback.chat(input)
  try return primary.chat(input)
  catch err:
    guard.latch(isRateLimit(err))
    return fallback.chat(input)

WaterfallBackend.chat(input):
  for slot in chain:
    if not slot.configured or slot.guard.fallback: continue
    try:
      result = slot.adapter.chat(input)
      activeName = slot.name
      return result
    catch err:
      slot.guard.latch(isRateLimit(err))   // isolated to this slot only
  // every provider exhausted
  return local.chat(trimForLocalFallback(input))

trimForLocalFallback(input):
  sys  = first system message, sliced to LOCAL_SYS_CHARS
  conv = last LOCAL_KEEP_MSGS messages, each sliced to LOCAL_MSG_CHARS
  return { messages: [sys, ...conv], tools: [], tool_choice: "none" }
```

## Confidence routing and per-intent budgets (companion knobs)

Two adjacent mechanisms cut cost on top of failover:

**Per-intent token ceilings.** A weather reply needs ~120 output tokens; a code review needs ~1500. A static `intent → maxTokens` table caps generation per turn. This trims output cost on simple turns and reduces tail latency (the model stops sooner) without affecting hard turns, which keep the default ceiling.

**Confidence-gated local routing.** As a local model accumulates distilled examples of the agent's own decisions, easy turns can be served locally and only hard turns escalated. A confidence score combines tool-call entropy (fewer tools ⇒ simpler), intent familiarity (known simple intents score higher), and message length. A *pair-count gate* refuses any local routing until the local model has seen a minimum number of reference decisions, and an *always-escalate* set forces high-stakes intents (spend, code execution, security) to the strong model regardless of score.

```
score  = 0.5 baseline
       + (familiar intent ? +0.25 : 0)
       + tool-entropy term (0 tools +0.20 … >8 tools -0.20)
       + length term (short +0.10 … long -0.10)
route_local = score >= CONFIDENCE_THRESHOLD   // and pair_gate passed, not always-escalate
```

## Reference implementation

See [`resilient-router.ts`](./resilient-router.ts) in this directory.

## Usage

```typescript
import { PrimaryWithFallback, WaterfallBackend } from "./resilient-router.js";

// Auto mode: ordered cascade, small local model as last resort.
const router = new WaterfallBackend(
  [
    { adapter: geminiAdapter,    isConfigured: () => Gemini.isConfigured()    },
    { adapter: cerebrasAdapter,  isConfigured: () => Cerebras.isConfigured()  },
    { adapter: groqAdapter,      isConfigured: () => Groq.isConfigured()      },
    { adapter: openRouterAdapter },
  ],
  localSmallModelAdapter,
);

const out = await router.chat({ messages, tools });
console.log("served by:", router.currentName);

// Named mode: one explicit primary, cascade as its fallback.
const named = new PrimaryWithFallback(groqAdapter, router);
```

## Limitations and extensions

- **Probe cost.** Each latched provider runs a 1-token probe every 5 min. With many providers this is negligible, but on metered APIs the probe still bills a request — widen `PROBE_INTERVAL_MS` if that matters.
- **Mid-stream switching is not free.** For streaming responses you can only cleanly switch providers *before the first chunk*. Once a provider has emitted content, a failure mid-stream must propagate — you cannot silently restart on another provider without showing the user a restart.
- **The trim is lossy.** `trimForLocalFallback()` deliberately discards history and tool schemas. The local reply will be shorter and less tool-capable than a cloud reply. This is the correct trade — a coherent in-character short answer beats an incoherent truncated one — but it is a degradation, not a transparent failover.
- **No weighted/cost-aware ordering.** The chain is a fixed priority order. A production extension would reorder by live latency, price, or quota headroom rather than a static list.
- **Health is binary.** A provider is either healthy or latched. A richer model would track rolling error rate and partially shed load (e.g. send 20% of traffic to a degrading provider) instead of a hard on/off latch.
