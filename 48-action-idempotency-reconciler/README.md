# Agent Action Idempotency Reconciler

## Problem

An autonomous agent that proposes write actions — send funds, post a message, schedule a job — does not behave like a deterministic function. It re-plans. A language model that just produced a "send 5 USDC to 0xdead" proposal may, two reasoning steps later, conclude it should send 5 USDC to 0xdead and emit the proposal *again*. Without a guard, each proposal mints a fresh confirmation card, and the user is staring at three identical "approve this transfer?" prompts. Worse, if they tap two of them, the action executes twice.

There is a second, sharper failure. Once an action is approved and the agent fires it, the agent is waiting for a callback that says "it succeeded" or "it failed." Sometimes that callback never arrives — the worker crashed, the network dropped, the downstream API timed out. The action is now in an `executing` state with an unknown outcome. The dangerous instinct is to treat a stalled `executing` row as "probably didn't happen, let me retry." For a money-moving action that is exactly wrong: the first attempt may well have committed, and the retry double-spends.

This module enforces two mechanical guarantees that sit upstream of policy and execution. First: never mint a second confirm card for the same logical action while one is unresolved — identical re-proposals collapse onto the existing pending row. Second: never silently retry an action whose outcome is unknown — a stalled `executing` row escalates to `unknown` (a state that demands manual inspection) rather than reverting to `pending` for a blind re-run.

The deduplication hinges on recognizing that two proposals are "the same." `{to:"0xdead", amount:5}` and `{amount:5, to:"0xdead"}` are logically identical but serialize differently under naive `JSON.stringify`. The fingerprint must be canonical — keys sorted recursively — so logically-equal arguments always collide.

## Design decisions

**Why a canonical (recursive key-sorted) fingerprint?**
The idempotency key is `sha256(wallet | toolName | canonicalJSON(args))`. If the JSON serialization depended on key insertion order, a re-plan that built the args object in a different order would produce a different key and slip past the dedup. Sorting keys recursively — descending into nested objects and arrays — guarantees that any two argument structures with the same logical content hash identically.

**Why scope the key by wallet?**
The same `(tool, args)` for two different users is two different actions. Lower-casing and prefixing the wallet into the canonical string keeps each principal's pending actions isolated and prevents one user's proposal from deduplicating against another's.

**Why does dedup only apply to "live" rows?**
A row is live while it is `pending`, `approved`, `executing`, or `unknown`. Once it reaches a terminal state — `succeeded`, `failed`, `rejected`, `expired` — its idempotency key is free again. This is deliberate: after a transfer fails, the user legitimately wants to be able to retry it, so a fresh proposal with the same key must produce a *new* card, not silently reuse the dead one.

**Why escalate stalled `executing` rows to `unknown` instead of `pending`?**
`pending` means "safe to act on." `unknown` means "we genuinely do not know if this committed — a human must look." Moving a stalled row to `pending` would invite an automatic retry of an action that may have already happened. The grace window (90 s) gives a slow-but-honest callback time to land before the row is flagged; only after that does it become `unknown`.

**Why key the grace window off `executingAt`, not `createdAt`?**
A proposal can sit in `pending` for a long time waiting for the user to approve it. If the stall timer measured from `createdAt`, a row approved long after creation would be flagged `unknown` the instant it started executing. Measuring from the moment it entered `executing` times the *actual* execution attempt. Rows missing `executingAt` (legacy) fall back to `createdAt`.

**Why an in-memory Map here, and a DB partial unique index in production?**
The reference implementation uses a `Map` so the mechanism is legible and runnable offline. But a single-process map cannot make guarantee #1 race-safe when two concurrent requests propose the same action simultaneously — both could find no live row and both insert. The production store backs the same logic with a **partial unique index** on `agent_pending_actions` (unique on `(wallet, idempotencyKey)` *where status is live*). The database rejects the second concurrent insert with a unique-violation, and the loser re-selects and returns the winner's row. The Map demonstrates the contract; the index enforces it across processes.

## Algorithm

