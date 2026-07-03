# Guide 84 — Self-Audit Dissent Loop


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A closed feedback cycle that turns PolicyEngine warn verdicts into durable self-audit lessons stored in the agent's reflective memory.*

---

## Problem

Guide 81 built a `PolicyEngine` that emits `warn` verdicts when a tool call brushes against a constitutional boundary. Those verdicts appear in the conversation as `⚠️ Policy note: …` messages and are written to `agent_outbound`. But they stop there — the agent has no mechanism to learn from them across turns. Each turn starts with the same constitution and the same risk of repeating the same policy violation.

What's missing is a feedback loop:

```
policy warn → user sees ⚠️ message → … nothing else changes
```

The pattern we need:

```
policy warn → lesson recorded in reflective memory → self-audit influences future posture
```

---

## Architecture

Three components, one loop:

```
PolicyEngine                  agent_outbound              dissentReviewer
─────────────────────────     ──────────────────────      ───────────────────────────────
checkPolicy(tool, args)  →    body: "⚠️ Policy note: …"  tickDissentReview()
  verdict = "warn"       →    (unreviewed row)            scans agent_outbound
  prepend ⚠️ to response                                  detects warn rows
                                                          ↓
                                                    kai_reflective_memory
                                                    category: "self_audit"
                                                    source: "dissent_reviewer"
                                                    content: "[dissentReview:<id>] …"
```

The reviewer runs on the **scheduler tick** — the same 30-second cadence as `tickTvAutotune` and `runObjectivePlanningSweep`. No separate process, no extra timer.

---

## The three parts

### 1. PolicyEngine warn verdict (Guide 81 recap)

When `checkPolicy()` returns `{ verdict: "warn", reason }`, the agent prepends:

```
⚠️ Policy note: <reason>
```

to the response body and writes an `agent_outbound` row with that same `body`. The outbound row stays `read = false` (user inbox) — the dissent reviewer does **not** mutate it.

### 2. `dissentReviewer.ts` — the async learner

```ts
export async function tickDissentReview(): Promise<void> {
  // 1. Find warn-verdict outbound entries (any unreviewed)
  const rows = await db.execute(sql`
    SELECT id, wallet, body, created_at FROM agent_outbound
    WHERE body ILIKE '⚠️ Policy note:%'
    LIMIT 10
  `);

  for (const row of rows) {
    // 2. Idempotency: skip if already has a reflective entry for this ID
    const existing = await db.execute(sql`
      SELECT id FROM kai_reflective_memory
      WHERE wallet = ${row.wallet}
        AND content ILIKE ${'%' + row.id + '%'}
      LIMIT 1
    `);
    if (existing.rows.length > 0) continue;

    // 3. Extract the reason and write a self-audit lesson
    const reason = row.body.replace(/^⚠️ Policy note:\s*/i, '').slice(0, 300);
    await db.execute(sql`
      INSERT INTO kai_reflective_memory (wallet, category, content, confidence, source)
      VALUES (
        ${row.wallet}, 'self_audit',
        ${'[dissentReview:' + row.id + '] PolicyEngine warn: ' + reason +
          ' — consider whether this tool choice aligned with declared boundaries.'},
        0.85, 'dissent_reviewer'
      )
    `);
  }
}
```

**Key design choice — no mutation of `agent_outbound`:** The outbound row stays untouched so the user's inbox still shows the warning. Idempotency is tracked by embedding the outbound ID in the lesson content, checked with `ILIKE '%<id>%'` before inserting.

### 3. Scheduler hook

```ts
// agentScheduler.ts — tick() end, after job sweep
await tickTvAutotune();
await tickDissentReview().catch(err => logger.warn({ err }, "dissent review failed"));
await runObjectivePlanningSweep().catch(/* ... */);
```

All three run at the same cadence. `tickDissentReview` is non-fatal — a DB failure on one tick doesn't break the scheduler.

---

## What the agent gets

After a warn verdict, within ~30 seconds the agent has a `self_audit` entry in `kai_reflective_memory`. On subsequent turns that entry can surface via:

1. **Proactive recall** (Guide 82) — if the next message is semantically similar to the lesson, it's pre-injected before the turn.
2. **`recall_memory` tool call** — the agent can explicitly search reflective memory.
3. **`getReflectiveContext(wallet)`** — surfaces top reflective entries in the dynamic system message.

The net effect: a pattern of repeated warn verdicts on the same tool generates a cluster of self-audit lessons, which the agent can observe as a signal that its default posture on that tool class needs adjustment.

---

## Idempotency guarantee

| Scenario | Behaviour |
|---|---|
| Scheduler restarts | Existing lessons found via ILIKE check; no duplicate inserted |
| Same outbound row spans two ticks | Second tick detects existing lesson and skips |
| Two wallets with same outbound ID prefix | ILIKE check is wallet-scoped (WHERE wallet = …) |
| Outbound row deleted before tick fires | Query returns empty; no lesson needed |

---

## Separation of stores

| Store | Purpose | Who writes |
|---|---|---|
| `agent_outbound` | User-visible inbox cards (warnings, nudges, summaries) | PolicyEngine, scheduler, tools |
| `kai_reflective_memory` | Agent's own self-audit notes | `dissentReviewer` (category: `self_audit`) |
| `agent_memories` | Episodic user-facing memories | Tools, `rememberMemory()` |
| `kai_constitution` | Deterministic per-turn conviction injection | User via Extensions page, seed script |

Keeping self-audit in `kai_reflective_memory` (not `agent_memories`) prevents dissent noise from polluting the user-relevant recall pool.

---

## Operational invariant: read-path category must match

Every writer in this loop uses the literal category string `self_audit` — `dissentReviewer.ts`, and the equivalent inline writes in `agent.ts`, `agentScheduler.ts`, and `postTurnReflection.ts`. Any admin or diagnostic surface that reads `kai_reflective_memory` to show these lessons (e.g. an operator-facing "dissent" or "self-audit" panel) **must filter on `category = 'self_audit'`**, not on a different label like `'dissent'`. A read-path filter mismatch here is invisible to typecheck — it just means the panel silently renders its empty state forever, even with a healthy write side. If you add a new consumer of this table, grep the writers first rather than guessing the category value.

---

## Closing the loop further

This guide implements the write side. The read side (surfacing lessons into future turns) is handled by:

- `getReflectiveContext(wallet)` — included in the cloud dynamic system message
- Proactive recall (Guide 82) — semantic embedding match pre-injects the most relevant lessons

For an agent that acts on the lessons (e.g. automatically adjusting risk thresholds based on accumulated dissent density), the next step is a `selfTuningLoop` that reads `kai_reflective_memory` and proposes constitution updates — which the user must confirm before they take effect (commitSelfMod gate, see Guide 77).

---

## Running the reference

```
node index.ts
```

Demonstrates: warn verdict → outbound entry → lesson write → idempotency on second tick.
