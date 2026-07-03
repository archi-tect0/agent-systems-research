# Ambient World-Snapshot Prefetch Bus


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An assistant is constantly asked ambient questions — "what's the weather?",
"anything happening in the markets?", "any big news?" — whose answers change
slowly relative to how often they're asked. Answering each one with a live tool
call has two costs. First, latency: a synchronous fetch in the middle of a turn
adds hundreds of milliseconds to time-to-first-token, the most user-visible
metric there is. Second, redundancy: ten turns in an hour might fire ten weather
calls that all return essentially the same thing.

The naive fix — cache the last answer — is too crude. Real-world facts don't all
age at the same rate (a market quote goes stale in minutes; a weather forecast
lasts the hour), and a cached fact gives no signal about *how much to trust it*.
A 28-minute-old weather digest is probably fine; a 28-minute-old market quote is
nearly worthless. The model needs the fact *and* a freshness score so it can
decide whether to use it directly or hedge ("as of about half an hour ago…").

The goal is to decouple world-awareness from tool-calling: keep a small set of
compact, freshness-scored digests warm in context, refresh them on a schedule in
the background, and let most turns answer from the warm set with zero in-turn
tool calls.

## Design decisions

**Why a query planner instead of one broad fetch?**
"What's the weather" is a vague query that produces a vague answer. Decomposing a
category into 2–4 focused micro-queries — current conditions, severe alerts,
next-6-hours forecast — gives the synthesizer a concrete checklist. One synthesis
pass answers all of them and produces one dense digest. The planner is the cheap
part that makes a single expensive call worth more.

**Why a ≤150-token digest rather than raw data?**
The digest lives in the prompt on every turn it's relevant. It has to be small.
A synthesized paragraph that leads with the most time-sensitive fact costs a
fraction of the tokens of raw API JSON and is already in the form the model will
quote back.

**Why linear confidence decay over a per-kind TTL?**
A boolean "fresh/stale" flag throws away the most useful signal: digests don't
fail at a cliff, they fade. Linear decay from `baseConfidence` at fetch time to
0 at expiry gives a continuous trust score the renderer can surface (`[~54%]`).
Per-kind TTLs encode that different facts age at different rates — markets at 10
minutes, weather at 30, local at an hour. Linear is deliberately simple and
explainable; an exponential half-life is a drop-in alternative if some category
benefits from a long tail.

**Why a pluggable fetcher interface?**
The bus's job is planning, decay, storage, and rendering — not knowing how to
talk to a weather API or an LLM. Keeping the fetcher behind a one-function
interface lets production wire it to a cheap synthesis model while tests and this
demo use a deterministic stub with no network and no keys.

**Why evict on read?**
`getActive` drops any digest whose effective confidence has fallen below the
floor as it scans. The store stays small without a separate sweeper, and a stale
entry can never accidentally be rendered.

## Algorithm

```
buildMicroQueries(kind, city):
  weather -> [conditions, alerts, 6h forecast]
  news    -> [top headlines, breaking last hour, relevant tech/markets]
  markets -> [index direction, market-moving events]
  local   -> city ? [what's happening, local alerts] : []

refresh(kind, city):
  queries = buildMicroQueries(kind, city)
  res     = fetcher(kind, queries, city)        # one synthesis pass
  store[kind:city] = { digest: res.digest, fetchedAt: now,
                       ttlMs: TTL[kind], baseConfidence: clamp(res.confidence) }

effectiveConfidence(d, now):
  age = now - d.fetchedAt
  if age <= 0:        return d.baseConfidence
  if age >= d.ttlMs:  return 0
  return d.baseConfidence * (1 - age / d.ttlMs)   # linear decay

getActive(now):
  for each stored digest:
    conf = effectiveConfidence(d, now)
    if conf < floor: evict
    else: include with conf
  sort by conf desc

renderBlock(now):
  for each active digest:
    tag = conf >= 0.8 ? "" : " [~{conf%}]"
    line = "{KIND}{tag}: {digest}"
  return "[World State]\n" + lines
```

## Reference implementation

See [`ambient-snapshot-bus.ts`](./ambient-snapshot-bus.ts) in this directory.

Runs on Node.js built-ins only. The `SnapshotFetcher` is an injected interface;
production points it at a cheap LLM synthesis call, while the demo uses a
deterministic stub so the file runs with no network and no API keys.

## Usage

```typescript
import { SnapshotBus, type SnapshotFetcher } from "./ambient-snapshot-bus.js";

// Wire the fetcher to your synthesis backend (LLM, weather API, …).
const fetcher: SnapshotFetcher = async (kind, microQueries, city) => {
  const text = await synthesize(kind, microQueries, city);   // your call
  return { digest: text, confidence: 0.9 };
};

const bus = new SnapshotBus(fetcher);

// Background: refresh on a schedule.
await bus.refresh("weather", "Lisbon");
await bus.refresh("markets");

// Per turn: inject the warm block — zero in-turn tool calls.
const block = bus.renderBlock();         // "[World State]\nWEATHER: …"

// Scheduler tick: refetch whatever has decayed below the floor.
for (const { kind, city } of bus.getStale()) await bus.refresh(kind, city);
```

## Limitations and extensions

- **Decay is a heuristic, not ground truth.** Linear decay assumes facts age
  uniformly within their TTL. A market crash invalidates a digest instantly; the
  decay curve won't know. Pair with event-driven invalidation for volatile kinds.
- **Single digest per kind+location.** The bus keeps one digest per
  `kind:city`. Multi-region awareness means more keys, which costs context.
- **Synthesizer trust.** `baseConfidence` is whatever the fetcher reports. A
  hallucinated digest with high self-reported confidence will be rendered as
  trustworthy; validate or cite sources for high-stakes categories.
- **Extension — wall-clock grounding.** Pair the snapshot bus with a small
  temporal-context block injected each turn: current ISO time, timezone,
  part-of-day, and "time since last session". Snapshots tell the agent *what* the
  world looks like; the time block tells it *when* "now" is, so it can greet
  correctly, reason about staleness ("we last spoke 3 days ago"), and schedule
  with real-clock semantics. Both are cheap context-injection blocks built the
  same way.
- **Extension — exponential half-life.** Swap the linear term for
  `baseConfidence * 0.5 ** (age / halfLife)` per kind where a long fading tail is
  more realistic than a hard linear ramp to zero.
