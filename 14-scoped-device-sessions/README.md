# Scoped Device Sessions

## Problem

A user signed in on their phone wants to use the same account on a laptop without typing credentials or moving a hardware key. The common pattern is QR-code pairing: the laptop shows a QR code, the phone scans it and approves, the laptop gets a session.

The naive version of this is dangerous. If the paired laptop session has the *same* authority as the phone session, then a QR code displayed on a screen — observable by anyone nearby, screenshotted, or shoulder-surfed — becomes a path to a fully-privileged session. The attacker does not need the user's passkey; they only need to win a race or trick the user into approving.

Two structural defenses are needed:

1. **The paired session must be read-only by default**, enforced at the protocol layer (a middleware that sees *every* request), not just by individual route handlers remembering to check. A paired device should be able to read balances, view notifications, browse the vault — but never export a private key, change recovery guardians, raise a spending limit, or approve *another* pairing.
2. **Elevation must be out-of-band and per-intent.** When the paired device genuinely needs to perform one sensitive action, it must request explicit approval from the already-trusted device, scoped to that single action, with a short expiry and one-time-use token — not a blanket upgrade to full authority.

## Design decisions

**Why a global guard instead of per-route checks?**
Per-route checks are a footgun: every new write endpoint is a place where a developer can forget the check, and the failure is silent (the scoped session gets write access it should not have). The guard is mounted once, globally, before the router. It intercepts every non-`GET`/`HEAD`/`OPTIONS` request carrying a session bearer, resolves the binding, and rejects scoped sessions with `403 SCOPED_SESSION` unless the path is on a small explicit allow-list. New write routes are protected by default; you have to *opt out* (add to the allow-list) to expose one — the safe direction.

**Why allow reads unconditionally?**
The entire point of a paired device is to be useful. Blocking reads would make it useless. `GET`/`HEAD`/`OPTIONS` pass through; the method check is the first line of the guard. The threat model is *state change*, not *information disclosure to an already-authenticated session on the user's own account* — and read endpoints are individually responsible for not leaking secret material (private keys are never returned by any read endpoint regardless of session type).

**Why a tiny, hand-curated write allow-list?**
A few writes are genuinely safe from a paired device and necessary for it to function: signing *itself* out, marking a notification read, saving launcher icon order, feeding background telemetry. Each entry is a deliberate decision: *can a stolen paired-device token cause user-visible harm through this endpoint?* If yes, it is not on the list. The list is matched by `RegExp` against the request path and kept deliberately short.

**Why fail *open* on a guard DB error, not closed?**
If the binding lookup throws (database hiccup), the guard logs and passes the request through to the route's own auth check rather than 403-ing. This is intentional: the guard is a *scoping* layer, not the *authentication* layer. The route behind it still resolves the session and rejects invalid tokens. Failing closed here would let a transient DB error take the whole API offline; failing open degrades to "the route's own auth still applies", which is safe because every sensitive route also resolves the session itself.

**Why must a scoped session never approve a new pairing?**
This is the most important single rule. If a paired-device token could approve *another* pairing, a holder of any scoped token could self-renew indefinitely and clone access onto attacker-controlled devices, never needing a fresh confirmation from the trusted device. The approve endpoint therefore explicitly rejects scoped callers — pairing approval requires a full (passkey-authenticated) session.

**Why split the QR contents from the claim secret?**
The QR encodes only the pairing ticket id and a short human-readable code (so the user can visually confirm the code on the phone matches the laptop). It deliberately **omits** a `claimSecret` that the initiating laptop received privately at `init` time. The laptop must present that secret to retrieve the issued session token. An attacker who only *observed the QR* therefore cannot race the laptop to claim the token — they lack the out-of-band secret. The token is also delivered exactly once and the ticket flips to `claimed`, so re-polling cannot re-fetch it.

## Algorithm

### Pairing (read-only session issuance)

