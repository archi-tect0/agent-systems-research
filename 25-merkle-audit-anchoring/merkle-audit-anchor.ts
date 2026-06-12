/**
 * Merkle Audit Anchoring
 * ----------------------
 * Group a window of audit events into a Merkle tree and anchor only the single
 * 32-byte root. For any individual event you can later produce a logarithmic
 * inclusion proof that verifies against the anchored root; altering any event
 * makes every proof for the batch invalid.
 *
 * Leaves are SHA-256 hashes of a canonical event projection, sorted for
 * determinism. hashPair sorts its two children so a parent is independent of
 * argument order. Odd nodes are promoted to the next layer unchanged.
 *
 * No external dependencies — Node standard library (node:crypto) only.
 *
 * Run the self-check:  npx tsx merkle-audit-anchor.ts --demo
 */

import { createHash } from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id:        string;
  eventType: string;
  actor:     string | null;
  metadata:  unknown;
  createdAt: Date;
}

export interface MerkleTree {
  root:   string;
  leaves: string[];      // sorted leaf hashes
  layers: string[][];    // layers[0] = leaves, last layer = [root]
}

export interface MerkleProof {
  leaf:      string;
  proof:     string[];                  // sibling hashes, leaf → root
  positions: ("left" | "right")[];      // side each sibling sits on
  root:      string;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical projection → SHA-256. Same event always yields the same leaf. */
export function hashEvent(e: AuditEvent): string {
  const canonical = JSON.stringify({
    id:        e.id,
    eventType: e.eventType,
    actor:     e.actor,
    metadata:  e.metadata,
    createdAt: e.createdAt.toISOString(),
  });
  return sha256Hex(canonical);
}

/** Order-independent parent: concatenate the smaller child first. */
function hashPair(a: string, b: string): string {
  return sha256Hex(a < b ? a + b : b + a);
}

// ── Tree construction ───────────────────────────────────────────────────────

export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    const emptyHash = sha256Hex("");
    return { root: emptyHash, leaves: [], layers: [[emptyHash]] };
  }

  const sorted = [...leaves].sort();
  const layers: string[][] = [sorted];
  let current = sorted;

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        next.push(current[i]); // odd node promoted unchanged
      }
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], leaves: sorted, layers };
}

// ── Proofs ──────────────────────────────────────────────────────────────────

export function generateProof(tree: MerkleTree, leafHash: string): MerkleProof | null {
  const leafIndex = tree.leaves.indexOf(leafHash);
  if (leafIndex === -1) return null;

  const proof: string[] = [];
  const positions: ("left" | "right")[] = [];
  let index = leafIndex;

  for (let i = 0; i < tree.layers.length - 1; i++) {
    const layer = tree.layers[i];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
      positions.push(isRight ? "left" : "right");
    }
    index = Math.floor(index / 2);
  }

  return { leaf: leafHash, proof, positions, root: tree.root };
}

export function verifyProof(proof: MerkleProof): boolean {
  let hash = proof.leaf;
  for (let i = 0; i < proof.proof.length; i++) {
    const sibling = proof.proof[i];
    hash = proof.positions[i] === "left" ? hashPair(sibling, hash) : hashPair(hash, sibling);
  }
  return hash === proof.root;
}

// ── Anchoring a window ──────────────────────────────────────────────────────

export interface AnchorBatch {
  root:        string;
  count:       number;
  periodStart: Date;
  periodEnd:   Date;
  status:      "pending" | "anchored";
}

/**
 * Build an anchor batch over a time window. Returns the batch metadata and the
 * tree. The caller commits batch.root to an external immutable medium, then
 * flips status to "anchored". An empty window still yields a batch (root = sha256("")).
 */
export function buildAnchorBatch(events: AuditEvent[], periodStart: Date, periodEnd: Date): { batch: AnchorBatch; tree: MerkleTree } {
  const inWindow = events.filter(e => e.createdAt >= periodStart && e.createdAt < periodEnd);
  const tree = buildMerkleTree(inWindow.map(hashEvent));
  return {
    batch: { root: tree.root, count: inWindow.length, periodStart, periodEnd, status: "pending" },
    tree,
  };
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const base = new Date("2024-01-01T00:00:00.000Z").getTime();
  const events: AuditEvent[] = Array.from({ length: 7 }, (_, i) => ({
    id:        `evt-${i}`,
    eventType: i % 2 ? "permission.grant" : "funds.transfer",
    actor:     `user-${i}`,
    metadata:  { amount: i * 10, note: `event ${i}` },
    createdAt: new Date(base + i * 1000),
  }));

  const periodStart = new Date(base);
  const periodEnd = new Date(base + 10_000);
  const { batch, tree } = buildAnchorBatch(events, periodStart, periodEnd);

  console.log("anchor batch:");
  console.log("  count:", batch.count, "(odd → exercises node promotion)");
  console.log("  root: ", batch.root);
  console.log("  layers:", tree.layers.map(l => l.length).join(" → "));

  console.log("\ninclusion proof for evt-3:");
  const target = hashEvent(events[3]);
  const proof = generateProof(tree, target)!;
  console.log("  proof length:", proof.proof.length, "siblings (log-scale)");
  console.log("  verifies:", verifyProof(proof));

  console.log("\ntamper detection:");
  const tampered: AuditEvent = { ...events[3], metadata: { amount: 999999, note: "rewritten" } };
  const tamperedProof: MerkleProof = { ...proof, leaf: hashEvent(tampered) };
  console.log("  rewritten event verifies against original root:", verifyProof(tamperedProof));

  console.log("\nforeign event has no proof:");
  const foreign = hashEvent({ id: "evt-x", eventType: "x", actor: null, metadata: {}, createdAt: new Date(base) });
  console.log("  generateProof returns null:", generateProof(tree, foreign) === null);

  console.log("\nempty window:");
  const empty = buildAnchorBatch([], periodStart, periodEnd);
  console.log("  root === sha256(\"\"):", empty.batch.root === createHash("sha256").update("").digest("hex"));
}
