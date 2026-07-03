# SIWE Login with a Passkey Floor


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Sign-In With Ethereum (SIWE, EIP-4361) authenticates a user by having them sign a structured message with their wallet key. It is a clean, decentralized login: prove control of an address, get a session. But a SIWE session is a *bearer* credential — once issued, anyone holding the session token can act as the user until it expires. If that token leaks (XSS, a malicious browser extension, a stolen device with an unlocked session), the attacker can drain the wallet.

The wallet signature happens *once*, at login. Every subsequent state-changing action — sending funds, raising a spending limit, signing an arbitrary message — rides on the session token alone, with no fresh proof of presence. That is the gap.

The fix is a **passkey floor**: a hard requirement that every state-changing wallet operation carry a *fresh* WebAuthn assertion, obtained per-action, in addition to a valid session. The session proves "this account is logged in"; the per-action passkey assertion proves "the legitimate human is here, right now, and intends *this specific* operation". A stolen session token is no longer enough — the attacker would also need to defeat the platform authenticator (Face ID / Touch ID / hardware key) on each transaction.

## Design decisions

**Why validate the SIWE message field-by-field instead of just verifying the signature?**
A valid signature over an attacker-chosen message is worthless. The message itself must be pinned to *this* server: the domain line must match the server's canonical domain, the URI host must match, the chain id must equal the expected chain, the version must be `1`, the `Issued At` must be recent (within the nonce TTL) and not in the future, and the embedded address must equal the wallet that signed. Only after every field passes does `ecrecover` get a chance to confirm the signer. Skipping field validation enables cross-domain replay (a signature gathered on a phishing site replayed against the real one) and stale-message replay.

**Why a server-issued single-use nonce?**
The SIWE message embeds a nonce the server minted and stored. At verify time the nonce is looked up, checked unexpired, and *consumed* (deleted). This makes each SIWE login a one-shot: a captured message cannot be replayed because its nonce is already gone. The nonce TTL doubles as the maximum allowed message age.

**Why an explicit client-id allow-list on the bind endpoint?**
Not every client should be allowed to mint a full session directly from a raw SIWE signature. The direct-bind endpoint checks the requesting client id against a short allow-list of first-party clients. Other integrations go through flows with additional checks. This prevents an arbitrary third-party app from turning a signature it collected into a fully-privileged session against your backend.

**Why require a *fresh* passkey assertion per action rather than "passkey at login"?**
A passkey check only at login has the same flaw as SIWE: it authenticates once, then everything rides the session. The floor instead issues a transfer-challenge per operation. The client calls `transfer-challenge`, gets a WebAuthn challenge, prompts the authenticator, and submits the resulting assertion *with* the transfer body. The server verifies the assertion's challenge matches a stored, unconsumed challenge of the right type. Fresh challenge per action ⇒ a replayed assertion fails (the challenge is single-use) and an assertion for a *different* action fails (the challenge *type* is wallet-scoped).

