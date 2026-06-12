# DB-Backed Autonomous Agent Scheduler

## Problem

An assistant that can only act while the user has a tab open is not autonomous.
For an agent to do useful background work — fire a reminder, alert on a price
cross, deliver a morning brief, run a nightly memory-consolidation pass, evaluate
a standing goal — it needs a clock that ticks independently of any client
session, survives process restarts, and never double-fires a job when more than
one server instance is running.

The naive approach (an in-memory `setTimeout` per task) fails on every count:
timers are lost on restart, don't coordinate across instances, and don't survive
a crash. The state of "what should fire and when" must live in the database, and
the scheduler must be a *poller* over that state, not an owner of in-memory
timers.

This guide describes a durable, DB-backed scheduler: a single loop that wakes on
a fixed tick, atomically claims due rows, executes kind-specific work, delivers
results through an outbound queue, and re-arms or retires each row — with
per-row failure isolation so one bad job never stalls the sweep.

## Design decisions

**Why poll a table instead of scheduling timers?**
The database is the single source of truth for due work. A 30-second poll trades
a small amount of timing latency for durability: the schedule survives restarts,
multiple instances can share the load, and there is no in-memory state to lose.
Sub-minute precision is not a requirement for "remind me at 8am" or "consolidate
memory nightly", so the 30s tick is more than fine.

**Why an atomic claim with `FOR UPDATE SKIP LOCKED`?**
The race that matters is two ticks (from the same process or two instances)
grabbing the same row and firing it twice. The claim is a single statement:

```sql
UPDATE schedules SET status = 'processing'
 WHERE id IN (SELECT id FROM schedules
               WHERE status = 'pending' AND fire_at <= now()
               ORDER BY fire_at ASC
               LIMIT :batch
               FOR UPDATE SKIP LOCKED)
 RETURNING *;
```

`FOR UPDATE SKIP LOCKED` means a second tick running concurrently simply skips
rows already locked by the first and claims different ones. The `RETURNING` set
is the canonical batch *this* tick owns. No row is ever claimed twice, and the
two ticks parallelize instead of colliding.

**Why `Promise.allSettled` for the batch?**
Each claimed row is fired inside its own try/catch and the whole batch is run
through `Promise.allSettled`. A job that throws — a flaky network call, a bad
payload — increments that row's `failure_count` and leaves every other row in the
batch untouched. One poisoned job can never block the sweep.

**Why a consecutive-failure breaker?**
After `MAX_CONSECUTIVE_FAILS` (5) consecutive failures, a row is moved to a
terminal `failed` state and stops being polled. This stops a permanently-broken
job (e.g. a price watch on a delisted symbol) from being retried forever and
burning resources. A successful fire resets the count to zero.

**Why distinguish `skip` from `fail`?**
A job returns one of three outcomes:
- `fired` — the work happened; re-arm (recurring) or retire (one-shot).
- `skip` — a *transient* non-failure: the condition isn't met yet (price hasn't
  crossed), or a network blip occurred. Don't count it as a failure; just try
  again, possibly with backoff.
- `fail` — a real error; increment the breaker.

This separation is what lets a price watch poll every tick for weeks without ever
tripping the failure breaker, while a genuinely broken job retires after five
strikes.

**Why backoff on `skip` for expensive jobs?**
A price watch that returns `skip` is cheap to retry every tick. But a job whose
`skip` came from a failed LLM call (e.g. a standing-goal evaluation) would burn
tokens if retried every 30 seconds. Those kinds get a backoff (`max(300s,
intervalSec)`) before the next attempt, while cheap watches get a small jitter
(60–90s) so a fleet of watches doesn't cluster on the same minute boundary and
hammer an upstream API in bursts.

**Why a timezone-aware daily anchor instead of `now + 24h`?**
A daily job re-armed as `now + 86400s` accumulates tick latency every day and
drifts off the user's chosen local time. Instead, the next fire instant is
*recomputed* from the original local `HH:MM` plus the user's timezone offset:
derive the target wall-clock time in the user's local zone, convert back to UTC,
and roll forward to tomorrow if today's slot has already passed. This keeps a
"7:00am every day" job pinned to 7:00am local indefinitely, with no drift, even
on a server running in UTC.

