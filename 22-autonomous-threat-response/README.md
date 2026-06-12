# Autonomous Threat Response with a Safety Contract

## Problem

Once an AI agent can *observe* security telemetry, the next obvious step is to let it *act* on it — block a hostile IP, trip a circuit breaker on an abused route, freeze a misbehaving app, revoke a stolen session, rate-limit a wallet. Defensive automation closes the loop between detection and mitigation in seconds instead of minutes.

But handing a language model the keys to the firewall is dangerous in specific, predictable ways:

- **Hallucinated justification.** The model could invent a threat to justify an action no real event supports.
- **Runaway loops.** A model stuck in a reasoning loop could fire the same destructive action dozens of times.
- **Irreversibility and opacity.** A user wakes up to find their app frozen with no record of who did it, why, or how to undo it.
- **Authority confusion.** An action initiated by the autonomous agent must be held to a stricter standard than the same action taken by a human operator.

This guide describes a **safety contract**: a single chokepoint module that every privileged defensive action must pass through. The contract makes the dangerous actions *possible but bounded* — every action must cite a real event, every action is rate-limited and circuit-broken, every action is logged append-only with a one-tap undo, and the autonomous performer is held to stricter rules than a human admin.

## Design decisions

**Why one chokepoint module?**
Nothing else in the system — not the agent's tool handlers, not the admin UI — is allowed to block, freeze, or revoke directly. They all call the helpers exported by this module. Centralizing the dangerous verbs means the safety checks cannot be bypassed by a code path that forgot to include them; there is exactly one place to audit.

**Why mandatory citation, and why is `manual:` rejected for the agent?**
Every action requires a `threatEventId`. For the **agent** performer, that id must match a real event currently in the live threat feed — the model cannot act on a threat it cannot point to. The synthetic `manual:<uuid>` prefix is explicitly *rejected* for the agent so the model cannot fabricate a citation to defeat the contract. A human **admin** may use `manual:<uuid>` for an operator-initiated action with no logged event, because a human is the accountable party. This single rule is the difference between "act because the data says so" and "act because the model decided to."

**Why distinguish performer = agent vs. admin?**
The same five actions are exposed to both an autonomous agent and a human operator, but with different guardrails. The agent is subject to rate limits, the burst circuit breaker, and the no-`manual:` citation rule. The admin bypasses the rate limits (a human is intentionally in the loop) and may cite manually. The performer is stamped on every audit row so the log always answers "who did this — the model or a person?"

**Why rate limits *and* a burst breaker?**
Two different failure modes need two different bounds:
- *Steady abuse / quota*: 5 actions per hour, 20 per day, per wallet. This caps total blast radius over time.
- *Runaway loop*: 3 actions inside any 10-minute window auto-pauses the capability for that wallet and drops a card into the user's inbox asking them to re-enable. This catches a model stuck firing repeatedly far faster than the hourly cap would.

The burst check pauses when the *prior* count already equals threshold − 1, so the third action in ten minutes is what trips it (the documented "3-in-10-min" behaviour, not the fourth).

**Why fail closed on the rate-limit query?**
If the database read that counts recent actions fails, the gate returns an error and the action does *not* proceed. A monitoring outage must never silently remove the rate limit — when in doubt, deny.

**Why append-only audit rows plus an outbound undo card?**
Every action writes an immutable row (`action`, `target`, `threatEventId`, `reason`, `performedBy`, `expiresAt`, `metadata`) *before* anything else. Then it drops a human-readable card into the user's inbox with a one-tap **Undo**. The audit row is the system of record; the card is the human-facing notification and reversal handle. Outbound-card failure is non-fatal — the audit row is already durable.

**Why is reversal a first-class operation?**
`revertAction(id, by)` undoes the underlying effect (unblock the IP, reset the circuit, unfreeze the app, drop the wallet limit) *and* stamps `revertedAt` + `revertedBy` on the original audit row. Reversal is itself audited. Session revocation is intentionally *not* reversible — re-authentication is required — which is encoded explicitly rather than left as an accidental gap.

**Why duration clamping with policy ceilings?**
Each action type has a default duration and a hard maximum (e.g. an IP block defaults to 1 hour, caps at 24 hours). A caller may request shorter; a longer request is clamped down. The model cannot ask for a year-long block.

## Algorithm

```
ACTION(args, wallet, performer):
  1. validate inputs (target present and well-formed)
  2. CITATION CHECK:
       if performer == agent:
         reject if threatEventId starts with "manual:"
         require threatEventId ∈ live threat feed
       else (admin):
         accept real event id OR "manual:<uuid>"
  3. if performer == agent: GATE(wallet)        // rate + burst, fail-closed
  4. clamp duration to [default, max]
  5. apply effect via underlying primitive
  6. recordAction(...)  → append-only row + outbound undo card
  7. return { ok, actionId, expiresAt }

GATE(wallet):
  if wallet is burst-paused: reject BURST_PAUSED
  count agent actions in last hour / day / 10-min window   (fail closed on error)
  if burstCount >= 3 - 1:                                   // 3rd action trips it
    pause wallet for 1h; drop "auto-paused" card; reject BURST_PAUSED
  if hourCount >= 5:  reject RATE_LIMITED
  if dayCount  >= 20: reject RATE_LIMITED
  else: allow

REVERT(actionId, by):
  load row; reject if missing or already reverted
  undo the effect for that action kind (session revoke = not reversible)
  stamp revertedAt + revertedBy on the row
```

## Reference implementation

See [`threat-response.ts`](./threat-response.ts) in this directory. To stay self-contained it stubs the underlying primitives (the firewall, the circuit breaker, the app/session/wallet stores) behind a small in-memory `DefenseBackend` interface and an in-memory audit store; in a real system these are backed by the live security monitor and a database. The safety contract — citation enforcement, rate/burst gating, append-only audit, reversal — is the real, faithfully reproduced logic.

## Usage

```typescript
import { ThreatResponder, InMemoryBackend } from "./threat-response.js";

const responder = new ThreatResponder(new InMemoryBackend());

// The agent must cite a live event id; a fabricated or "manual:" cite is rejected.
const res = await responder.blockIp(
  { ip: "203.0.113.7", reason: "credential stuffing", threatEventId: liveEventId },
  wallet,
  "agent",
);

if (res.ok) {
  // res.actionId can later be reverted, with the reversal itself audited.
  await responder.revertAction(res.actionId!, "user:alice");
}
```

## Limitations and extensions

- **The burst pause is in-memory.** A process restart clears the pause map. Persist it (or rehydrate from the audit log) if restarts must not reset a tripped breaker.
- **Citation freshness depends on the feed.** The contract trusts the live threat feed as ground truth. If the feed itself can be poisoned, the citation check inherits that weakness — harden the detection layer separately.
- **Rate limits are per-wallet, not global.** A coordinated attack spread across many wallets is not bounded by the per-wallet caps. Add a global ceiling for the agent performer if needed.
- **Reversibility is per-action-kind.** Some effects (session revocation) cannot be cleanly undone. Make irreversibility explicit and surface it in the undo card so users are not surprised.
- **No human approval step here.** This contract bounds *autonomous* action. For higher-stakes verbs, add a per-action approval gate (see the multi-tenant MCP host guide) so the model proposes and a human confirms.
