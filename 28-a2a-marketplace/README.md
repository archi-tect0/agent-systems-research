# Agent-to-Agent Marketplace and Job Feed

## Problem

As autonomous agents proliferate, they need a way to *hire each other*. One agent is good at summarization, another at image generation, another at on-chain analytics. Rather than every agent re-implementing every skill, we want a marketplace where agents publish their capabilities, other agents (acting for their users) post jobs, the hired agent does the work and submits a verifiable result, and value changes hands under escrow.

The central difficulty is **tenant isolation in a system where job identifiers are not secret**. A marketplace is, by design, a place where many independent parties' work coexists. If the data model is sloppy, agent A can read agent B's job results, or buyer X can see buyer Y's task specs. The temptation is to treat the job UUID as a capability ("if you know the id, you can read it"). That is wrong: job ids appear in logs, dashboards, and webhook bodies. **Authorization must always be derived from the authenticated principal, never from possession of an identifier.**

There are also two distinct authentication models that must not be confused:
- **Humans** (developers / users) authenticate with a session token. They register agents, post jobs (hire), raise disputes, and use kill switches.
- **Agents** authenticate with a per-agent API key. They submit proof-of-work for jobs assigned to them.

## Design decisions

**Two principals, two credential types — never interchangeable.**
A session token can register an agent and hire other agents. An agent API key can *only* submit results for jobs assigned to that exact agent. The API key is shown exactly once at generation (only its SHA-256 hash is stored) and is verified by hashing the presented key and matching the stored hash. The owner wallet of an agent is the human; the API key is the machine.

**Every read is scoped to the authenticated principal — the job id is never authorization.**
- The job *feed* (`GET /jobs`) always filters by the caller's wallet: as a buyer you see jobs you posted; with `role=seller` you see jobs assigned to agents you own. There is no "all jobs" view.
- Job *detail* (`GET /jobs/:id`) is readable only by the buyer **or** the owner of the assigned agent — checked against the authenticated wallet, after the row is loaded.
- Result submission (`POST /jobs/:id/submit`) requires the agent API key *and* verifies `job.agentId === agent.id`.

**Public surfaces expose only safe fields.**
Browsing agents and reading platform stats are public, but the agent's `apiKeyHash` is stripped from every response. Sensitive columns never cross the wire.

**Escrow + platform fee computed at hire time.**
Posting a job records an escrow amount and a platform fee (e.g. 1.5%) and a deadline. Settlement on successful submit credits the agent `escrow − fee` and increments reputation/earnings counters.

**Reputation is a first-class, monotonic-ish signal.**
Completing a job bumps `completedJobs` and earnings. A dispute bumps `failedJobs` and subtracts a fixed penalty from `reputationScore` (floored at 0). Browse ordering ranks by reputation then job volume, so reliable agents surface first.

**Kill switches are owner-only and immediate.**
The agent owner can `pause` (status → paused) and `resume` (→ active). A paused agent disappears from active browse, cannot be hired, and cannot submit results. This is the human's emergency stop on their own autonomous worker.

**Outbound webhooks are SSRF-hardened and fire-and-forget.**
When a job is created, the assigned agent is notified by webhook. Webhook URLs are validated (HTTPS only, DNS-resolved, every resolved A/AAAA record checked against private/reserved ranges) and the request is sent to the *pinned* validated IP — never re-resolved — to eliminate the DNS-rebinding window. The payload is HMAC-signed so the receiver can verify authenticity. Delivery failure never blocks the API response.

**Scoped (paired-device) sessions are blocked from marketplace writes.**
Registering agents, hiring, generating keys, and disputing are durable, value-bearing actions; a limited paired-device session may not perform them.

## Algorithm

```
Register agent (human session):
  POST /agents { name, slug, category, webhookUrl, ethPayoutAddress, ... }
    block scoped sessions; validate webhookUrl (SSRF); enforce unique slug
    insert agent { ownerWallet = session.wallet, status: "active" }

Generate API key (owner only):
  POST /my/agents/:id/key
    verify agent.ownerWallet == session.wallet
    rawKey = "a2a_" + random(32B); store sha256(rawKey); return rawKey ONCE

Hire / post job (human session):
  POST /jobs { agentId, taskSpec, escrowAmountEth, deadlineHours }
    block scoped; agent must be active
    fee = escrow * 0.015; deadline = now + hours
    insert job { buyerWallet = session.wallet, status: "pending" }
    fire SSRF-guarded webhook job.created  (best-effort)

Submit proof (agent API key):
  POST /jobs/:id/submit { result, proofHash }
    agent = resolveByApiKey(); reject if paused
    job.agentId must == agent.id; job must be pending/in_progress; before deadline
    set status=completed, result, proofHash
    credit agent: completedJobs++, earnings += escrow - fee

Read job detail (human session):
  GET /jobs/:id
    load job; allow only if buyerWallet == wallet OR ownerWallet(agent) == wallet
    else 403

Job feed (human session):
  GET /jobs?role=buyer|seller
    buyer  → where buyerWallet == wallet
    seller → where agentId in (my agent ids)
```

## Reference implementation

See [`a2a-marketplace.ts`](./a2a-marketplace.ts) in this directory. It models agent registration, one-time API-key issuance with hashed storage, hiring with escrow/fee, agent proof submission with deadline + assignment checks, reputation updates, kill switches, disputes, and — crucially — the principal-scoped authorization on every read. The SSRF-guarded webhook is represented by an injectable hook (see guide 23 for the full network-level implementation).

## Usage

```typescript
import { Marketplace } from "./a2a-marketplace.js";

const m = new Marketplace();

// A developer registers an agent (human session)
const agent = m.registerAgent("session-dev", "0xDEV", {
  name: "Summarizer", slug: "summarizer", category: "text",
  webhookUrl: "https://hooks.example.com/a2a", ethPayoutAddress: "0xDEV",
});

// Mint the agent's API key (shown once)
const { apiKey } = m.generateApiKey("session-dev", "0xDEV", agent.id);

// A buyer hires the agent
const job = m.postJob("session-buyer", "0xBUYER", {
  agentId: agent.id, taskSpec: "Summarize this report", escrowAmountEth: "1.0", deadlineHours: 24,
});

// The agent submits proof of work using its API key
m.submitProof(apiKey, job.id, { summary: "..." }, "0xPROOFHASH");

// Only the buyer or agent owner can read the job
console.log(m.getJob("0xBUYER", job.id).status); // "completed"
```

## Limitations and extensions

- **Escrow is accounted, not custodial here.** The model tracks escrow/fee numbers; an on-chain or custodial settlement layer is out of scope. Wire `submitProof` and `dispute` to a real escrow contract for funds movement.
- **Dispute resolution is a stub.** Raising a dispute flips status and penalizes reputation; an arbitration/refund workflow is a natural extension.
- **Search is naive.** Browse does a simple substring filter to avoid a full-text index dependency; replace with proper FTS at scale.
- **No rate-based abuse controls in the model.** The production routes wrap every endpoint in a rate limiter; add the same in any real deployment.
- **Webhook receiver authenticity.** The payload is HMAC-signed; receivers must verify the signature and reject replays (include and check a timestamp/nonce).
