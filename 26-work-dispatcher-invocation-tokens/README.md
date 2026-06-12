# Work Dispatcher with Scoped Invocation Tokens

## Problem

A platform lets third-party apps invoke capabilities on behalf of a user — "summarize my calendar", "rebalance my portfolio", "render this scene". These capabilities run asynchronously: the app fires a request, a worker processes it later, and the result is delivered by webhook or poll. Two access-control problems appear immediately.

**1. The worker needs user context but must not hold the user's session token.**
To do its job, the worker needs to know *which* user it is acting for (their wallet address, account id) and *what* it is allowed to touch (the scope of the grant). The naive solution hands the user's raw session bearer token to the third-party app so it can call back into the platform. That is a catastrophic over-share: the session token authorizes *everything* the user can do, for as long as the session lives. A capability to read a calendar should never grant the ability to drain a wallet.

**2. Job identifiers leak, so the job id alone cannot be the authorization.**
Async job ids surface everywhere: server logs, analytics dashboards, browser devtools, webhook bodies, error trackers. If "knowing the job UUID" were sufficient to read the job's result, anyone who scraped a log could read other users' capability outputs indefinitely. Job ids are *names*, not *secrets*.

The work dispatcher solves both with a single short-lived, job-scoped **invocation token** that is minted at invoke time, bound to exactly one job, and expires the moment the job resolves.

## Design decisions

**Separate app identity from user identity.**
There are two distinct principals in this system. The *app* authenticates with a long-lived `clientId` + `clientSecret` (it registered a capability manifest). The *user* authenticates with a session token to *grant* the app a capability. These never mix: the app can invoke only capabilities a user has explicitly granted, and the grant records *which wallet* authorized it so the worker can later learn the user's identity without ever seeing the session token.

**The invocation token is the only bridge to user context.**
When an app invokes a granted capability, the dispatcher mints a fresh random `invocationToken` (a UUID — opaque, unguessable) and stores it on the job row. This token — *not* the session token, *not* the bare job id — is what the worker presents to read user context (`GET /job/:id/context`) and to poll status (`GET /job/:id`). It is returned in the invoke response and echoed in the webhook envelope.

**The context token expires on job resolution; the polling token lives slightly longer.**
There are two read paths with deliberately different lifetimes:
- `/job/:id/context` returns the user's wallet + grant scope. The worker only needs this *while it executes*, so the endpoint returns `410 Gone` once the job is `completed` or `failed`. After resolution, the door to user context is shut.
- `/job/:id` returns status + result. This must stay valid *through* completion, because the whole point is for the app to fetch its own result after the worker finishes. So polling accepts the same token but does not 410 on resolution.

**Idempotency is enforced at the storage layer.**
An app may retry an invoke (network blip, at-least-once delivery). A unique partial index on `(grantId, idempotencyKey)` means a retry returns the *existing* job — including its original `invocationToken` — instead of creating a duplicate. Without echoing the original token, an idempotent retry would receive a job id it could not authenticate against.

**Scoped (paired-device) sessions cannot create or revoke grants.**
Grants are durable and carry full capability permissions that outlive the session that made them. A limited, paired-device session (see guide 14) is blocked from this security-sensitive write.

**Session tokens are fingerprinted, never stored raw.**
The grant row records a SHA-256 hash of the creating session token (for cleanup correlation) — the raw bearer is never persisted and cannot be replayed out of the database.

**Revocation is authorized by wallet ownership, not session match.**
A grant belongs to the *wallet* that created it. Tying revoke to the original session hash would make grants un-revocable once the session rotated — turning a safety control into a dead button. Any future authenticated session for the same wallet can revoke.

## Algorithm

```
Register   (app):   POST /manifest   clientId+secret → store capability manifest
Grant      (user):  POST /grant      sessionToken → verify capability is declared,
                                      store grant{ id, walletHash?, wallet, scope, expiresAt,
                                                   sessionTokenHash }
Invoke     (app):   POST /invoke     clientId+secret + grantId →
                       verify grant: belongs to app, not revoked, not expired
                       if (idempotencyKey already used) return existing job (+ its token)
                       invocationToken = randomUUID()
                       jobId = enqueue(grantId, payloadHash, idempotencyKey, invocationToken)
                       fire webhook { event, jobId, params, wallet, invocationToken }   (best-effort)
                       return { jobId, status: "pending", invocationToken }

Worker reads context:  GET /job/:id/context   Bearer <invocationToken>
                          if token mismatch → 403
                          if job resolved   → 410 (context window closed)
                          return { wallet, capabilityKey, scopeJson, expiresAt }

Worker posts result:   POST /result   clientId+secret + jobId + status + result
                          verify job belongs to a grant owned by this app
                          completeJob(jobId, status, result)

App polls result:      GET /job/:id   Bearer <invocationToken>
                          if token mismatch → 403
                          return { status, result }   (valid through completion)
```

The invocation token is generated only at invoke time and bound to a single job. Possession of the job id is necessary but **not sufficient** — every read path also checks the token.

## Reference implementation

See [`work-dispatcher.ts`](./work-dispatcher.ts) in this directory. It is an in-memory model of the full lifecycle: register → grant → invoke → context → result → poll, including idempotency dedup, token expiry on resolution, and wallet-scoped revocation. A production deployment swaps the in-memory maps for database tables with a unique partial index on `(grantId, idempotencyKey)`.

## Usage

```typescript
import { WorkDispatcher } from "./work-dispatcher.js";

const wd = new WorkDispatcher();

// App registers a capability manifest
wd.registerManifest("app-123", "secret-abc", [{ key: "calendar.summarize" }]);

// User grants the capability (authenticated by session)
const { grantId } = wd.grant("session-token-xyz", "0xWALLET", "app-123", "calendar.summarize", {}, 3600);

// App invokes — receives a scoped invocation token
const inv = wd.invoke("app-123", "secret-abc", grantId, { range: "this-week" });

// Worker reads user context using ONLY the invocation token
const ctx = wd.jobContext(inv.jobId, inv.invocationToken);
console.log(ctx.wallet, ctx.scopeJson);

// Worker posts the result
wd.postResult("app-123", "secret-abc", inv.jobId, "completed", { summary: "3 meetings" });

// App polls for the result with the same token
console.log(wd.pollJob(inv.jobId, inv.invocationToken));

// Context token is now dead (job resolved)
try { wd.jobContext(inv.jobId, inv.invocationToken); } catch (e) { /* 410 */ }
```

## Limitations and extensions

- **Webhook delivery is best-effort.** The invoke response is the authoritative channel for the invocation token. The webhook can be blocked by an SSRF guard or fail in transit, so apps must treat it as a hint, not a guarantee, and fall back to polling.
- **SSRF hardening on webhooks is mandatory.** Webhook URLs are user/app-supplied. Before delivering, resolve DNS and reject any private/reserved IP, and pin the connection to the validated address to defeat DNS rebinding (see guide 23). The reference impl notes this hook but does not implement the network call.
- **Token rotation is coarse.** The token is valid for the life of the job. For very long-running jobs you may want a refresh mechanism; for most async work the job lifetime is short enough that a single token suffices.
- **No result encryption at rest.** The stored result is plaintext in this model. If results contain sensitive material, encrypt them under a key the app holds and store only ciphertext.
