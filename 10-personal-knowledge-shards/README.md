# Intent-Gated Personal Knowledge Shards


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

The memory systems in guides 06–07 are general-purpose: a salience-ranked pool of
recalled facts and a set of behavioral reflections. But an agent that serves *one
specific person* over a long time accumulates a different kind of knowledge —
**structured, labeled facts about who they are**: their preferences, daily
routines, the people in their life, their open projects, the things they
explicitly *don't* want. This is the agent's model of the user.

Stuffing all of that into every prompt has two failure modes:

1. **It's too much.** A long-term user might have a hundred such facts. Injecting
   all of them every turn is expensive and dilutes the signal — a coding question
   doesn't need to know the user's coffee order.
2. **It's a security hazard.** Some of these facts are *inferred* or
   *synthesized* by the agent, not stated by the user. A guessed fact is fine for
   personalizing chit-chat but must never be allowed to influence an
   authentication, wallet, or threat-response decision. "I think you usually
   approve transfers around this size" is exactly the kind of inference an
   attacker would love the agent to act on.

This guide describes **knowledge shards**: dedicated, labeled circuits of
per-user knowledge, retrieved per-turn by *intent* (so only relevant shards load)
and gated by *provenance* (so only directly-observed facts can touch
security-sensitive paths).

## Design decisions

**Why structured shards instead of free-text memories?**
A shard has a `shardKind` (preference / routine / relationship / open_loop /
anti_goal …), a short `label` (the upsert key), and `content`. The structure buys
two things: the upsert key lets a fact be *updated in place* rather than
duplicated ("favorite editor" overwrites the old value instead of adding a second
opinion), and the kind lets the rendered block be grouped and scannable for the
model.

**Why intent-gate retrieval?**
Each shard carries an `intentMask` — a comma-separated list of intent kinds it's
relevant to, or `"*"` for always-relevant. At turn start, only shards whose mask
matches the current turn's intent (or is `"*"`) are pulled. A `wallet` turn loads
the user's risk preferences and known addresses; a `creative` turn loads their
aesthetic preferences; neither pays for the other's shards. This keeps the
injected block small and on-topic.

**Why provenance, and why does it gate security paths?**
Every shard records how it was learned:

```
explicit  — the user stated it outright
confirmed — the agent proposed it and the user confirmed
observed  — directly observed from the user's actions/statements
inferred  — the agent deduced it (a guess)
system    — derived by a background process
synthetic — generated/extrapolated by the agent
```

The hard rule: **when retrieval runs on a security-sensitive path
(`securityPath = true`), only `observed` provenance shards are returned.**
Inferred, synthetic, and system-derived knowledge is stripped before it can reach
any auth/wallet/threat decision. Personalization can run on guesses; security
cannot. This is enforced at the single retrieval choke point so no caller can
forget it.

**Why over-fetch then filter in application code?**
Intent-mask matching (`mask = "*"` OR `intentKind ∈ split(mask)`) and the
provenance gate are awkward to express precisely in a single index-friendly SQL
predicate. The query instead orders by `(emotionalWeight DESC, confidence DESC)`,
over-fetches `limit * 3` candidates, and applies the mask + provenance filters in
code, then slices to `limit`. The 3× over-fetch makes it very likely the top
`limit` survivors are still the most salient matches, while keeping the SQL simple
and the ordering pushed down to the database.

**Why order by emotional weight before confidence?**
For a personal model, *what matters to the user* (emotional weight) is a stronger
relevance signal than *how sure we are* (confidence). A high-emotional-weight fact
the agent is only moderately sure of is usually more worth surfacing than a
trivial fact it's certain about.

**Why touch `useCount` / `lastUsedAt` fire-and-forget?**
Retrieval is on the turn's latency path, so the usage bump (which feeds future
consolidation/pruning decisions) is dispatched without `await`. As in guide 07,
a lost bump is harmless.

**Why upsert-by-label?**
Writes (`upsertShard`) look up an existing shard by `(wallet, label)` and update
it if found, insert otherwise. The label is the stable identity of a fact, so the
agent's model of the user stays a set of *current* beliefs rather than an
ever-growing log of every time it noticed the same thing.

**Where shards come from.**
Three sources: explicit agent tools (`add_lesson`, `writeFact`) that record a
fact with `provenance = explicit`; a background absorber that observes
conversation and writes `observed` shards; and a promotion path where a
high-recall general memory (guide 06's consolidation pass) graduates into a
durable shard once it has been recalled enough times.

## Algorithm

```
getShards(wallet, intentKind, securityPath = false, limit = 12):
  rows = SELECT … FROM shards
          WHERE wallet = ? AND active = true
          ORDER BY emotionalWeight DESC, confidence DESC
          LIMIT limit * 3                 # over-fetch

  matched = rows where intentMask == "*"
              OR intentKind ∈ split(intentMask)
              OR "*" ∈ split(intentMask)

  filtered = securityPath
               ? matched where provenance == "observed"   # security gate
               : matched

  top = filtered[:limit]
  for r in top: bumpUsage(r.id)           # fire-and-forget
  return top

renderShardsBlock(shards):                # → compact "[Personal Twin]" block
  group by shardKind
  for each kind: "<kind>: <content>; <content>; …"

upsertShard(wallet, kind, label, content, intentMask="*", provenance="observed", …):
  if exists(wallet, label): update content/confidence/emotionalWeight
  else: insert new shard
```

## Reference implementation

See [`knowledge-shards.ts`](./knowledge-shards.ts). Persistence sits behind a
`ShardStore` interface; the `--demo` block uses an in-memory store to show
intent-gated retrieval, the security-path provenance gate, upsert-by-label, and
the rendered block.

## Usage

```typescript
import { getShards, renderShardsBlock, upsertShard } from "./knowledge-shards.js";

// Write a fact (e.g. from an agent tool)
await upsertShard(store, {
  wallet, shardKind: "preference", label: "code_style",
  content: "prefers functional style, no classes",
  intentMask: "code,repo_diagnostic", provenance: "explicit",
});

// Every turn: pull intent-relevant shards and inject them
const shards = await getShards(store, { wallet, intentKind });
systemPrompt += "\n" + renderShardsBlock(shards);

// On a security-sensitive turn: only observed facts survive
const safe = await getShards(store, { wallet, intentKind: "wallet", securityPath: true });
```

## Limitations and extensions

- **Mask matching is post-fetch.** The 3× over-fetch is a heuristic; a user with
  many always-`*` shards could crowd out a rare intent-specific one beyond the
  over-fetch window. A production system can push a mask `LIKE` predicate into SQL
  for the common cases and keep the code filter as a backstop.
- **Provenance gate is binary.** Only `observed` passes the security path. A
  finer policy might allow `explicit` and `confirmed` (both user-originated) while
  still excluding `inferred`/`synthetic`. The choke point makes that a one-line
  change.
- **No contradiction reconciliation.** Upsert-by-label avoids duplicates for the
  *same* label, but two differently-labeled shards can still disagree. A
  reconciliation pass could merge or supersede conflicting facts.
- **Promotion is a stub here.** The graduation of high-recall memories into shards
  is described but driven by the consolidation pass (guide 06) and the scheduler
  (guide 08); wiring it end-to-end is left as an extension.
