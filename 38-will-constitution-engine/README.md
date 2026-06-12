# Will / Objective Topology + Constitutional Guardrail Layer

## Problem

A capable agent that only optimizes the *local* prompt drifts. Asked to "book the cheapest flight," it books a red-eye through three connections because that was literally cheapest — violating the user's standing preference never to fly overnight. Asked to "clean up old files," a prompt-injected document convinces it that deleting the backup vault counts as cleanup. The agent satisfied the immediate instruction and betrayed the user's enduring intent.

Two things are missing:

1. **A durable model of what the user actually wants over weeks and months** — life goals, obligations, boundaries, and the long-horizon objectives those goals decompose into. The agent needs this as a filter: *does this action advance the user's enduring will, or merely satisfy the local prompt?*
2. **An invariant set of rules the agent cannot be talked out of** — a small "constitution" of values, duties, principles, and hard limits, injected into every turn so prompt injection or conversational drift cannot override them.

This guide covers three cooperating layers that together form the agent's goal topology plus its guardrail:

- **Will engine** — the declared enduring will (goals, anti-goals, obligations, boundaries, principles, aspirations) plus a fast alignment check.
- **Objective manager** — long-horizon objectives decomposed into milestones, with progress tracking and stale-goal detection.
- **Constitution engine** — invariant convictions seeded on first boot and injected every turn.

## Design decisions

**Why separate "will" from "objectives"?**
They operate on different time horizons and serve different roles. The *will* is a small, slow-changing set of declarative statements ("I never fly overnight," "family time is non-negotiable on weekends") — it is a *filter*. *Objectives* are concrete, decomposable, and time-bounded ("ship v2 this quarter," with five milestones) — they are *work*. Conflating them produces either a goal list too abstract to act on or a will too volatile to trust.

**Why typed will entries?**
Each will entry has a `kind`: `life_goal`, `anti_goal`, `obligation`, `boundary`, `principle`, `aspiration`. The type drives behavior. The alignment check only scans `anti_goal` and `boundary` entries — those are the ones a proposed action can *violate*. Life goals and aspirations are aspirational context, not veto conditions, so they do not block actions; they inform planning. Boundaries are hard limits.

**Why a keyword-overlap heuristic for alignment rather than an LLM call?**
The alignment check runs *inline in the request path*, before significant actions, on every relevant turn. An LLM round-trip there would add latency and cost to the hot path and create a second model that could itself be manipulated. A cheap deterministic heuristic — tokenize the boundary/anti-goal statement, drop short stopwords (length ≤ 4), and measure what fraction of the remaining words appear in the proposed action description — catches the obvious, high-value conflicts (boundary violations, anti-goal collisions) for free. A score above ~0.15 flags a tension. This is intentionally a *recall-favoring* screen: it surfaces candidates for the agent to reason about, not a final verdict.

**Why seed a default constitution on first boot?**
A constitution that is empty until the user fills it in provides no protection during the very first conversations — exactly when the agent's behavior is least shaped. Seeding a default set of convictions (privacy is sacred, flag every irreversible action, never silently fail, never modify recovery/vault state without a fresh proof) means the guardrail is live from turn one. The user can add, confirm, or archive convictions over time; the defaults are marked with a `system_seed` source so they are distinguishable from user-declared ones.

**Why inject the constitution every turn instead of once?**
Injecting it once (at session start) leaves it vulnerable to context eviction and to prompt-injection payloads that arrive mid-session and try to redefine the agent's values. Re-injecting the compact constitution block at the top of *every* turn means the invariant rules are always the freshest, highest-priority context — they cannot be pushed out of the window or overridden by later instructions.

**Why ordered, compact context blocks?**
Both the will and the constitution render to terse, ordered text blocks (identity → values → duties → principles → anti-values → hard limits) capped to a few entries per category, so the guardrail costs a few hundred tokens, not thousands. Ordering matters: identity and values come first so they frame everything that follows; hard limits come last so they are the final word.

## Algorithm

```
checkWillAlignment(wallet, actionDescription):
  desc = lowercase(actionDescription)
  tensions = []; maxScore = 0
  for entry in activeWill(wallet):
    if entry.kind not in {anti_goal, boundary}: continue
    words   = tokenize(entry.statement) where len(word) > 4
    matches = words that appear in desc
    score   = len(matches) / max(len(words), 1)
    if score > 0.15:
      tensions.add(entry.statement); maxScore = max(maxScore, score)
  return { score: min(maxScore,1), tensionWith: tensions, advisory }

objective progress:
  progressPct = round(completedMilestones / totalMilestones * 100)
  status → "completed" when progressPct == 100

stale detection:
  active objectives where lastReviewedAt < now - staleDays   // default 7

constitution:
  on first use → seed DEFAULT_CONVICTIONS
  every turn   → inject ordered, compact block of all active convictions
```

## Reference implementation

See [`will-constitution.ts`](./will-constitution.ts). It holds will entries, objectives, and convictions in memory for runnability; production stores each in its own table. The alignment heuristic, the milestone/progress math, the stale-objective detector, the default-constitution seed, and the compact context renderers are all ported faithfully.

## Usage

```typescript
import { WillConstitutionEngine } from "./will-constitution.js";

const engine = new WillConstitutionEngine();

// 1. Declare enduring will
engine.declareWill({ wallet, kind: "boundary",  statement: "Never fly overnight red-eye flights." });
engine.declareWill({ wallet, kind: "life_goal", statement: "Run a sub-4-hour marathon this year." });

// 2. Track a long-horizon objective
engine.createObjective({
  wallet, title: "Ship v2", horizon: "quarter",
  milestones: [{ description: "Finalize API" }, { description: "Migrate data" }, { description: "Public beta" }],
});

// 3. Guardrail check before a significant action
const align = await engine.checkWillAlignment(wallet, "Book the cheapest overnight red-eye to Tokyo");
if (align.score > 0) console.warn(align.advisory);   // tension with the no-red-eye boundary

// 4. Inject guardrail + goal context into the system prompt
const guard = await engine.getConstitutionContext(wallet);
const goals = await engine.getObjectivesContext(wallet);
const willCtx = await engine.getWillContext(wallet);
```

## Limitations and extensions

- **The alignment heuristic has false positives and negatives.** Keyword overlap cannot understand negation or paraphrase ("the overnight option" vs "red-eye"). It is a cheap first screen; for high-stakes irreversible actions, escalate flagged candidates to a full LLM judgment or to the tool critic (guide 39), and gate execution through authority bands (guide 37).
- **Will and constitution are user-scoped trust roots.** Anyone who can write to these tables can change what the agent considers permissible. Writes should themselves be gated (e.g. behind a passkey for boundary/anti-value changes).
- **Objectives need a review loop to stay honest.** The stale detector surfaces neglected goals, but something has to act on it — a background scheduler (guide 08) that proactively raises stale objectives keeps the topology from rotting into a graveyard of abandoned intentions.
- **Confidence and provenance are tracked but not yet arbitrated.** Each will/conviction entry carries a confidence and a source; a richer system would weight low-confidence inferred entries differently from user-confirmed ones when resolving conflicts.