**Why scope the challenge type to the wallet (`wallet-transfer:<wallet>`)?**
The stored challenge carries a type string that includes the wallet address. Verification requires the consumed challenge to match both the value (from the assertion's `clientDataJSON`) *and* the expected type for this wallet. This binds the assertion to the specific account, so an assertion harvested under one wallet cannot be redirected to authorize an action on another.

**Why a 3-minute, single-use challenge TTL?**
Long enough for a human to complete a biometric prompt and submit; short enough that a stolen challenge has almost no window. Single-use means even within the window it cannot be replayed: `consumeChallenge` deletes the row on first read.

**Why also require user verification (`userVerification: "required"`)?**
A passkey assertion with mere user *presence* (a tap) proves possession of the authenticator but not the identity of the person. Requiring user *verification* forces the biometric/PIN gesture, so a thief with an unlocked phone still cannot authorize a transfer without the user's face/finger/PIN.

## Algorithm

### SIWE login

```
GET /auth/nonce → { nonce, expiresAt }      // server mints + stores nonce

client builds EIP-4361 message embedding nonce, signs with wallet key

POST /auth/bind { message, signature, wallet, clientId }:
  if clientId not in ALLOWED_CLIENTS:        403
  err = validateSiweMessage(message, wallet, nonce):
    - first line == "<domain> wants you to sign in with your Ethereum account:"
      and <domain> host == SIWE_EXPECTED_DOMAIN
    - address line == wallet
    - "Version: 1"
    - "Chain ID: <id>" == SIWE_EXPECTED_CHAIN_ID
    - "Nonce: <n>" == server nonce
    - "Issued At" valid ISO8601, age within TTL, not future-dated
    - "URI" host == SIWE_EXPECTED_DOMAIN
  if err:                                     400 err
  recovered = ecrecover(message, signature)
  if recovered != wallet:                     401
  consumeNonce(nonce)                          // single-use
  create session binding { wallet, ttl }
  return { sessionToken }
```

### Passkey floor (per state-changing action)

```
POST /wallet/transfer-challenge   (session + passkeyUserId required):
  options = generateAuthenticationOptions({ userVerification: "required",
                                            allowCredentials: user's creds })
  storeChallenge(options.challenge, "wallet-transfer:"+wallet, passkeyUserId)
  return options                               // TTL 3 min, single-use

POST /wallet/send   (or sign / policy-update — any state change):
  binding = resolveSession(token)
  reject scoped sessions                       // see guide 14
  assertion = verifyWalletAssertion(req, binding, "wallet-transfer:"+wallet):
    require binding.passkeyUserId               // 403 passkey_required
    require body.credential present             // 400 credential_required
    expectedChallenge = JSON(clientDataJSON).challenge
    stored = consumeChallenge(expectedChallenge, "wallet-transfer:"+wallet)
    require stored && stored.userId == passkeyUserId   // 400 mismatch
    require credential.id registered to this user       // 401
    verifyAuthenticationResponse({ expectedChallenge, origin, rpID, pubkey })
    on success: bump signature counter, lastUsedAt
  if !assertion.verified:                       assertion.status / error
  ... perform the transfer
```

The challenge is minted per action, scoped to the wallet, verified against the authenticator's signature, and consumed on use. There is no path to a state change that does not pass through a fresh assertion.

## Reference implementation

See [`siwe-passkey-floor.ts`](./siwe-passkey-floor.ts) in this directory.

External dependencies: `ethers` (SIWE signature recovery) and `@simplewebauthn/server` (`generateAuthenticationOptions`, `verifyAuthenticationResponse`). The nonce store, challenge store, and credential store are modelled as interfaces you wire to your DB.

## Usage

```typescript
import {
  validateSiweMessage,
  verifySiweBind,
  issueTransferChallenge,
  verifyWalletAssertion,
} from "./siwe-passkey-floor.js";

// Login: validate every field, then recover the signer.
const bind = await verifySiweBind({ message, signature, wallet, clientId, nonce }, deps);
if (!bind.ok) return res.status(bind.status).json({ error: bind.error });

// Before a transfer: issue a fresh, wallet-scoped, single-use challenge.
const options = await issueTransferChallenge(binding, deps);

// On the transfer request: require a fresh assertion or reject.
const a = await verifyWalletAssertion(req, binding, `wallet-transfer:${binding.wallet}`, deps);
if (!a.verified) return res.status(a.status).json({ error: a.error });
```

## Limitations and extensions

- **The floor presupposes the account has a passkey.** `verifyWalletAssertion` returns `passkey_required` if the session has no `passkeyUserId`. SIWE-only accounts must enroll a passkey before they can transact; that enrollment is the one-time cost of the floor.
- **Challenge binding is per-wallet, not per-amount.** The assertion proves intent to perform *a* wallet transfer, not a specific amount/recipient. To bind the assertion to the exact transaction, fold the tx hash into the challenge type or the signed extra-data — at the cost of a stricter client flow.
- **Origin/RP id must be pinned.** `verifyAuthenticationResponse` checks `expectedOrigin` and `expectedRPID`. Misconfiguring these (e.g. wildcarding) reopens cross-origin assertion replay. Derive them from server config, not from the request.
- **Counter regression is a clone signal, not enforced here.** The reference bumps the signature counter on success; a *decrease* indicates a cloned authenticator. A hardened deployment rejects non-increasing counters for authenticators that report them.
- **SIWE domain/chain are single-valued.** Multi-domain or multi-chain deployments need the validator to accept a set of allowed domains/chains rather than one constant.
