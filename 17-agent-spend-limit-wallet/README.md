# Agent Spend-Limit Wallet (autonomous spend with a human approval floor)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An autonomous software agent — an LLM tool-caller, a trading bot, a recurring-payment daemon — needs to *spend money on-chain on its own*. The whole point is that no human is in the loop for routine actions: pay the API bill, top up a subscription, settle a small invoice. But an agent that can move funds without limit is also the perfect blast radius for a bug, a prompt injection, or a stolen session token. "Drain the wallet" is one bad tool call away.

We want a wallet that is **autonomous within bounds and human-gated beyond them**, with three tiers:

1. **Free zone** — small amounts the agent executes immediately, no human.
2. **Approval zone** — medium amounts that are *queued as pending* and require an explicit human approval (a real WebAuthn/passkey assertion) before they broadcast.
3. **Hard wall** — amounts above an absolute ceiling that are *rejected outright*, no approval path at all.

The wallet's key must be controllable by the agent's backend (so it can sign and broadcast) yet never require the user to hand over or store a private key. And concurrent approvals — a double-tapped button, a retried network request — must never produce a double-spend.

## Design decisions

**Why a deterministically derived key, not a stored one.**
The wallet's private key is derived on demand via `HKDF-SHA256("agent:<wallet>:<ADDR_SECRET>")` — domain-separated from every other key the system derives. There is no private key sitting in a column waiting to be stolen; it is reconstructed from the user's identity plus a server-held secret only at signing time. This is the same shadow-derivation pattern as guide 15, scoped to the agent role by its info string.

**Why two thresholds, not one.**
A single limit forces a false choice: set it low and the agent is useless; set it high and a compromise is catastrophic. Two numbers give a graceful middle:

| Condition (`amount` vs config) | Outcome | Status |
|---|---|---|
| `amount > ceiling` | rejected immediately | — |
| `threshold < amount ≤ ceiling` | needs human approval | `pending` |
| `amount ≤ threshold` | auto-executed | `queued` |

The **threshold** is the trust budget the user grants the agent; the **ceiling** is the absolute maximum the user is ever willing to lose to a single approved transaction. The ceiling check happens *first* and is unconditional — there is no assertion that unlocks above the ceiling.

**Why approval requires a real WebAuthn assertion, not just a click.**
The most important property is the **passkey floor**: *a stolen bearer token alone must never broadcast an on-chain transaction.* The approve endpoint demands a fresh WebAuthn authentication assertion, bound to the specific transaction id, verified server-side (challenge, origin, RP ID, credential, signature counter). An attacker who steals the session token still cannot approve a pending spend because they cannot produce the hardware-backed assertion. Authorization (you hold a valid session) and approval (you are physically present with the passkey) are deliberately separated.

**Why the challenge is bound to the transaction id and single-use.**
The challenge type is `agent-approve:<txId>`. A challenge issued for one transaction cannot be replayed to approve a different one, and consuming it is single-use, so an assertion cannot be reused. The authenticator's signature counter is persisted on every approval to detect cloned-authenticator replay.

**Why approval is an atomic conditional UPDATE.**
Marking a transaction approved is `UPDATE … SET status='approved' WHERE id=? AND status='pending'`. Only the first concurrent caller's update matches a `pending` row and returns it; the second matches nothing and is rejected as "already approved." This makes double-spend from a double-tap or retry impossible at the database level, before any broadcast happens — no application-level lock required.

**Why the spend is only broadcast *after* the atomic claim.**
The on-chain `sendTransaction` happens only once the row has been atomically flipped to `approved`. If broadcast fails, the row is moved to `failed` (not back to `pending`), so a failed attempt is never silently retried into a second send.

## Algorithm

```
configure(threshold, ceiling, enabled)        # user sets the trust budget

spend(amount, recipient, reason):             # agent proposes
    if not enabled:            reject  "SPEND_WALLET_DISABLED"
    if amount > ceiling:       reject  "EXCEEDS_CEILING"      # hard wall, no override
    if amount > threshold:     status = "pending"             # needs human
    else:                      status = "queued"              # auto-execute
    insert tx(status)

approve(txId, webauthnAssertion):             # human, with passkey
    require session has a registered passkey   # else: no_passkey_on_session
    verify WebAuthn assertion bound to agent-approve:<txId>   # the floor
    persist new signature counter              # replay defence
    atomically: UPDATE tx SET approved WHERE id=txId AND status='pending'
    if no row matched:         reject  "already <status>"     # double-spend guard
    broadcast on-chain
        success → status = "executed", store txHash
        failure → status = "failed"
```

## Reference implementation

See [`agent-spend-wallet.ts`](./agent-spend-wallet.ts) in this directory.

It models the full decision machine — key derivation, the two-threshold spend gate, the atomic approval claim, and a stubbed WebAuthn-assertion check standing in for the real verifier — using an in-memory store. The cryptographic *shape* (HKDF derivation, single-use tx-bound assertion, atomic conditional transition) matches the production route exactly; only the chain broadcast and the `@simplewebauthn/server` verification are stubbed so the file is self-contained.

Dependencies: Node.js built-in `crypto` only.

## Usage

```typescript
import { AgentWallet } from "./agent-spend-wallet.js";

const w = new AgentWallet("user-root-wallet", process.env.ADDR_SECRET!);
w.configure({ thresholdEth: 0.05, ceilingEth: 1.0, enabled: true });

w.spend({ amountEth: 0.01, recipient: "0xabc…", reason: "API top-up" });
// → { status: "queued" }  (under threshold → auto-executes)

const big = w.spend({ amountEth: 0.5, recipient: "0xdef…", reason: "invoice" });
// → { status: "pending" } (over threshold → needs approval)

w.approve(big.txId, validAssertion);   // requires a real passkey assertion
// → broadcasts; throws if the assertion is missing/invalid or already approved

w.spend({ amountEth: 5, recipient: "0x000…", reason: "oops" });
// → throws "EXCEEDS_CEILING"  (hard wall — no approval can unlock this)
```

## Limitations and extensions

- **The threshold/ceiling are per-transaction, not cumulative.** An agent could make many sub-threshold spends and drain the wallet without ever tripping a human gate. Pair this with a *velocity governor* (guide 18) that enforces a rolling daily total — the two patterns are complementary: this one gates single large spends, the velocity governor gates aggregate spend.
- **The secret protects everything.** As with all shadow derivation, anyone holding both the user's identity and `ADDR_SECRET` can reconstruct the agent key. Guard `ADDR_SECRET` in an HSM/KMS and version its info string for rotation.
- **The passkey floor only guards the approval zone.** Auto-executed (`queued`) spends below the threshold have no human in the loop by design — that is the convenience the user opted into. Keep the threshold genuinely small.
- **`enabled` is a kill switch, not a freeze.** Flipping `enabled=false` stops *new* spends; it does not claw back already-broadcast transactions. For incident response, combine with a guardian timelock (guide 18) that can freeze even pending and queued actions.
- **Stubbed broadcast/verification.** A production deployment must use the real `@simplewebauthn/server` verifier (full challenge/origin/RP-ID/counter checks) and a real signer/provider. The reference file stubs both to stay dependency-light and runnable.
