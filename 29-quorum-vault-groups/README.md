# Quorum Vault Groups (M-of-N approval + autonomous child sub-vaults)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A shared vault — a family account, a team treasury, a DAO sub-budget — needs two governance shapes at once:

1. **Quorum control for significant actions.** Sensitive operations (rotate a key, send funds, change policy) must be approved by **M of N** designated signers before they execute. No single member, not even the owner, can act unilaterally.
2. **Bounded autonomy for delegated spenders.** Children / employees / agents get a **sub-vault with a daily spend cap**. Below the cap they spend freely and instantly — no committee, no friction. Above the cap (or for accounts flagged as always-needs-approval) the spend automatically **escalates to quorum**.

These two shapes pull in opposite directions — strict collective control vs. frictionless delegation — and the system has to host both under one policy, with the usual hazards: concurrent approvals must not double-count, a daily cap must reset cleanly each day, and the moment a quorum is reached there must be a tamper-evident proof of *who* approved.

## Design decisions

**Why an explicit threshold `M` clamped to the signer set.**
The policy stores `thresholdM` and a list of `requiredSigners`. The threshold is clamped to `[1, signerCount]` at creation: you cannot require more approvals than there are signers (that would deadlock the vault), and you cannot drop below 1. This makes every policy *satisfiable by construction*.

**Why approval is wrapped in a database transaction.**
The approve path does duplicate-check, insert, recount, and the quorum state transition **all inside one transaction**. Two signers tapping "approve" at the same instant must not both believe they were the deciding vote, and the same signer must not be counted twice. The transaction (backed by a unique index on `(proposal_id, approver_wallet)` as a second line of defence) serializes this so the count is always exact and the pending→approved transition fires exactly once.

**Why a quorum proof is attached the moment `approvals ≥ M`.**
When the count reaches the threshold *inside the transaction*, the system computes a `quorumProof` — a Merkle-style commitment over `(ownerWallet, sessionId/proposalId, threshold, attestedCount, the list of approver addresses)` — and stores its root on the proposal. This is a portable, tamper-evident attestation that "these specific signers met the M-of-N bar for this exact action," verifiable later without trusting the database row alone.

**Why some actions auto-execute and others only get marked "approved."**
Once quorum is met, internal vault/child management actions (`vault.*`, `child.*`) are marked `executed` immediately — they are state changes the system itself can apply. Value-moving actions (`wallet.send`, etc.) are only marked `approved`, leaving the actual on-chain broadcast to a separate executor. Reaching quorum authorizes; it does not blindly broadcast.

**Why child sub-vaults are a separate autonomy lane with their own daily cap.**
A child has `spendCapWei`, `dailySpentWei`, `dailyResetDate`, and an `alwaysRequirePasskey` flag. A child spend is gated by a single rule with three escalation triggers:

```
escalate to quorum  if  cap == 0
                    or  alwaysRequirePasskey
                    or  dailySpent + amount > cap
otherwise           autonomous: debit dailySpent, allow instantly
```

- `cap == 0` means "no self-service allowance" — *every* spend escalates. This is the safe default for a freshly added child.
- `alwaysRequirePasskey` is a per-child override forcing escalation regardless of amount.
- Exceeding the remaining daily allowance escalates only the spends that cross the line; smaller ones stay autonomous.

**Why the daily debit is an atomic conditional UPDATE.**
The autonomous debit is `UPDATE … SET dailySpent += amount WHERE … AND dailySpent + amount ≤ cap` — the WHERE clause re-checks the cap at write time. Two concurrent child spends cannot both pass a stale read and jointly exceed the cap; only the one whose post-debit total still fits commits.

**Why the daily window resets by date string, not a timer.**
Each child stores `dailyResetDate` as a `YYYY-MM-DD` string. On any access, if `dailyResetDate !== today`, the accumulator is zeroed and the date advanced. No cron job, no background sweep — the reset is lazy and happens the first time the new day's spend is evaluated, which is both simpler and crash-safe.

