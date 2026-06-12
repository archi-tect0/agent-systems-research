/**
 * Batched Intent Collapse with Merkle Fan-Out
 *
 * When many independent requests share the same heavy context (a system prompt,
 * a tool schema, a world-state snapshot, a compression dictionary), resolving
 * them one at a time re-sends that context N times. Most of the input tokens in
 * a busy agent runtime are this duplicated preamble.
 *
 * "Collapse" deduplicates the shared context into a single dense call:
 *   1. The shared context is materialized once and hashed.
 *   2. Each intent is reduced to its *delta* (only what differs) and assigned a
 *      virtual channel id (1..N) so results can be demultiplexed afterwards.
 *   3. A Merkle root is computed over [sharedContextHash, ...intentHashes]. This
 *      anchor lets anyone later verify exactly which intents were in the batch
 *      and that none were altered — without re-sending their contents.
 *   4. One combined payload is produced for a single model call.
 *   5. Results are fanned back out to each caller by virtual channel id; the
 *      result set carries its own Merkle root for an auditable response trail.
 *
 * This file implements the collapse → combined-payload → fan-out pipeline with a
 * stubbed resolver in the demo (no network). Dependencies: built-in "crypto".
 */

import crypto from "crypto";

// ── Canonical JSON + hashing ──────────────────────────────────────────────────

/** Deterministic stringify with recursively sorted keys. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj  = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Merkle root over ordered leaf hashes; duplicates the last leaf on odd levels. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex("empty");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = level[i + 1] ?? left; // odd count → duplicate last
      next.push(sha256hex(left + right));
    }
    level = next;
  }
  return level[0];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Intent = {
  intentId: string;
  /** Per-intent delta: only what differs from the shared context. */
  delta:    Record<string, unknown>;
};

export type ChanneledIntent = Intent & { virtualChannelId: number; leafHash: string };

export type MacroBlock = {
  blockId:           string;
  sharedContext:     Record<string, unknown>;
  sharedContextHash: string;
  intents:           ChanneledIntent[];
  merkleRoot:        string;
};

export type CombinedPayload = {
  blockId:       string;
  merkleRoot:    string;
  sharedContext: Record<string, unknown>;
  tasks:         Array<{ intentId: string; virtualChannelId: number; delta: Record<string, unknown> }>;
};

export type IntentResult = {
  intentId:         string;
  virtualChannelId: number;
  payload:          unknown;
  outputHash:       string;
};

export type ResultBlock = {
  blockId:          string;
  results:          IntentResult[];
  resultMerkleRoot: string;
};

// ── collapse(): N intents + shared context → one MacroBlock ────────────────────

export function collapse(intents: Intent[], sharedContext: Record<string, unknown>): MacroBlock {
  if (intents.length === 0) throw new Error("collapse: at least one intent required");

  const sharedContextHash = sha256hex(canonical(sharedContext));

  const channeled: ChanneledIntent[] = intents.map((intent, i) => {
    const virtualChannelId = i + 1; // 0 reserved for meta/system
    const leafHash = sha256hex(canonical({ intentId: intent.intentId, virtualChannelId, delta: intent.delta }));
    return { ...intent, virtualChannelId, leafHash };
  });

  const root    = merkleRoot([sharedContextHash, ...channeled.map(c => c.leafHash)]);
  const blockId = sha256hex(root + sharedContextHash).slice(0, 16);

  return { blockId, sharedContext, sharedContextHash, intents: channeled, merkleRoot: root };
}

// ── buildCombinedPayload(): the single dense call (context sent ONCE) ──────────

export function buildCombinedPayload(block: MacroBlock): CombinedPayload {
  return {
    blockId:       block.blockId,
    merkleRoot:    block.merkleRoot,
    sharedContext: block.sharedContext,
    tasks:         block.intents.map(i => ({
      intentId:         i.intentId,
      virtualChannelId: i.virtualChannelId,
      delta:            i.delta,
    })),
  };
}

/** A resolver takes the combined payload and returns one payload per channel. */
export type BatchResolver = (
  payload: CombinedPayload,
) => Promise<Array<{ virtualChannelId: number; payload: unknown }>>;

// ── fanOut(): resolve once, demultiplex results by virtual channel id ──────────

export async function fanOut(block: MacroBlock, resolve: BatchResolver): Promise<ResultBlock> {
  const combined = buildCombinedPayload(block);
  const raw      = await resolve(combined);

  const byChannel = new Map<number, unknown>();
  for (const r of raw) byChannel.set(r.virtualChannelId, r.payload);

  const results: IntentResult[] = block.intents.map((intent) => {
    const payload    = byChannel.get(intent.virtualChannelId) ?? null;
    const outputHash = sha256hex(canonical(payload));
    return { intentId: intent.intentId, virtualChannelId: intent.virtualChannelId, payload, outputHash };
  });

  return {
    blockId:          block.blockId,
    results,
    resultMerkleRoot: merkleRoot(results.map(r => r.outputHash)),
  };
}

/** Verify a block's Merkle root from its parts (tamper detection). */
export function verifyBlock(block: MacroBlock): boolean {
  const recomputed = merkleRoot([block.sharedContextHash, ...block.intents.map(i => i.leafHash)]);
  return recomputed === block.merkleRoot;
}

// ── Demo ────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  void (async () => {
    // Heavy context shared across all intents — sent ONCE after collapse.
    const sharedContext = {
      systemPrompt: "You are a careful assistant. ".repeat(20),
      toolSchemas:  ["vault_read", "web_search", "send_message"],
      worldState:   { city: "Lisbon", tz: "WET" },
    };

    const intents: Intent[] = [
      { intentId: "i-weather",  delta: { task: "current weather" } },
      { intentId: "i-headline", delta: { task: "top tech headline" } },
      { intentId: "i-fx",       delta: { task: "EUR/USD rate" } },
    ];

    const block = collapse(intents, sharedContext);
    console.log("blockId:        ", block.blockId);
    console.log("merkleRoot:     ", block.merkleRoot);
    console.log("verifyBlock:    ", verifyBlock(block));

    const combined = buildCombinedPayload(block);
    const naiveBytes    = intents.length * canonical(sharedContext).length;
    const collapsedBytes = canonical(combined).length;
    console.log(`\nshared-context bytes sent — naive (×${intents.length}): ${naiveBytes}, collapsed: ${collapsedBytes}`);
    console.log("channel map:", combined.tasks.map(t => `${t.virtualChannelId}→${t.intentId}`).join("  "));

    // Stub resolver: pretends a single model call produced one answer per channel.
    const resolve: BatchResolver = async (p) => {
      await new Promise(r => setTimeout(r, 10));
      return p.tasks.map(t => ({
        virtualChannelId: t.virtualChannelId,
        payload:          { answer: `result for ${(t.delta as { task: string }).task}` },
      }));
    };

    const resultBlock = await fanOut(block, resolve);
    console.log("\nfan-out results:");
    for (const r of resultBlock.results) {
      console.log(`  ch${r.virtualChannelId} ${r.intentId}:`, JSON.stringify(r.payload));
    }
    console.log("resultMerkleRoot:", resultBlock.resultMerkleRoot);

    // Tamper detection: mutate an intent leaf and re-verify.
    block.intents[0].leafHash = sha256hex("tampered");
    console.log("\nafter tamper, verifyBlock:", verifyBlock(block));
  })();
}
