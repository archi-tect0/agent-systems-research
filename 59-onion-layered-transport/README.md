# Onion-Layered Multi-Hop Transport

## Problem

When two parties communicate through a network of relays, each relay is a potential observer. A naive relay sees the full message, the original sender, and the final destination. Even if the payload is encrypted end to end, the relay still learns the metadata — who is talking to whom — which is often as sensitive as the content itself.

The goal is a transport where no single relay learns more than it strictly needs to do its job: forward the traffic one step closer to the destination. An intermediate relay should learn only the identity of the *next* hop. It should not learn the message payload, and it should not learn the final destination. An adversary who controls one relay should be unable to determine either end of the conversation.

This is the onion-routing / mixnet construction, reduced to a small embeddable form suitable for agent-to-agent channels. The message is wrapped in nested encryption layers, one per relay on a chosen route. Each relay holds a key that decrypts exactly one layer; peeling that layer reveals the next hop and an opaque blob to forward there, and nothing else.

## Design decisions

**Why nested layers, one per hop?**
Wrapping proceeds innermost first: the layer for the exit relay is sealed first, then each preceding relay's layer is sealed around it. The entry relay therefore holds the outermost layer. Each relay can open only its own layer, which contains the next hop id plus the still-sealed inner layers. Because a relay cannot open layers it has no key for, it cannot see past the next hop.

**Why hide the destination from every relay except the exit?**
Only the innermost layer (the exit relay's) is marked `final` and carries the actual payload. Every other layer carries `{ next: <relayId>, blob: <inner layer> }`. An intermediate relay learns the next relay id but never the destination or the content, so controlling a middle hop reveals neither end of the circuit.

**Why authenticated encryption per layer?**
Each layer is sealed with AES-256-GCM, which provides both confidentiality and integrity. A relay using the wrong key — or any tampering with a layer's ciphertext — fails the GCM authentication check and the peel is rejected. The transport fails closed: a corrupted or misrouted layer cannot be silently decrypted into garbage.

**Why AES-256-GCM here when production uses public-key boxing?**
A real deployment uses NaCl `box` (X25519 + XSalsa20-Poly1305): the sender wraps each layer with the relay's *public* key, so no shared secret needs to be pre-distributed. The reference implementation keeps the identical layering structure — one authenticated layer per hop, next-hop address in the cleartext revealed only after a peel — but uses built-in AES-256-GCM with a per-relay shared key so the whole file runs on Node built-ins alone. The structural idea being demonstrated is unchanged; only the key-agreement step differs.

**Why a small JSON frame inside each layer?**
The plaintext inside each layer is a framed structure `{ next, blob }`: `next` is the next relay id (or `null` at the exit), and `blob` is base64 of either the inner layer JSON or, at the exit, the final payload. A uniform frame lets the same `peel` routine handle both intermediate and exit hops without a separate format.

## Algorithm

```
wrapOnion(payload, route):                 // route[0] = entry, route[last] = exit
  exit  = route[last]
  layer = seal(exit.key, frame{ next: null, blob: base64(payload) })   // innermost
  nextHop = exit.id
  for i = route.length-2 down to 0:
    relay = route[i]
    frame = { next: nextHop, blob: base64(JSON(layer)) }
    layer = seal(relay.key, frame)         // wrap one layer outward
    nextHop = relay.id
  return { entryHop: route[0].id, layer }  // outermost layer for the entry relay

peel(layer, relay):                        // a single relay removes one layer
  frame = decodeFrame(open(relay.key, layer))   // GCM auth — fails closed
  if frame.next == null:
    return { final: true, payload: base64decode(frame.blob) }
  innerLayer = JSON(base64decode(frame.blob))
  return { final: false, nextHop: frame.next, layer: innerLayer }

route(msg, directory):                      // simulate hop-by-hop forwarding
  hopId = msg.entryHop; layer = msg.layer
  loop:
    relay  = directory[hopId]
    result = peel(layer, relay)
    if result.final: return result.payload  // exit recovers payload
    layer = result.layer; hopId = result.nextHop   // each relay sees only next hop

seal(key, plaintext) = AES-256-GCM(key, randomIV) -> { iv, tag, ct }
open(key, layer)     = AES-256-GCM-decrypt; throws on auth failure
```

## Reference implementation

See [`onion-layered-transport.ts`](./onion-layered-transport.ts) in this directory. It runs on Node.js built-ins only (the `crypto` module, using AES-256-GCM). A production transport would substitute NaCl `box` for the per-layer seal so wrapping uses each relay's public key; the layering structure is identical.

## Usage

```typescript
import crypto from "crypto";
import { wrapOnion, peel, route, type Relay } from "./onion-layered-transport.js";

// Build a 3-hop circuit; each relay shares a 32-byte key with the sender.
const mkRelay = (id: string): Relay => ({ id, key: crypto.randomBytes(32) });
const relayA = mkRelay("relay-A");
const relayB = mkRelay("relay-B");
const relayC = mkRelay("relay-C"); // exit

const directory = new Map<string, Relay>([
  [relayA.id, relayA],
  [relayB.id, relayB],
  [relayC.id, relayC],
]);

const secret = Buffer.from("transfer confidential payload");
const onion = wrapOnion(secret, [relayA, relayB, relayC]);

// An observer at the start only sees the entry hop:
console.log(onion.entryHop);

// One relay peels its own layer — it learns only the next hop:
const atA = peel(onion.layer, relayA);
console.log(atA.final ? "EXIT" : atA.nextHop);

// Drive the envelope through the directory hop by hop:
const { payload, path, observed } = route(onion, directory);
console.log(path.join(" -> "));
console.log(payload.equals(secret)); // true
```

## Limitations and extensions

- **No mixing or padding.** This demonstrates layered encryption only. It does not add cover traffic, timing jitter, or fixed-size padding, so a global observer correlating timing and packet sizes could still link hops. A production mixnet adds these defenses.
- **Pre-shared keys vs. public-key boxing.** The reference uses a per-relay shared key; deriving and distributing those keys is out of scope. The production design uses NaCl `box` with relay public keys, removing the pre-shared-key requirement.
- **Route selection is the caller's responsibility.** The transport wraps whatever route it is given. Choosing diverse, non-colluding relays and a sensible hop count (production deployments bound this, e.g. 2–5 hops) is a separate concern.
- **No reply path.** This carries a one-way payload. Bidirectional communication requires either a separate return circuit or a reply block embedded by the sender.
- **Envelope size grows with hops.** Each layer adds an IV, an auth tag, and framing overhead, so envelope size scales with route length. Long routes trade overhead for anonymity.
