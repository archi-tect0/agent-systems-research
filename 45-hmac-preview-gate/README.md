# Stateless HMAC Preview-Gate Tokens

## Problem

A site under development is often put behind a single shared password — a "preview gate" — so that only people who know the phrase can see it. The simplest implementation prompts for the password, checks it server-side, and then needs some way to remember that this client already passed, so the prompt does not reappear on every page load.

The textbook answer is server-side sessions: store a random session id, hand it to the client, look it up on each request. But that introduces a session store that must be provisioned, persisted, expired, and synced across server instances — heavy machinery for a gate whose only job is "did you know the shared phrase?". It also makes invalidation awkward: when the password is rotated, every existing session has to be hunted down and purged.

What we want is a token that is **self-validating and stateless**: the server can confirm the token without storing anything, and rotating the password should invalidate every outstanding token automatically. An HMAC of the password, keyed on a server secret, achieves exactly this.

## Design decisions

**Why HMAC-SHA256 of the password rather than a random session id?**
A random session id carries no information, so the server must store the mapping from id to "passed the gate". An HMAC of the password carries the proof inside itself: `token = HMAC(secret, "gate:" + password)` can only be produced by someone who knew the password and can only be verified by someone who holds the secret. The server recomputes the expected HMAC on demand and compares — no lookup table, no stored sessions.

**Why does rotating the password invalidate every token for free?**
Verification recomputes the expected token from the *current* password. The moment the operator changes the password, the expected HMAC changes, so every token minted under the old password fails the comparison. There is nothing to revoke and no session list to walk: invalidation is a side effect of the token being a pure function of the password. This is the whole point of binding the token to the password rather than to a random id.

**Why a domain-prefix (`"gate:"`) on the HMAC input?**
The server secret may be reused for other HMAC purposes. Prefixing the signed message with a fixed context string domain-separates this use: a `"gate:"` token can never collide with an HMAC computed for some other feature over the same secret, even if that feature happens to sign the same password value. It is cheap insurance against cross-protocol token confusion.

**Why `crypto.timingSafeEqual` instead of `===`?**
String equality and `Buffer.equals` typically short-circuit on the first differing byte, so the time they take leaks how many leading bytes matched. An attacker who can measure that timing can recover the expected token byte by byte. `timingSafeEqual` compares in constant time regardless of where the first difference is, removing that side channel. The lengths are checked first because `timingSafeEqual` throws on unequal-length buffers — and that length check is not itself a meaningful leak since the token length is fixed and public.

**Why recompute the expected token on every verify instead of caching it?**
Recomputing keeps the verifier stateless and always consistent with the current password. An HMAC-SHA256 over a short string is microseconds of work, so there is no performance reason to cache, and caching would reintroduce the very invalidation problem the design exists to avoid.

**Why is this a gate, not authentication?**
The token proves knowledge of one shared phrase, not the identity of a specific user. Everyone who passes the gate holds an identical token. That is appropriate for "keep the public out of a preview build" and inappropriate for anything that needs per-user accounts, authorization, or accountability.

## Algorithm

```
Issue (client knew the password):
  token = HMAC-SHA256(key = secret, msg = "gate:" + password)  encoded as hex
  -> send token to client; client stores it (e.g. localStorage)

Verify (on later requests, no stored session):
  if token is missing/empty: return false
  expected = HMAC-SHA256(secret, "gate:" + currentPassword)  as hex
  a = bytes(token, hex); b = bytes(expected, hex)
  if length(a) != length(b): return false        // also guards timingSafeEqual
  return timingSafeEqual(a, b)                     // constant-time

Rotate:
  operator changes currentPassword
  -> expected HMAC changes
  -> every previously issued token now fails verify, with nothing to purge
```

## Reference implementation

See [`hmac-preview-gate.ts`](./hmac-preview-gate.ts) in this directory. It uses only the Node `crypto` built-in — no external dependencies.

## Usage

```typescript
import { issueGateToken, verifyGateToken } from "./hmac-preview-gate.js";

const secret = process.env.SESSION_SECRET!; // server-held, never sent to client
let password = process.env.GATE_PASSWORD!;  // the shared preview phrase

// On successful password entry, issue a token the client stores.
const token = issueGateToken(secret, password);

// On later loads, re-validate without any session store.
if (verifyGateToken(secret, password, token)) {
  // client already passed the gate
}

// Rotating the password invalidates every outstanding token automatically.
password = "a-new-shared-phrase";
verifyGateToken(secret, password, token); // false — no purge needed
```

## Limitations and extensions

- **Shared-secret gate, not user auth.** Everyone who passes holds the same token. There is no per-user identity, authorization, or revocation of an individual client short of rotating the password for all.
- **No expiry.** A token stays valid until the password changes. To add a lifetime, fold a coarse time bucket into the signed message (`"gate:" + password + ":" + epochDay`) and accept the current plus previous bucket.
- **Token equals proof of password knowledge.** Anyone who obtains a client's stored token can reuse it until rotation. Serve only over TLS and treat the token as a bearer credential.
- **Secret compromise is fatal.** If the server secret leaks, anyone can mint valid tokens for any password. Keep it server-side and rotate it (which also invalidates all tokens) if exposure is suspected.
- **Offline brute force.** Because the token is a deterministic HMAC of the password, an attacker with a token and the secret could brute-force a weak password offline. The secret normally prevents this, but choose a high-entropy password as defense in depth.