**Why proposers cannot silently approve their own proposal.**
Proposing and approving are separate endpoints; the fan-out notifies the *other* signers that their signature is needed. The threshold count is over distinct approver wallets, so a proposer still has to gather M total approvals.

## Algorithm

```
createPolicy(name, signers[], M):
    M = clamp(M, 1, len(signers))          # always satisfiable
    store policy

propose(action):                            # any member
    validate action ∈ allow-list
    store proposal(status=pending)
    notify other signers

approve(proposalId, assertion):             # transactional
    BEGIN
      if alreadyApproved(me): return already_approved
      insert approval(me)
      count = approvals(proposalId)
      if count >= policy.M and proposal.pending:
          proof = quorumProof(owner, proposalId, M, count, approvers[])
          status = isInternal(action) ? executed : approved
          update proposal(status, quorumRoot=proof.root)
    COMMIT
    return { quorumMet: count>=M, status, quorumProof? }

childSpend(child, amount):                   # autonomous lane
    if dailyResetDate != today: dailySpent=0; dailyResetDate=today
    if cap==0 or alwaysRequirePasskey or dailySpent+amount > cap:
        return { quorumRequired: true, reason }
    atomically: dailySpent += amount  WHERE dailySpent+amount <= cap
    return { quorumRequired: false }         # spent instantly
```

## Reference implementation

See [`quorum-vault.ts`](./quorum-vault.ts) in this directory.

It implements the full machine over an in-memory store: threshold clamping, the transactional/atomic approval with duplicate protection, a quorum-proof commitment (built from `node:crypto` hashing as a stand-in for the production Merkle proof), the internal-vs-value action split, and the child-sub-vault autonomy lane with atomic daily-cap debit and lazy date reset.

Dependencies: Node.js built-in `crypto` only.

## Usage

```typescript
import { QuorumVault } from "./quorum-vault.js";

const v = new QuorumVault();
const policy = v.createPolicy({
  owner: "0xowner", name: "Family Vault",
  requiredSigners: ["0xa", "0xb", "0xc"], thresholdM: 2,
});

const p = v.propose(policy.id, "0xa", "wallet.send", { to: "0x…", amountWei: "1" });
v.approve(policy.id, p.proposalId, "0xa");           // 1 of 2
const done = v.approve(policy.id, p.proposalId, "0xb"); // 2 of 2 → quorum
console.log(done.quorumMet, done.status, done.quorumRoot);

// Child sub-vault: autonomous under cap, escalates over it
const child = v.addChild(policy.id, "0xowner", { childWallet: "0xkid", label: "Allowance", spendCapWei: "100" });
v.childSpend(policy.id, child.childId, "0xkid", "40"); // { quorumRequired: false }
v.childSpend(policy.id, child.childId, "0xkid", "80"); // { quorumRequired: true, reason: "cap_exceeded" }
```

## Limitations and extensions

- **Approval assertions are stored for audit, not fully verified here.** The reference (like the source it models) records the passkey assertion alongside each approval; binding it to a verified WebAuthn challenge/origin is the production hardening step. Always pair quorum with the passkey floor from guides 17/20 for value-moving actions.
- **Quorum authorizes, it does not broadcast.** Value actions stop at `approved`; a separate executor must perform the on-chain step and reconcile failures. Don't conflate "quorum met" with "funds moved."
- **The daily cap is per-child and per-UTC-day.** It does not bound transaction count or aggregate across children. Combine with the spend governor (guide 18) for cross-account daily totals.
- **Lazy reset means the date advances on access.** A child that never spends will show a stale `dailyResetDate` until the next evaluation — harmless, but don't read that field as a heartbeat.
- **Threshold changes need care.** Lowering M on a vault with live pending proposals can retroactively satisfy them; gate policy edits behind quorum too (the action allow-list includes `policy.update`).
