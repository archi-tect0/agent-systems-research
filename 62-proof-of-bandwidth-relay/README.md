# Proof-of-Bandwidth Relay Accounting


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A relay node earns its keep by forwarding traffic between peers that cannot
reach each other directly. If you want to *pay* relays for that work — or just
rank them, or rate-limit by contribution — you need to measure how much useful
bandwidth each one actually supplied. The naive metric, "bytes received on the
socket," is trivially gamed: a node can open a connection and spray keep-alives,
garbage frames, or frames addressed to nobody, and inflate its counter without
ever helping a real peer. That is a Sybil/inflation attack at the transport
layer.

The honest metric is narrower: credit a relay only for **valid payload bytes
that were actually forwarded to at least one other connected peer.** Ingress
that is malformed, that is a protocol keep-alive, or that has no live recipient
represents no delivered value and must earn nothing. The accounting also has to
be bounded — a busy relay cannot keep an unbounded log of every byte forever —
so "recent throughput" is computed over a short sliding window.

A second, related problem sits at connection setup. Clients upgrade an
authenticated HTTP session to a long-lived transport slot (a WebSocket, say).
The obvious way to carry the session credential into the upgrade is to put it in
the URL — and that is exactly wrong, because URLs are captured by browser
history, proxy access logs, reverse-proxy logs, screenshots, and extensions. The
credential leaks. The fix is a short-lived, single-use ticket: the already
authenticated client asks for a ticket, presents the opaque ticket id at upgrade
time, and the server resolves it back to the real session context server-side.

## Design decisions

**Why credit only forwarded, valid payloads?**
Value is *delivery*, not *receipt*. A frame that fails validation was never a
real payload; a frame with zero recipients helped no one. Gating credit on
`kind == relay && valid && recipients >= 1` ties the reward to the only thing a
relay is paid to do — move a good payload to a peer — and makes the cheap attacks
(keep-alive floods, malformed spam, self-addressed frames) earn exactly zero.

**Why a sliding window for the rate?**
Throughput is a recent-history question ("how much is this relay carrying *now*"),
not a lifetime total. A fixed-width window (e.g. 10s) of timestamped samples lets
`bytesPerSec()` reflect current contribution and lets the structure prune itself:
samples older than the window are dropped on read, so memory stays bounded
regardless of how long the relay runs. The cumulative `consume()` counter is kept
separately for settlement, since that *is* a "total since last interval" question.

**Why separate `account()` from `consume()`?**
`account()` runs on the hot path, once per frame, and only ever increments. The
settlement layer calls `consume()` on its own schedule to atomically read-and-
reset the credited total for the interval. Splitting them keeps the hot path
branch-cheap and makes settlement a single drain operation with no risk of
double-counting.

**Why single-use, short-lived tickets instead of reusing the session token?**
Putting the session bearer in the upgrade URL leaks it into logs forever. A
ticket is an indirection: it is opaque (random 256-bit id), it expires in ~60s,
and it is consumed on first redemption. Even if the ticket id is captured from a
URL, it is useless seconds later and useless after one use. The valuable secret —
the session context — never leaves the server.

**Why delete the ticket entry on every redeem, success or fail?**
`redeem()` removes the entry before checking validity. That makes replay
structurally impossible: a second redemption finds nothing. Expiry and the
`used` flag are checked after removal purely to return `null` for the
already-consumed/expired cases; the entry is gone either way.

## Algorithm

```
account(frame):                      # hot path, per frame
  creditable = frame.kind == "relay"
               and frame.valid
               and frame.recipients >= 1
               and frame.bytes > 0
  if not creditable: return 0
  accumulated += frame.bytes
  outSamples.push({ ts: now(), bytes: frame.bytes })
  return frame.bytes

consume():                           # settlement drain
  n = accumulated; accumulated = 0; return n

bytesPerSec():                       # sliding-window rate
  drop samples with ts < now() - windowMs
  return sum(remaining.bytes) / (windowMs / 1000)

issue(ctx):                          # ticket mint
  id = random 32 bytes (hex)
  tickets[id] = { ...ctx, expiresAt: now()+ttl, used:false }
  return id                          # only the opaque id goes to the client

redeem(id):                          # single-use
  t = tickets[id]; delete tickets[id]   # remove FIRST -> no replay
  if t is null or t.used or t.expiresAt <= now(): return null
  return { sessionId, subject }
```

## Reference implementation

See [`relay-accounting.ts`](./relay-accounting.ts) in this directory. It runs on
Node.js built-ins only; the single external touch point is `crypto.randomBytes`
for ticket ids, which is part of the standard `crypto` module. The demo uses an
injectable clock so the sliding window and ticket expiry are deterministic.

## Usage

```typescript
import { RelayAccount, TicketStore } from "./relay-accounting.js";

// Per-session byte accounting (10s rate window):
const acct = new RelayAccount("session-A", 10_000);
acct.account({ kind: "relay", bytes: 1200, valid: true, recipients: 2 }); // -> 1200
acct.account({ kind: "keepalive", bytes: 8, valid: true, recipients: 5 }); // -> 0
const owed = acct.consume();           // confirmed relay bytes this interval
const rate = acct.bytesPerSec();       // recent throughput

// Leak-free slot upgrade via single-use tickets:
const tickets = new TicketStore(60_000);
const id = tickets.issue({ sessionId: "session-A", subject: "peer-7" });
// client opens the transport slot presenting `id` only:
const ctx = tickets.redeem(id);        // { sessionId, subject } once, then null
```

## Limitations and extensions

- **`recipients` and `valid` are inputs, not verified here.** This module trusts
  the transport layer to report whether a frame decoded cleanly and how many live
  peers it reached. In a real node those are produced by the forwarding loop; the
  accounting only enforces the *policy* over them.
- **In-process state.** Both stores are in-memory. For a relay fleet, settle
  `consume()` totals to a durable ledger per interval and replicate tickets
  through a shared short-TTL store (or accept that tickets are node-local, which
  is fine when the upgrade hits the same node that issued the ticket).
- **No cryptographic proof of delivery.** Credit rests on the relay's own report
  that it forwarded the bytes. To make it adversarially verifiable, pair this
  with signed delivery receipts from recipients (a "proof of relay" the payer can
  check), which this accounting layer would then gate on instead of `recipients`.
- **Window vs. burst.** A single sliding window smooths bursts. If you need to
  distinguish sustained throughput from spikes, keep two windows (short + long)
  and report both.
