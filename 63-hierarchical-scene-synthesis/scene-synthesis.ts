/**
 * Hierarchical Spatial Scene Synthesis
 *
 * Turns a compact, high-level SceneSpec into engine-ready operations through a
 * staged pipeline:
 *
 *   SceneSpec  ->  ZoneGraph  ->  ChunkPlan  ->  compact ops
 *
 *   SceneSpec  — author intent: a preset, bounds, a few named zones.
 *   ZoneGraph  — zones resolved to world-space rectangles + adjacency links.
 *   ChunkPlan  — each zone diced into renderable chunks under a budget.
 *   ops        — flat list of concrete engine commands (SET_ENV, SPAWN, ...).
 *
 * The ops are then published to a ring-buffered stream tagged with monotonic
 * sequence numbers, so a client that drops and reconnects can ask for
 * "everything since seq N" and replay exactly the ops it missed.
 *
 * Dependencies: none. Node.js built-ins only.
 */

// ── Stage 0: SceneSpec (author intent) ────────────────────────────────────────

export type Vec3 = { x: number; y: number; z: number };

export type ZoneSpec = {
  id: string;
  kind: "hub" | "field" | "corridor" | "room";
  weight: number;   // relative footprint (1 = baseline)
  density: number;  // props per chunk (drives op count)
};

export type SceneSpec = {
  worldId: string;
  preset: "EXPLORATION_HUB" | "OPEN_FIELD" | "ROOM_CLUSTER";
  bounds: Vec3;            // overall world size in metres
  zones: ZoneSpec[];
  budgetOps: number;       // hard ceiling on emitted ops
};

// ── Stage 1: ZoneGraph ────────────────────────────────────────────────────────

export type ZoneNode = {
  id: string;
  kind: ZoneSpec["kind"];
  origin: Vec3;           // world-space corner
  size: Vec3;             // world-space extent
  density: number;
  neighbors: string[];    // adjacency
};

export type ZoneGraph = { worldId: string; zones: ZoneNode[] };

/**
 * Lay zones out along the world's X axis, sized proportionally to their weight,
 * and link each to its neighbour to form a simple traversal graph.
 */
export function buildZoneGraph(spec: SceneSpec): ZoneGraph {
  const totalWeight = spec.zones.reduce((acc, z) => acc + Math.max(0.01, z.weight), 0);
  const nodes: ZoneNode[] = [];
  let cursorX = -spec.bounds.x / 2;
  for (let i = 0; i < spec.zones.length; i++) {
    const z = spec.zones[i];
    const width = (Math.max(0.01, z.weight) / totalWeight) * spec.bounds.x;
    nodes.push({
      id: z.id,
      kind: z.kind,
      origin: { x: cursorX, y: 0, z: -spec.bounds.z / 2 },
      size: { x: width, y: spec.bounds.y, z: spec.bounds.z },
      density: z.density,
      neighbors: [],
    });
    cursorX += width;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) nodes[i].neighbors.push(nodes[i - 1].id);
    if (i < nodes.length - 1) nodes[i].neighbors.push(nodes[i + 1].id);
  }
  return { worldId: spec.worldId, zones: nodes };
}

// ── Stage 2: ChunkPlan ────────────────────────────────────────────────────────

export type Chunk = {
  id: string;
  zoneId: string;
  origin: Vec3;
  size: Vec3;
  propCount: number;
};

export type ChunkPlan = { worldId: string; chunks: Chunk[] };

const CHUNK_EDGE = 32; // metres per chunk along X/Z

/**
 * Dice each zone into a grid of fixed-size chunks. Each chunk carries a prop
 * count derived from the zone density. This is where coarse intent becomes a
 * concrete amount of work.
 */
export function planChunks(graph: ZoneGraph): ChunkPlan {
  const chunks: Chunk[] = [];
  for (const zone of graph.zones) {
    const cols = Math.max(1, Math.ceil(zone.size.x / CHUNK_EDGE));
    const rows = Math.max(1, Math.ceil(zone.size.z / CHUNK_EDGE));
    const cw = zone.size.x / cols;
    const cd = zone.size.z / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        chunks.push({
          id: `${zone.id}.c${r}_${c}`,
          zoneId: zone.id,
          origin: { x: zone.origin.x + c * cw, y: 0, z: zone.origin.z + r * cd },
          size: { x: cw, y: zone.size.y, z: cd },
          propCount: Math.max(0, Math.round(zone.density)),
        });
      }
    }
  }
  return { worldId: graph.worldId, chunks };
}

// ── Stage 3: compact ops ──────────────────────────────────────────────────────

export type CompactOp = { op: string; target: string; args: Record<string, unknown> };

