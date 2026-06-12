/**
 * Onion-Layered Multi-Hop Transport
 *
 * A message is wrapped in nested encryption layers, one per relay on a chosen
 * route. Each relay holds a key that decrypts exactly one layer. Peeling that
 * layer reveals only two things: the identity of the *next* hop, and an opaque
 * blob to forward there. No relay learns the message payload, and no relay
 * except the final exit learns the destination. An observer who controls a
 * single hop sees neither where the traffic came from originally nor where it
 * is ultimately going.
 *
 * This is the Tor / mixnet construction reduced to a small embeddable form for
 * agent-to-agent channels. Real deployments use NaCl `box` (X25519 + XSalsa20-
 * Poly1305) so the sender wraps with each relay's *public* key; here we keep the
 * same layering idea but use built-in AES-256-GCM with a per-relay shared key so
 * the file runs on Node built-ins alone. The structure — one authenticated
 * layer per hop, next-hop address in the cleartext-after-peel — is identical.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Relay = {
  id:  string;
  /** 32-byte AES-256 key shared with the sender (stands in for NaCl box keypair). */
  key: Buffer;
};

/** One encrypted layer: AES-256-GCM (iv || tag || ciphertext), all hex. */
export type Layer = {
  iv:  string;
  tag: string;
  ct:  string;
};

export type OnionMessage = {
  /** The relay this envelope must be delivered to first. */
  entryHop: string;
  layer:    Layer;
};

/** What a relay learns after peeling its layer. */
export type Peeled =
  | { final: false; nextHop: string; layer: Layer }
  | { final: true;  payload: Buffer };

// ── Layer crypto ────────────────────────────────────────────────────────────────

function seal(key: Buffer, plaintext: Buffer): Layer {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

function open(key: Buffer, layer: Layer): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(layer.iv, "hex"));
  decipher.setAuthTag(Buffer.from(layer.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(layer.ct, "hex")), decipher.final()]);
}

// The plaintext inside each layer is a small framed structure:
//   { next: <relayId|null>, blob: <base64 of (inner Layer JSON) | (final payload)> }
type Frame = { next: string | null; blob: string };

function encodeFrame(frame: Frame): Buffer {
  return Buffer.from(JSON.stringify(frame), "utf8");
}
function decodeFrame(buf: Buffer): Frame {
  return JSON.parse(buf.toString("utf8")) as Frame;
}

// ── wrapOnion(): build the nested envelope for a route ─────────────────────────

/**
 * Wrap `payload` for delivery along `route`. route[0] is the entry hop; the last
 * relay is the exit that recovers the plaintext. Wrapping proceeds innermost →
 * outermost so the entry hop holds the outermost layer.
 */
export function wrapOnion(payload: Buffer, route: Relay[]): OnionMessage {
  if (route.length === 0) throw new Error("wrapOnion: route must have at least one relay");

  // Innermost layer (for the exit relay): final = true, blob = the payload itself.
  const exit = route[route.length - 1];
  let layer  = seal(exit.key, encodeFrame({ next: null, blob: payload.toString("base64") }));
  let nextHop = exit.id;

  // Wrap outward: each relay's layer carries the *next* hop id + the inner layer.
  for (let i = route.length - 2; i >= 0; i--) {
    const relay = route[i];
    const frame: Frame = { next: nextHop, blob: Buffer.from(JSON.stringify(layer), "utf8").toString("base64") };
    layer   = seal(relay.key, encodeFrame(frame));
    nextHop = relay.id;
  }

  return { entryHop: route[0].id, layer };
}

// ── peel(): a single relay removes one layer ───────────────────────────────────

/**
 * A relay peels its layer with its own key. It learns the next hop (or that it
 * is the exit and recovers the payload). It never sees any other layer's key.
 */
export function peel(layer: Layer, relay: Relay): Peeled {
  const frame = decodeFrame(open(relay.key, layer));
  if (frame.next === null) {
    return { final: true, payload: Buffer.from(frame.blob, "base64") };
  }
  const innerLayer = JSON.parse(Buffer.from(frame.blob, "base64").toString("utf8")) as Layer;
  return { final: false, nextHop: frame.next, layer: innerLayer };
}

// ── route(): simulate forwarding the envelope across the network ───────────────

/**
 * Drive an OnionMessage through a relay directory hop by hop, returning the
 * recovered payload and the observed path. Each relay only ever sees its own
 * next hop — captured here as the `observed` trace for illustration.
 */
export function route(
  msg: OnionMessage,
  directory: Map<string, Relay>,
): { payload: Buffer; path: string[]; observed: Array<{ at: string; sees: string }> } {
  const path: string[]   = [];
  const observed: Array<{ at: string; sees: string }> = [];
  let hopId: string | null = msg.entryHop;
  let layer = msg.layer;

  while (hopId !== null) {
    const relay = directory.get(hopId);
    if (!relay) throw new Error(`route: unknown relay ${hopId}`);
    path.push(hopId);

    const result = peel(layer, relay);
    if (result.final) {
      observed.push({ at: hopId, sees: "EXIT → recovers payload for destination" });
      return { payload: result.payload, path, observed };
    }
    observed.push({ at: hopId, sees: `forward → ${result.nextHop} (payload opaque)` });
    layer = result.layer;
    hopId = result.nextHop;
  }
  throw new Error("route: circuit ended without an exit layer");
}

// ── Demo ────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  // Build a 3-hop circuit. In production each key is a NaCl box keypair; here
  // each relay shares a random AES-256 key with the sender.
  const mkRelay = (id: string): Relay => ({ id, key: crypto.randomBytes(32) });
  const relayA = mkRelay("relay-A");
  const relayB = mkRelay("relay-B");
  const relayC = mkRelay("relay-C"); // exit

  const directory = new Map<string, Relay>([
    [relayA.id, relayA],
    [relayB.id, relayB],
    [relayC.id, relayC],
  ]);

  const secret = Buffer.from("transfer 5 units to account 0xBEEF — confidential");
  const onion  = wrapOnion(secret, [relayA, relayB, relayC]);

  console.log("entry hop (all an observer at the start sees):", onion.entryHop);
  console.log("outer ciphertext bytes:", Buffer.from(onion.layer.ct, "hex").length, "(opaque)\n");

  // What relay A learns on its own (only the next hop, never the payload):
  const atA = peel(onion.layer, relayA);
  console.log("relay-A peels →", atA.final ? "EXIT" : `next hop: ${atA.nextHop}`);

  // Full simulated routing:
  const result = route(onion, directory);
  console.log("\nper-hop visibility:");
  for (const o of result.observed) console.log(`  ${o.at}: ${o.sees}`);
  console.log("\npath:", result.path.join(" → "));
  console.log("recovered payload:", JSON.stringify(result.payload.toString()));
  console.log("matches original:", result.payload.equals(secret));

  // A wrong key cannot peel a layer (authenticated encryption fails closed).
  try {
    peel(onion.layer, { id: "relay-A", key: crypto.randomBytes(32) });
    console.log("\nwrong-key peel: UNEXPECTEDLY SUCCEEDED");
  } catch {
    console.log("\nwrong-key peel: rejected (GCM auth failure) — as expected");
  }
}
