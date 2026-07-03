# Time-of-Flight Proximity Payment ("Tap to Pay", relay-resistant)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Two people standing next to each other want to exchange value by physically tapping their phones together — the wallet equivalent of a contactless card. The natural transport is a short-range radio: **Web Bluetooth GATT** or **Web NFC (NDEF)**. Both expose an attractive property — they only work over a few centimetres — so it is tempting to treat "the radio connected" as proof that the two devices are in the same place.

That assumption is wrong, and the attack is the classic **relay (wormhole) attack**:

```
  Victim phone  ──BLE──▶  Attacker A  ──Internet──▶  Attacker B  ──BLE──▶  Merchant
```

Attacker A sits next to the victim and forwards every radio message over the Internet to Attacker B, who replays it next to the real merchant terminal far away. To both endpoints the link looks local. Short range does **not** imply proximity once a relay is in the loop, and a payment authorized this way drains the victim while the goods go to the attacker.

The defence that actually works against a relay is **distance bounding via time-of-flight**: measure how long a challenge/response round trip takes. Light and electronics are fast, but an Internet relay adds tens of milliseconds of unavoidable latency. If the round-trip time (RTT) exceeds a tight threshold, a relay must be present — reject the session.

## Design decisions

**Why an RTT threshold of ~50 ms.**
A genuine same-room exchange (BLE characteristic write + read, or one NFC tap) completes in well under 50 ms. Routing the same exchange through a remote relay adds at minimum the Internet round trip between the two attacker nodes — realistically 60–200 ms+. 50 ms sits comfortably above honest latency and below any practical relay, so it cleanly separates the two cases. The threshold is a tunable constant, not a law of physics: tighten it on fast local transports, loosen it slightly if honest tails are getting rejected.

**Why the server times the round trip, not the client.**
A client could lie about its own timestamps. Instead the **server** issues a nonce, stamps the issue time (`tofIssuedAt`), and stamps again when the answer arrives. The RTT it computes is `answeredAt − issuedAt`. The clients never self-report timing; they only prove they received the live nonce and could compute the answer quickly. This keeps the trust anchor server-side.

**Why the answer is `sha256(nonce ‖ wallet)`.**
The response must (a) prove the responder saw *this* nonce — defeating pre-computation and replay of an old session — and (b) bind to *who* is answering. `sha256(tofNonce + wallet)` does both: it is cheap to compute (so it adds negligible honest latency), impossible to precompute (the nonce is fresh and random), and tied to the participant's wallet so one party cannot answer on behalf of the other.

**Why each party is timed independently.**
A bump-pay has two sides (initiator and responder). Each gets its own nonce and its own pair of result columns. The initiator's proximity proof is stored separately from the responder's, so the responder joining later cannot overwrite the initiator's timing, and a final settlement requires that **both** sides independently passed their ToF check.

**Why an explicit `relay_rejected` terminal state.**
When RTT exceeds the threshold (or the answer is wrong), the session is moved to a `relay_rejected` state and stays there. There is no retry-into-success: a session that looked like a relay is burned, forcing a fresh handshake. Fail-closed.

**Why the radio layer is "dumb."**
The Web Bluetooth / Web NFC hooks only move bytes — they exchange session IDs and nonces. They perform **no** authorization themselves. All the security decisions (nonce validity, RTT, who may settle) happen server-side over ordinary authenticated HTTP. The radio is a convenience for discovery and for forcing physical co-location; it is never trusted.

## Algorithm

```
Initiator                         Server                          Responder
---------                         ------                          ---------
init  ───────────────────────────▶ create session
                                   nonce_i, issuedAt_i := now
      ◀──────────────────────────  { sessionId, nonce_i }

(tap / radio exchange shares sessionId + nonces between the two phones)

                                   join  ◀──────────────────────── join(sessionId)
                                   nonce_r, issuedAt_r := now
                                   ──────────────────────────────▶ { nonce_r }

answer_i = sha256(nonce_i ‖ wallet_i)
      ───────────────────────────▶ /tof
                                   rtt_i = now − issuedAt_i
                                   if answer_i != expected → relay_rejected
                                   if rtt_i  > 50ms        → relay_rejected
                                   else store initiator ToF pass

                                   /tof ◀──────────────────────── answer_r = sha256(nonce_r ‖ wallet_r)
                                   rtt_r = now − issuedAt_r
                                   (same checks; store responder ToF pass)

offer    requires initiator ToF passed
confirm  requires BOTH initiator AND responder ToF passed  → settle
```

A wrong answer or an over-threshold RTT on *either* side terminates the whole session as `relay_rejected`.

## Reference implementation

See [`proximity-tof.ts`](./proximity-tof.ts) in this directory.

It models the server-side session machine (the trust anchor) with an in-memory store and Node's `crypto` for the hash — no database or HTTP framework required to study the mechanism. The browser radio transports are described in comments; they are thin byte-movers and intentionally carry no security logic.

Dependencies: Node.js built-in `crypto` only.

## Usage

```typescript
import { TofBroker } from "./proximity-tof.js";

const broker = new TofBroker({ maxRttMs: 50 });

// Initiator opens a session
const { sessionId, nonce: nonceI } = broker.init("wallet-A");

// Responder joins (after the radio tap shares sessionId)
const { nonce: nonceR } = broker.join(sessionId, "wallet-B");

// Each side answers its own live nonce, quickly
broker.answer(sessionId, "wallet-A", sha256(nonceI + "wallet-A"));
broker.answer(sessionId, "wallet-B", sha256(nonceR + "wallet-B"));

// Settlement only succeeds if both ToF checks passed under the threshold
broker.confirm(sessionId);   // → "settled"  (or throws "relay_defense_required")
```

## Limitations and extensions

- **Server-clock RTT measures the whole HTTP path, not pure radio flight time.** This is coarser than hardware distance bounding (which times sub-microsecond radio responses). It is good enough to defeat *Internet* relays — the only practical attack against browser radios — but it cannot detect a relay that is itself co-located and extremely fast. For high-value flows, layer on UWB ranging or a hardware secure element.
- **Clock assumptions.** Because one machine (the server) takes both timestamps, no clock synchronization between the phones is needed — but the server's own clock must be monotonic. Use a monotonic timer source, not wall-clock time that can jump.
- **Threshold tuning is a UX/security trade-off.** Too tight and honest taps on congested networks get rejected; too loose and a fast regional relay slips through. Measure real honest-latency distributions before locking the constant.
- **The hash answer is not a signature.** `sha256(nonce ‖ wallet)` proves liveness and binds the wallet, but it does not authenticate the *device's key*. Proximity (ToF) and authorization (a passkey/WebAuthn assertion at the confirm step) are separate layers — keep both. ToF proves "you are here, now"; the assertion proves "you approve this exact payment."
- **Single-use sessions.** Sessions carry a short TTL and a terminal `relay_rejected` / `settled` state. Never reuse a nonce or revive a rejected session.