```
Laptop  → POST /auth/pair/init                → { id, code, claimSecret, expiresAt }
          (no auth; ticket TTL ~5 min; claimSecret returned ONLY here)
Laptop  → GET  /auth/pair/:id/qr.svg          → QR encodes /approve?id=…&code=…
          (claimSecret NEVER in the QR)
Phone   → scans QR, confirms code matches
Phone   → POST /auth/pair/:id/approve {code}  (full session required)
          reject if caller is itself scoped               → 403
          verify 6-digit code (timing-safe)               → 401 on mismatch
          derive deterministic seed for the scoped session
          create auth_binding { clientId: SCOPED, ttl ~8h }
          store scopedToken on the ticket, status=approved
Laptop  → GET  /auth/pair/:id/status  (X-Pair-Claim-Secret header)
          verify claimSecret timing-safe before revealing state
          if approved: return sessionToken ONCE, flip status=claimed
```

### Global scope guard (mounted before the router)

```
on every request:
  if method in {GET, HEAD, OPTIONS}:        pass
  token = bearer or x-session-token
  if no token:                              pass   (public / cookie / code routes)
  binding = resolveSession(token)
  if no binding:                            pass   (route's own auth rejects it)
  cache binding on req                              (avoid a 2nd DB round-trip)
  if binding.clientId == SCOPED:
    if req.path matches an ALLOWED_WRITE pattern:   pass
    else:                                   403 { code: SCOPED_SESSION }
  else:                                     pass
```

### Per-intent elevation (out-of-band)

```
Scoped device → POST /auth/scope-auth/request { action, label }
                 (caller MUST be scoped)            → { id, expiresAt ~2 min }
Trusted device → GET  /auth/scope-auth/pending     (full session)
                 → list of pending {id, action, label}
Trusted device → POST /auth/scope-auth/:id/approve (full session, same wallet)
                 → mints a one-time approvalToken
                 OR  /auth/scope-auth/:id/deny
Scoped device → GET  /auth/scope-auth/:id/status   (scoped token)
                 if approved: deliver approvalToken ONCE, then delete request
```

The elevation token authorizes exactly one action, expires in ~2 minutes, and is delivered a single time. The scoped session never gains standing write authority; it gets a short-lived, single-use permit it must redeem immediately.

## Reference implementation

See [`scoped-session.ts`](./scoped-session.ts) in this directory.

It is framework-agnostic in spirit but written against an Express-style `(req, res, next)` signature. The session store, pairing-ticket store, and elevation-request store are modelled as small interfaces you wire to your real persistence (a DB for sessions/tickets, an in-memory map with TTL cleanup is fine for short-lived elevation requests).

## Usage

```typescript
import express from "express";
import {
  SCOPED_CLIENT_ID,
  makeScopeGuard,
  blockScopedSession,
} from "./scoped-session.js";

const app = express();

// Mount the guard once, before the router. Reads pass; scoped writes are
// rejected unless the path is on the allow-list.
app.use(makeScopeGuard({ resolveSession }));

// Defense-in-depth: routes that bypass the standard bearer header
// (WebSocket upgrades, OIDC code flow) can still call this directly.
app.post("/v1/wallet/export-key", async (req, res) => {
  const binding = await resolveSession(tokenFromRequest(req));
  if (!binding) return res.status(401).json({ error: "Unauthorized" });
  if (blockScopedSession(binding, res)) return;   // 403 if scoped
  // ... sensitive logic
});
```

## Limitations and extensions

- **The allow-list is a manual security boundary.** Every entry must be reviewed. The cost of this design is discipline; the benefit is that forgetting to protect a new route fails *safe* (blocked) rather than *open*.
- **Elevation requests are bound to the wallet, not the device fingerprint.** Approval checks that the trusted session and the request share the same wallet. It does not (here) pin the approval to a specific scoped-device fingerprint — add a device id to the request/approve pair if you want to prevent one scoped device redeeming another's permit.
- **In-memory elevation store does not survive a restart or scale horizontally.** Short TTLs make this acceptable for many deployments; for multi-instance you would move the elevation store to shared storage (e.g. Redis with TTL).
- **The 6-digit code is a possession factor, not a strong secret.** It exists so a caller who knows only the ticket id (but never saw the QR) cannot approve. It is timing-safe compared and the ticket TTL is short; it is not a substitute for the phone's own session authentication.
- **Read-only is enforced by HTTP method.** A route that performs a state change on a `GET` (an anti-pattern) would bypass the guard. Keep all mutations on non-`GET` methods — which you should do anyway.