```
canonicalJSON(value):
  if value is null or not an object -> JSON.stringify(value)
  if value is array -> "[" + map(canonicalJSON).join(",") + "]"
  keys = sort(Object.keys(value))            // recursive sort
  return "{" + keys.map(k => quote(k)+":"+canonicalJSON(value[k])).join(",") + "}"

computeIdempotencyKey(wallet, toolName, args):
  return sha256( lower(wallet) + "|" + toolName + "|" + canonicalJSON(args) )

findOrCreatePending(input):
  key = computeIdempotencyKey(input.wallet, input.toolName, input.toolArgs)
  existing = first live row where (wallet, idempotencyKey) == (input.wallet, key)
  if existing:
    return { row: existing, reused: true }      // collapse onto existing card
  row = new row {
    status: "pending", idempotencyKey: key,
    createdAt: now, expiresAt: now + ttlMs,
    executingAt: null, resolvedAt: null,
  }
  return { row, reused: false }                  // mint a NEW card

markExecuting(id):  row.status="executing"; row.executingAt=now
resolve(id, term):  row.status=term;        row.resolvedAt=now   // frees the key

sweep(now):
  graceCutoff = now - graceMs                     // default 90_000
  for each row:
    if row.status in {pending, approved} and row.expiresAt < now:
        row.status = "expired"; expired++
    else if row.status == "executing":
        ref = row.executingAt ?? row.createdAt
        if ref < graceCutoff:
            row.status = "unknown"; unknown++      // NOT retried — inspect
  return { expired, unknown }
```

Live statuses are `pending`, `approved`, `executing`, `unknown`. Terminal statuses are `succeeded`, `failed`, `rejected`, `expired`.

## Reference implementation

See [`action-reconciler.ts`](./action-reconciler.ts) in this directory.

It runs on Node.js built-ins only (`crypto` for the SHA-256 fingerprint). The pending-action store is an in-memory `Map`; in production the same `findOrCreatePending` / `sweep` contract is backed by a SQL table with a partial unique index, which makes guarantee #1 race-safe across processes (the DB rejects the second concurrent insert).

## Usage

```typescript
import {
  ActionReconciler,
  computeIdempotencyKey,
  canonicalJSON,
  type PendingAction,
} from "./action-reconciler.js";

const reconciler = new ActionReconciler({ graceMs: 90_000 });

// First proposal → a brand-new confirm card.
const first = reconciler.findOrCreatePending({
  wallet:    "0xAbC123",
  toolName:  "send_funds",
  toolArgs:  { to: "0xdead", amount: 5, token: "USDC" },
  summary:   "Send 5 USDC to 0xdead",
  riskLevel: "high_write",
  ttlMs:     60_000,
});
// first.reused === false

// A re-plan re-proposes the SAME action with reordered keys → deduped.
const again = reconciler.findOrCreatePending({
  wallet:    "0xAbC123",
  toolName:  "send_funds",
  toolArgs:  { token: "USDC", amount: 5, to: "0xdead" }, // different order
  summary:   "Send 5 USDC to 0xdead",
  riskLevel: "high_write",
  ttlMs:     60_000,
});
// again.reused === true, again.row.id === first.row.id

// Drive the lifecycle.
reconciler.markExecuting(first.row.id);  // records executingAt
// ...if the callback never lands, the periodic sweep escalates it:
const { expired, unknown } = reconciler.sweep(); // run ~every 60s
// stalled row is now status "unknown" — surfaced for manual inspection

// On a real outcome, resolve to a terminal state (frees the idempotency key):
reconciler.resolve(first.row.id, "failed");

reconciler.get(first.row.id);   // PendingAction | null
reconciler.liveCount();         // number of live rows

// Fingerprint helpers are exported directly:
computeIdempotencyKey("0xAbC123", "send_funds", { to: "0xdead", amount: 5 });
canonicalJSON({ b: 2, a: 1 }); // '{"a":1,"b":2}'
```

## Limitations and extensions

- **In-memory store is single-process.** The reference `Map` cannot make guarantee #1 race-safe under concurrency. For real deployments, back `findOrCreatePending` with a partial unique index so simultaneous inserts collide at the database layer.
- **`sweep` is poll-based.** Escalation to `unknown` happens on the next sweep tick (intended ~every 60 s), not the instant the grace window elapses. Tighten the tick interval if faster detection is required.
- **`unknown` is a dead end by design.** The reconciler deliberately does not auto-resolve `unknown` rows. Reconciling them requires an out-of-band check against the downstream system (e.g. querying the chain for the transaction) followed by an explicit `resolve(...)`.
- **Fingerprint covers args, not intent.** Two genuinely different requests that happen to share `(wallet, tool, args)` collapse together. If callers need to distinguish them, that distinguishing data must be inside `toolArgs` so it changes the canonical key.
- **No persistence across restarts.** The Map is volatile; a process restart loses live rows. The DB-backed variant survives restarts and is the source of truth.
```
