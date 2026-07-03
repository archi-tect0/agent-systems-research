# Guide 81 — Conviction → Policy Engine Enforcement Loop


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Unification of guides 38 (constitutional AI alignment), 39 (authority bands), and 77 (polyphonic cognition dissent).*

## Problem

Guides 38, 39, and 77 each address a fragment of the same core challenge:

- **Guide 38** (constitutional AI alignment): How does the agent's personality and behaviour remain aligned with the user's declared values over time?
- **Guide 39** (authority bands): How does the system gate tool calls by risk tier, preventing high-impact actions from firing without appropriate authorisation?
- **Guide 77** (polyphonic cognition): How does the system surface and preserve internal disagreement between faculties rather than silently overriding dissent?

In isolation, each guide provides a useful primitive. But without a **unified enforcement loop**, the three systems can contradict each other:

- A conviction ("never disclose my wallet balance to third-party apps") might not be enforced by the authority band check (which operates on tool names, not semantic intent).
- A dissent recorded by guide 77's reviewer might never reach the conviction store, leaving the pattern invisible to future turns.
- The authority band might allow a tool call that a conviction explicitly prohibits — because bands are indexed by tool name, not by argument content.

---

## The loop

```
┌─────────────────────────────────────────────────────────────┐
│  Turn input (user message + tool args)                       │
│                          │                                   │
│         ┌────────────────▼──────────────────┐               │
│         │  1. Conviction Store (guide 38)    │               │
│         │  kaiConstitutionTable              │               │
│         │  getConstitutionContext()           │               │
│         └────────────────┬──────────────────┘               │
│                          │ conviction snapshot               │
│         ┌────────────────▼──────────────────┐               │
│         │  2. PolicyEngine (guide 81 new)    │               │
│         │  checkPolicy({                     │               │
│         │    toolName, toolArgs,             │               │
│         │    riskClass, passKeyFloor,        │               │
│         │    convictions ← snapshot          │               │
│         │  })                                │               │
│         │  → verdict: allow | warn | block   │               │
│         └─────┬──────────────────────────────┘               │
│               │                                              │
│    ┌──────────▼─────────────┐ warn/block                    │
│    │  3. Authority Band     │ ──────────→ Approval gate      │
│    │  evaluatePolicy()      │            (passkey required)  │
│    │  (guide 39)            │                                │
│    └──────────┬─────────────┘                               │
│               │ allow                                        │
│         ┌─────▼──────────────────────────────┐              │
│         │  4. Tool execution                  │              │
│         └─────┬──────────────────────────────┘              │
│               │                                              │
│    ┌──────────▼─────────────┐                               │
│    │  5. Dissent Reviewer   │ (guide 77)                    │
│    │  dissentReviewer.ts    │ Writes self_audit row if      │
│    │                        │ policyWarn flag is set in     │
│    │                        │ agentOutboundTable            │
│    └──────────┬─────────────┘                               │
│               │ self_audit reflection                        │
│    ┌──────────▼─────────────────────────────┐               │
│    │  6. Conviction store update            │               │
│    │  If it triggers commitSelfMod() with   │               │
│    │  the dissent insight, it becomes a     │               │
│    │  new conviction for future enforcement │               │
│    └────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

---

## Step-by-step enforcement

### Step 1 — Conviction snapshot

At turn start, `getConstitutionContext()` returns all active conviction rows for the wallet. These are injected into the system prompt AND passed to `checkPolicy()`. The snapshot is taken once per turn to avoid TOCTOU races between conviction changes.

### Step 2 — PolicyEngine pre-flight

`checkPolicy()` applies four checks in order:

1. **Dangerous-arg scan** — regex patterns on `toolArgs` string detect injection patterns, seed phrases, key material extraction. Verdict: `block`.
2. **passKey floor** — if `passKeyFloor=true` and no `x-passkey-proof` header present. Verdict: `block` (with `suggestPassKey` signal).
3. **Constitutional boundary** — for each conviction with `blockPattern`, test if `toolName` matches. Verdict: `block`.
4. **Risk class + band alignment** — if `riskClass` is `high_write` and no explicit conviction endorses this tool, or band ≥ 4 in `agentToolBandsTable`. Verdict: `warn` or `block`.

### Step 3 — Authority band gate

The existing `evaluatePolicy()` from `agentPolicyEngine.ts` runs after the policy engine pre-flight. It applies the authority band check (pass/require-approval/block). The two systems are additive: a `warn` from step 2 does NOT suppress the band gate.

### Step 4 — Tool execution

If both checks pass, the tool executes. If policy warned (`_policyWarnReason`), the warn reason is stored and emitted as a `⚠️ Policy note:` suffix in the agent response.

### Step 5 — Dissent reviewer

The `dissentReviewer` worker (runs every 5 minutes) queries `agentOutboundTable` for rows with `policyWarn` set. For each, it writes a `self_audit` reflection to `kaiReflectiveMemoryTable`. The reflection embeds the outbound row ID as a fingerprint (`[dissent:<id>]`) to prevent duplicate entries.

### Step 6 — Conviction update

On subsequent turns, the agent can call `set_conviction(...)` (powered by `setConviction()` → `kaiConstitutionTable`) to formally add the dissent insight as a conviction. Once stored, future calls that match the conviction's `blockPattern` will be blocked at step 2, completing the feedback loop.

`set_conviction` now fires a fire-and-forget `rememberMemory()` call immediately after the DB write succeeds. This writes a plain-language trace (`Set conviction [kind]: statement`) to the episodic memory store, so `recall_memory` on a future session can surface the fact that a conviction was set — not just that one exists in the constitution table. Without this write trail, the agent had no episodic evidence of *when* a conviction was established, making it prone to false "I haven't stored that yet" reports.

### Step 6b — Mid-session verification via `self_check`

The agent can call `self_check({ question: "what convictions/values/beliefs do I have?" })` at any point in a conversation to query live DB state without a tool round-trip. The `self_check` handler keyword-routes to `kaiConstitutionTable` (and six other domains) and returns a formatted snapshot. This closes a gap where the agent would report a conviction as "not yet set" because it relied on context-window memory rather than the live DB — the same false-done failure mode that motivated guides 81 and 82.

---

## Properties of the unified loop

| Property | Mechanism |
|---|---|
| Semantic enforcement (not just tool-name gating) | Arg-level scan + conviction `blockPattern` can match against argument content |
| Non-silent dissent | `warn` verdict is emitted to user + logged as dissent reflection |
| Conviction-driven escalation | Dissent → self_audit → commitSelfMod → new conviction → future block |
| No circular self-agreement | `commitSelfMod` gate requires divergent-probe pass (guide 77 §self-tuning) |
| Fail-closed for unknown tools | Band ≥ 4 default for unregistered tool names (`validateToolName` guard) |

---

## Novel contribution (beyond guides 38, 39, 77)

The loop closes a gap that none of the three prior guides addressed: **the path from a single turn's dissent to a durable constitutional update**. Guide 38 defines the conviction structure. Guide 39 defines the band gate. Guide 77 defines dissent as a first-class event. Guide 81 defines the **feedback arc** that converts dissent into conviction — turning a one-time warning into a permanent policy.

---

## Files

- `artifacts/api-server/src/lib/policyEngine.ts` — step 2 implementation
- `artifacts/api-server/src/workers/dissentReviewer.ts` — step 5 implementation
- `artifacts/api-server/src/lib/agentPolicyEngine.js` — step 3 (authority bands, pre-existing)
- `lib/db/src/schema/kaiConstitution.ts` — conviction store (step 1 and 6)
- `lib/db/src/schema/toolCallLog.ts` — `risk_class`, `risk_score`, `policy_decision` columns record the verdict of step 2 per tool invocation
- `artifacts/api-server/src/lib/constitutionEngine.ts` — `setConviction`, `getConstitutionContext`
- `artifacts/api-server/src/lib/selfModify.ts` — `commitSelfMod` gate (step 6)

---

## Deferred

- Conviction inference from conversation patterns (auto-suggest conviction candidates)
- Multi-wallet conviction federation (guardian consensus on shared convictions)
- Conviction expiry and re-endorsement schedule

See `dbk-defer-list.md` for parked items.