/**
 * Flatten a ChunkPlan into engine ops, stopping cleanly at budgetOps. The first
 * op initialises the scene; each chunk emits a region marker plus its props.
 * Returning a budget-bounded list keeps output predictable regardless of how
 * ambitious the spec was.
 */
export function emitOps(plan: ChunkPlan, spec: SceneSpec): CompactOp[] {
  const ops: CompactOp[] = [];
  const push = (op: CompactOp): boolean => {
    if (ops.length >= spec.budgetOps) return false;
    ops.push(op);
    return true;
  };

  push({ op: "SCENE_INIT", target: spec.worldId, args: { preset: spec.preset } });
  push({ op: "SET_ENV", target: spec.worldId, args: { bounds: spec.bounds } });

  for (const chunk of plan.chunks) {
    if (!push({ op: "MAKE_REGION", target: chunk.id, args: { origin: chunk.origin, size: chunk.size } })) break;
    let stop = false;
    for (let i = 0; i < chunk.propCount; i++) {
      const px = chunk.origin.x + ((i + 1) / (chunk.propCount + 1)) * chunk.size.x;
      const pz = chunk.origin.z + ((i * 7 + 3) % 11) / 11 * chunk.size.z;
      if (!push({ op: "SPAWN", target: `${chunk.id}.p${i}`, args: { position: { x: px, y: 0, z: pz } } })) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  return ops;
}

/** Convenience: run the whole pipeline SceneSpec -> ops. */
export function synthesize(spec: SceneSpec): CompactOp[] {
  return emitOps(planChunks(buildZoneGraph(spec)), spec);
}

// ── Replayable op stream (ring buffer + sequence numbers) ─────────────────────

export type StreamFrame = { seq: number; op: CompactOp };

/**
 * A bounded, replayable op stream. Ops are tagged with a monotonic seq and kept
 * in a ring buffer capped at `cap`. A reconnecting client calls replaySince(N)
 * to receive exactly the frames it missed (everything with seq > N).
 */
export class OpStream {
  private ring: StreamFrame[];
  private nextSeq: number;
  private cap: number;

  constructor(cap = 2048) {
    this.ring = [];
    this.nextSeq = 1;
    this.cap = cap;
  }

  publish(ops: CompactOp[]): StreamFrame[] {
    const out: StreamFrame[] = [];
    for (const op of ops) {
      const frame: StreamFrame = { seq: this.nextSeq++, op };
      this.ring.push(frame);
      out.push(frame);
    }
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
    return out;
  }

  /** Frames with seq strictly greater than sinceSeq (0 => whole buffer). */
  replaySince(sinceSeq: number): StreamFrame[] {
    if (!sinceSeq || sinceSeq <= 0) return this.ring.slice();
    return this.ring.filter((f) => f.seq > sinceSeq);
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const spec: SceneSpec = {
    worldId: "demo-world",
    preset: "EXPLORATION_HUB",
    bounds: { x: 128, y: 24, z: 96 },
    budgetOps: 200,
    zones: [
      { id: "plaza", kind: "hub", weight: 2, density: 3 },
      { id: "meadow", kind: "field", weight: 3, density: 2 },
      { id: "hall", kind: "room", weight: 1, density: 4 },
    ],
  };

  const graph = buildZoneGraph(spec);
  console.log("Stage 1 ZoneGraph:");
  for (const z of graph.zones) {
    console.log(`  ${z.id.padEnd(7)} x=[${z.origin.x.toFixed(1)}..${(z.origin.x + z.size.x).toFixed(1)}] neighbors=[${z.neighbors.join(",")}]`);
  }

  const plan = planChunks(graph);
  console.log("\nStage 2 ChunkPlan: total chunks =", plan.chunks.length);

  const ops = emitOps(plan, spec);
  console.log("Stage 3 ops emitted =", ops.length, "(budget", spec.budgetOps + ")");
  console.log("  first 3 ops:", JSON.stringify(ops.slice(0, 3)));

  // Stream + replay
  const stream = new OpStream(4096);
  stream.publish(ops);
  console.log("\nStream lastSeq =", stream.lastSeq);

  const clientLastSeen = stream.lastSeq - 5; // client missed the final 5 ops
  const missed = stream.replaySince(clientLastSeen);
  console.log(`Client reconnects at seq ${clientLastSeen}; replay delivers ${missed.length} frames`);
  console.log("  replayed seqs:", missed.map((f) => f.seq).join(","));

  // Determinism: same spec -> same op stream.
  const again = synthesize(spec);
  console.log("\nDeterministic pipeline:", JSON.stringify(ops) === JSON.stringify(again));
}
