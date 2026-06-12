# Universal Controller Overlay + Viewport Sync

## Problem

A user is running a heavy GPU/3D session on a TV or laptop, but the device with the best input surface is in their hand — their phone. We want to turn the phone into a game controller, touchpad, and keyboard for the big-screen session, and we want it to *just work* with no QR scan, no pairing code, no manual handshake.

Three sub-problems fall out of this:

**1. Auto-pairing without a code exchange.**
The phone and the TV both belong to the *same user*. We want them to find each other's channel deterministically, so the moment both are authenticated they are already on the same wire.

**2. Authenticating a Server-Sent Events stream from a browser.**
The big-screen side subscribes to a low-latency event stream via `EventSource`. But browser `EventSource` *cannot send custom headers* — so there is no clean way to attach an `Authorization: Bearer` token. Putting a long-lived token in the stream URL is dangerous: URLs leak into browser history, proxy logs, reverse-proxy access logs, screenshots, and extensions.

**3. The agent rendering the 3D UI doesn't know the real screen.**
An agent sizing and placing content into a 3D scene needs to know the actual render area, device pixel ratio, orientation, and the *safe* rectangle (after notches, status bars, and dock insets). Otherwise it places a button under a camera cutout or off the bottom of a phone.

This guide covers a relay design that solves all three: a deterministic HMAC channel id for zero-config pairing, a short-lived single-use SSE ticket for header-less stream auth, and a per-session viewport report so the renderer sizes UI to the real screen.

## Design decisions

**Deterministic channel id = HMAC(server_secret, wallet).**
Instead of generating a random channel and exchanging it, derive the channel id as `HMAC-SHA256(SERVER_SECRET, wallet).slice(0, 24)`. Both the phone and the TV compute the *same* id because they authenticate as the same account — so they auto-pair with no code. Because the input is keyed-hashed with a server secret, a third party cannot derive another user's channel id from their public wallet address.

**Header-less SSE auth via a one-time ticket.**
`EventSource` can't send headers, so the flow is:
1. Client `POST /sse-ticket` with the session token *in the request body / header* (never the URL). Server mints a random 32-byte ticket valid for 30 seconds and stores `{ wallet, expiresAt }`.
2. Client opens the stream with `?ticket=<ticket>`.
3. Server validates the ticket, **deletes it immediately (single-use)**, confirms `channelId(wallet) === :id`, and only then upgrades to the event stream.

The long-lived bearer never touches a URL. The short-lived ticket that *does* touch the URL is single-use and dead in 30 seconds, so even if it leaks into a log it is worthless.

**Compact event packets for latency.**
Input events use single-character type tags (`j`=left stick, `r`=right stick, `btn`=button, `c`=cursor delta, `sc`=scroll, `k`=key, `p`=ping). The phone batches events and POSTs them; the server fan-outs each to all SSE subscribers immediately. Batches are capped (e.g. 32 events) to bound per-request work.

**In-memory channel registry with GC.**
Channels live in process memory — they are session-lifetime ephemera, not durable data. A heartbeat tick every ~20 s writes an SSE comment to keep connections warm and garbage-collects channels that have no subscribers and no recent input.

**Inline agent-approval requests over the same channel.**
A limited (scoped) device can ask the full-session phone to approve a sensitive action *inline in the controller overlay* — reusing the already-paired channel rather than standing up a second auth path. The scoped side `POST`s an `agent-request`; the phone polls, approves/denies; the scoped side polls for the outcome. Requests carry a short TTL (~2 min) and are one-shot.

**Role asymmetry is enforced.**
Only a *full* session (the phone) may respond to agent requests; only a *scoped* session may create them. Scoped sessions cannot view the pending-request list. This prevents a limited device from approving its own elevation.

**Viewport sync is a separate, tiny per-wallet store.**
The browser measures its real render area on boot and on every resize, then `POST`s `{ viewport, safeInsets, safeRect }`. The server keeps the latest report per wallet in memory; the agent reads it per-turn and injects a compact viewport block into its context so it sizes content to the actual screen — including the safe rectangle after notches and docks.

## Algorithm

```
channelId(wallet) = HMAC_SHA256(SERVER_SECRET, lowercase(wallet))[0:24]

Pair (both sides):
  POST /pair  (auth: session token in header)
    ch = getOrCreate(channelId(wallet))
    if full session: ch.phoneAt = now
    return { controllerId: ch.id }

SSE auth (big-screen side):
  POST /sse-ticket (token in header)  → ticket = random(32B); tickets[ticket]={wallet, +30s}
  GET  /:id/stream?ticket=...
    entry = tickets[ticket]; reject if missing/expired
    delete tickets[ticket]            // single use
    reject if channelId(entry.wallet) != id
    upgrade to event-stream; add res to ch.clients

Input (phone side):
  POST /:id/input  { events:[...] }   (auth: session token in header)
    reject if channelId(wallet) != id
    for ev in events[0:32]: for c in ch.clients: c.write(`event: ctrl\ndata: ${ev}`)

Viewport (renderer):
  POST /session/viewport { viewport:{w,h,dpr,...}, safeInsets, safeRect }
    store[lowercase(wallet)] = {...}
  getViewportForWallet(wallet) → latest report (read per-turn by the agent)
```

## Reference implementation

See [`controller-overlay.ts`](./controller-overlay.ts) in this directory. It models the channel registry, deterministic HMAC channel id, the single-use SSE ticket store, compact event fan-out, the inline agent-approval request flow with role enforcement, and the per-wallet viewport store — all in memory, framework-agnostic (a tiny `Subscriber` interface stands in for an HTTP response stream).

## Usage

```typescript
import { ControllerHub } from "./controller-overlay.js";

const hub = new ControllerHub("server-secret");

// Both devices pair — same wallet → same channel, no code exchange
const phone = hub.pair("0xWALLET", "full");
const tv    = hub.pair("0xWALLET", "scoped");
console.log(phone.controllerId === tv.controllerId); // true

// TV subscribes via a single-use SSE ticket
const ticket = hub.issueSseTicket("0xWALLET");
hub.subscribe(tv.controllerId, ticket, {
  write: (line) => process.stdout.write(line),
});

// Phone sends batched input — fans out to the TV immediately
hub.input("0xWALLET", phone.controllerId, [{ t: "j", x: 0.5, y: -0.2 }, { t: "btn", b: "A", p: 1 }]);

// Renderer reports its real viewport; agent reads it per-turn
hub.reportViewport("0xWALLET", { width: 1920, height: 1080, dpr: 1, deviceClass: "tv" });
console.log(hub.getViewport("0xWALLET"));
```

## Limitations and extensions

- **In-memory only.** Channels, tickets, and viewports live in process memory and are lost on restart — acceptable because they are session-lifetime ephemera and re-establish on reconnect. For multi-instance deployments behind a load balancer, you need sticky sessions or a shared pub/sub (Redis) so the phone's input reaches the instance holding the TV's stream.
- **SSE is one-directional.** Input flows phone→server→TV over SSE plus a POST channel. For true bidirectional low-latency you can swap SSE for WebSocket, but the ticket-auth pattern (POST to mint, single-use token in the URL) still applies.
- **No input authorization beyond channel ownership.** Any full session on the wallet can drive the channel. If you need finer control (e.g. only one active controller), add a lease.
- **Viewport trust.** The viewport report is self-declared by the client; treat it as a layout hint, not a security boundary.
