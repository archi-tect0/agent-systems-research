# Reflective Memory with Use-Reinforced Sorting


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

The salience-scored memory layer (guide 06) is good at *recall* — surfacing
relevant facts for the current turn. But it doesn't capture a different kind of
knowledge: the **lessons an agent learns about how to behave**. These are
structured, categorized observations — *"the user prefers terse answers"*,
*"I tend to over-explain when the question is simple"*, *"when the user says
'stop' it means no more tool calls"* — that should be injected into *every* turn,
not retrieved on demand by topical similarity.

Treating these as ordinary memories has two problems:

1. **They are categorically different.** A lesson, an insight, a self-audit
   result, and a behavioral correction are distinct kinds of reflective
   knowledge that deserve their own retrieval ordering, not a single
   undifferentiated pool.
2. **They go stale.** An agent that writes a reflection every time it consolidates
   memory will, over months, accumulate hundreds of unconfirmed guesses about the
   user. Most are noise. The system needs a way to let *useful* reflections stay
   warm and let *unused* ones quietly fall away — without a human curating the
   list.

This guide describes a reflective memory store with categorized entries and a
**use-reinforced sorting** mechanism: every time a reflection is injected into
context, its timestamp is bumped, so frequently-used reflections float to the
top and unused ones sink and are eventually pruned.

## Design decisions

**Why explicit categories?**
Reflections are typed into a small fixed taxonomy:

```
correction   — a behavioral rule learned from being corrected
lesson        — a durable thing to remember (recorded by user or agent)
insight       — a self-observation produced by a reflection cycle
model_update  — an update to the agent's model of the user
self_audit    — output of a periodic self-evaluation pass
pattern       — a recurring behavior the agent noticed
milestone     — a notable event worth keeping
```

When building the context block, categories are sorted by a fixed priority order
(corrections first, self-audits last) so the most behavior-shaping reflections
always lead. Categories make the injected block scannable by the model and let
retrieval prioritize by *kind* before recency.

**Why "use-reinforced" sorting instead of a recall counter?**
The store sorts by `updatedAt DESC`. The key move is that **injecting a
reflection into context counts as using it** — when reflections are pulled for a
turn, their `updatedAt` is bumped. A reflection that keeps being relevant keeps
getting injected, keeps getting its timestamp refreshed, and keeps floating to
the top. A reflection that stops being useful stops being injected (because it
falls below the per-turn cutoff once warmer entries push it down), stops getting
refreshed, and cools off. This is a self-reinforcing pathway: warm stays warm,
cold goes cold, with no separate counter to maintain.

**Why prune only unconfirmed reflections?**
The decay pass archives entries that are `confirmed = false` *and* haven't been
touched in `thresholdDays` (default 45). Confirmed reflections — ones the user
explicitly endorsed, or that were promoted to durable policy — are never decayed.
This means the agent's *guesses* expire if they prove useless, but anything the
user signed off on is permanent.

**Why bump on inject as fire-and-forget?**
The timestamp bump happens during context assembly, which is on the latency-
critical path of an LLM turn. The update is dispatched without `await` so it
never adds round-trip latency to the response. A lost bump (process dies mid-turn)
is harmless — the reflection simply doesn't get credit for that one use.

**Why cap the injected block?**
The context block is capped (top ~8 entries, each truncated to ~120 chars) to
keep the always-on injection cost around 200 tokens. Reflective memory is meant
to be a constant low-cost background signal, not a context-window hog.

## Algorithm

```
addReflection(wallet, category, content, confidence?, confirmed?):
  insert row { id, wallet, category, content,
               confidence ?? 0.9, confirmed ?? false,
               updatedAt = now, archivedAt = null }

listReflections(wallet, category?, limit):
  return rows WHERE wallet = ? AND archivedAt IS NULL [AND category = ?]
         ORDER BY updatedAt DESC          # ← use-reinforced sort
         LIMIT limit

getReflectiveContext(wallet):                # called every turn
  entries = listReflections(wallet, all, 12)
  sorted  = entries sorted by CATEGORY_PRIORITY index
  top     = sorted.slice(0, 8)

  # Use-reinforcement: bump updatedAt on the entries we are injecting,
  # fire-and-forget so it adds zero latency to the turn.
  bumpUpdatedAt(top.ids)            # not awaited

  return render(top)               # "REFLECTIVE:\n[CATEGORY] content…"

decayStaleReflections(wallet, thresholdDays = 45):   # nightly
  archive rows WHERE wallet = ?
                 AND confirmed = false
                 AND archivedAt IS NULL
                 AND updatedAt < now - thresholdDays
```

`CATEGORY_PRIORITY` ordering for the context block:

```
correction > lesson > pattern > model_update > milestone > insight > self_audit
```

The two-layer ordering matters: `listReflections` pulls the **12 most recently
used** entries (recency via `updatedAt`), then `getReflectiveContext` re-sorts
*those* by category priority and takes the top 8. So the candidate set is chosen
by warmth, but the display order within the block is chosen by behavioral
importance.

## How reflections get written

In a complete agent these entries come from three sources:

- A user- or agent-invoked `add_lesson`-style tool that records a durable lesson.
- A `reflect` tool the agent calls to write a structured insight about itself.
- A scheduled background reflection cycle (see guide 08) that, after
  consolidating recent memories, runs one short LLM pass to surface a single
  actionable insight about how to better serve the user and stores it with
  `category = "insight"`.

The decay pass runs as part of the same nightly cycle, so writing and pruning are
balanced over time.

## Reference implementation

See [`reflective-memory.ts`](./reflective-memory.ts). Persistence is behind a
`ReflectionStore` interface; the `--demo` block uses an in-memory store to show
the use-reinforced float-up and the decay pass.

## Usage

```typescript
import {
  addReflection,
  getReflectiveContext,
  decayStaleReflections,
} from "./reflective-memory.js";

// Agent learns something
await addReflection(store, {
  wallet, category: "lesson",
  content: "the user prefers code examples over prose explanations",
});

// Every turn: inject the warm reflections (this also reinforces them)
const block = await getReflectiveContext(store, wallet);
systemPrompt += block;

// Nightly: prune cold, unconfirmed guesses
const archived = await decayStaleReflections(store, wallet, 45);
```

## Limitations and extensions

- **Per-id bump vs. bulk bump.** The simplest implementation bumps every
  non-archived row's timestamp on inject, which loses fine-grained pathway
  information. A precise implementation bumps *only the injected ids* — the
  reference code does this; production code that batches for performance may
  approximate.
- **Decay threshold is global.** 45 days suits a daily-use assistant; a
  rarely-used agent would prune reflections it never had a chance to reinforce.
  The threshold could scale with the user's interaction cadence.
- **No contradiction handling.** Two reflections can disagree
  (*"prefers terse"* vs. *"prefers detail"*). This store keeps both and lets the
  model reconcile them. A reconciliation pass (like the fact reconciliation in
  guide 06's sibling) could supersede the older one.
- **Confidence is written but not used in ordering.** Sorting is purely by
  category priority and warmth. Confidence could weight the per-turn cutoff so
  low-confidence guesses need more reinforcement to stay visible.