**Why deliver through an outbound queue?**
A fired job doesn't push to a websocket or call a client directly — it inserts a
row into an `outbound` table (a title, a body, and a small stack of display
cards). The client drains this queue whenever it connects. This decouples *doing
the work* from *the user being online to see it*: the morning brief is built and
queued at 7:00am whether or not the app is open, and shown the moment the user
returns.

## Algorithm

```
TICK_MS = 30s ; BATCH_SIZE = 25 ; MAX_CONSECUTIVE_FAILS = 5

tick():
  due = atomicClaim(BATCH_SIZE)          # UPDATE … FOR UPDATE SKIP LOCKED RETURNING *
  if due empty: return
  allSettled(due.map(row => process(row)))

process(row):
  try:
    outcome = fireOne(row)              # kind-specific work → "fired"|"skip"|"fail"
    if outcome == "fail":
      fails = row.failureCount + 1
      set status = fails >= MAX ? "failed" : "pending", failureCount = fails
    elif outcome == "skip":
      if kind == "watch":      reschedule(now + jitter(60..90s)), failureCount=0
      elif kind is expensive:  reschedule(now + max(300s, intervalSec))
      else:                    set status = "pending"
    else:  # fired
      if kind == "daily_anchor":
        set fire_at = computeNextDailyFireAt(hh, mm, tzOffset), status="pending"
      elif recurring and intervalSec > 0:
        set fire_at = now + intervalSec, status="pending", failureCount=0
      else:
        set status = "fired"           # one-shot terminal
  catch err:
    increment failureCount

computeNextDailyFireAt(hour, min, tzOffsetMin):
  nowLocal = now + tzOffsetMin          # read UTC fields as if local
  Y,M,D    = localYearMonthDay(nowLocal)
  fireAtMs = UTC(Y, M, D, hour, min) - tzOffsetMin
  if fireAtMs <= now + 30s: fireAtMs += 24h     # roll to tomorrow
  return fireAtMs
```

Recurring kinds (recurring / standing-goal / consolidation) re-arm by
`intervalSec`; one-shot kinds (reminder, single watch hit) flip to the terminal
`fired` state; the daily anchor recomputes its wall-clock slot.

## A note on the standing-goal kind

The most "autonomous" job kind is a standing goal: a recurring row whose work is
to ask a small LLM, given the goal plus the few most relevant memories, *"is there
something genuinely new/time-sensitive/actionable right now — act, or skip?"* The
prompt is biased hard toward SKIP (silence is the default). On `act` it queues an
outbound message; on `skip` or any error it silently re-arms. This lets the agent
proactively reach out *only* when warranted, without spamming, and survives a
flaky model turn by collapsing to SKIP.

## Reference implementation

See [`scheduler.ts`](./scheduler.ts). The DB is behind a `ScheduleStore`
interface; the atomic-claim semantics are documented and emulated in the
in-memory store used by the `--demo` block, which runs a few ticks over a
reminder, a price watch, and a daily anchor.

## Usage

```typescript
import { Scheduler } from "./scheduler.js";

const scheduler = new Scheduler(store, {
  fetchPrice,        // (symbol) => Promise<number | null>
  deliver,           // (outbound) => Promise<void>  — usually a DB insert
  evaluateGoal,      // (goal, ctx) => Promise<{ act: boolean; message?: string }>
});

scheduler.start();     // begins the 30s tick loop
// …
scheduler.stop();
```

## Limitations and extensions

- **30s granularity.** Fine for human-scale schedules; not suitable for
  sub-second jobs. For finer timing, lower the tick (at the cost of more polls)
  or layer an in-memory timer on top of the durable store for imminent rows.
- **Single-table contention.** The atomic claim serializes on one table. At very
  high job volume, partition the table by tenant or shard the claim by a hash
  range so instances claim disjoint partitions.
- **Backoff is per-kind, not adaptive.** A persistently flaky upstream gets the
  same fixed backoff regardless of recent error rate. An exponential backoff
  keyed on consecutive `skip`s would be gentler on a struggling dependency.
- **No distributed leader.** Any number of instances can run the loop safely
  (the claim is the coordination point), but there is no notion of a primary.
  That is intentional — it removes a failure mode — but means there is no single
  place to observe "the scheduler" as a whole.
