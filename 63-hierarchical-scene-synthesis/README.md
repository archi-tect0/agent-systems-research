# Hierarchical Spatial Scene Synthesis


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Generating a 3D scene directly as a flat list of engine commands is hard to control. A single pass that emits "place this object here, that light there" has no structure to reason about: it is difficult to keep within a work budget, difficult to lay zones out coherently, and difficult to make deterministic so the same input reliably produces the same output.

The concern is to turn a compact, high-level description of a scene — a preset, overall bounds, a handful of named zones — into a concrete, budget-bounded list of engine operations through stages that each add exactly one kind of detail. Coarse author intent becomes a spatial layout, the layout becomes a concrete amount of work, and the work becomes flat commands, with a hard ceiling on how many commands are emitted regardless of how ambitious the input was.

A second concern is delivery. The operation stream is consumed by a client (a render surface) that may drop its connection and reconnect. The client must be able to resynchronize without replaying the entire scene from scratch — it needs to ask for "everything since the last operation I saw" and receive exactly the operations it missed.

## Design decisions

**Why a staged `SceneSpec → ZoneGraph → ChunkPlan → ops` pipeline?**
Each stage has a single responsibility. `buildZoneGraph` resolves abstract zones into world-space rectangles laid out along the X axis, sized proportionally to each zone's weight, and links adjacent zones into a traversal graph. `planChunks` dices each zone into fixed-size chunks and assigns each a prop count from the zone density — this is where coarse intent becomes a concrete amount of work. `emitOps` flattens the chunk plan into engine commands. Separating the stages makes each one testable and keeps the transformation legible.

**Why weight-proportional zone sizing?**
Authors describe zones by relative weight rather than absolute coordinates. Total weight is summed and each zone is allocated a fraction of the world's X extent proportional to its weight. This lets a spec stay compact and resolution-independent: the same zone weights produce a sensible layout whatever the overall bounds.

**Why a hard op budget?**
`emitOps` stops cleanly once it reaches `budgetOps`, mid-chunk if necessary. A budget-bounded list keeps output size predictable no matter how large the spec is, which protects both the generator and the downstream client from runaway scenes.

**Why a deterministic pipeline?**
Given the same `SceneSpec`, `synthesize` produces the same op stream every time — zone layout, chunk dicing, and prop placement are all computed from the input with no randomness. Determinism makes the output cacheable, diffable, and reproducible across runs.

**Why a ring-buffered op stream with sequence numbers?**
Ops are published to an `OpStream` that tags each op with a monotonically increasing sequence number and retains them in a ring buffer capped at a fixed size. A client that reconnects calls `replaySince(N)` to receive exactly the frames with `seq > N` — the operations it missed — rather than the whole scene. The cap bounds memory; the sequence numbers make "what did I miss" answerable precisely.

## Algorithm

```
synthesize(spec) = emitOps(planChunks(buildZoneGraph(spec)), spec)

buildZoneGraph(spec):                 // Stage 1: zones -> world-space rectangles
  totalWeight = sum(max(0.01, z.weight) for z in spec.zones)
  cursorX = -spec.bounds.x / 2
  for z in spec.zones:
    width  = max(0.01, z.weight) / totalWeight * spec.bounds.x
    node   = { origin: (cursorX, 0, -bounds.z/2), size: (width, bounds.y, bounds.z), density }
    cursorX += width
  link each node to its previous and next neighbour
  return { worldId, zones }

planChunks(graph):                    // Stage 2: dice zones into fixed chunks
  for zone in graph.zones:
    cols = ceil(zone.size.x / CHUNK_EDGE); rows = ceil(zone.size.z / CHUNK_EDGE)
    for each (r, c):
      emit chunk { origin, size, propCount = round(zone.density) }

emitOps(plan, spec):                  // Stage 3: flatten to ops, bounded by budget
  push SCENE_INIT(worldId, preset); push SET_ENV(worldId, bounds)
  for chunk in plan.chunks:
    if not push MAKE_REGION(chunk): break        // budget reached
    for i in 0..chunk.propCount:
      if not push SPAWN(chunk.pi, position): break
  return ops                          // length <= spec.budgetOps

OpStream(cap):                        // replayable delivery
  publish(ops): tag each with nextSeq++, append to ring, trim to cap
  replaySince(N): frames with seq > N  (N <= 0 => whole buffer)
  lastSeq: highest sequence published
```

## Reference implementation

See [`scene-synthesis.ts`](./scene-synthesis.ts) in this directory. It runs on Node.js built-ins only — there are no external dependencies; the pipeline and the op stream are pure data transformations.

## Usage

```typescript
import {
  synthesize,
  buildZoneGraph,
  planChunks,
  emitOps,
  OpStream,
  type SceneSpec,
} from "./scene-synthesis.js";

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

// Run the whole pipeline, or each stage individually.
const ops = synthesize(spec);
const graph = buildZoneGraph(spec);
const plan = planChunks(graph);
const sameOps = emitOps(plan, spec); // identical to synthesize(spec)

// Publish to a replayable, ring-buffered stream.
const stream = new OpStream(4096);
stream.publish(ops);

// A client that reconnected at an earlier seq fetches only what it missed.
const clientLastSeen = stream.lastSeq - 5;
const missed = stream.replaySince(clientLastSeen);
console.log(missed.map((f) => f.seq));
```

## Limitations and extensions

- **Linear (1-D) zone layout.** Zones are laid out along a single axis with neighbour-only adjacency. Richer 2-D grids or graph topologies would require a different `buildZoneGraph`.
- **Uniform chunk size and density.** Chunks are a fixed edge length and each chunk in a zone gets the same prop count. Variable level-of-detail (denser near interest points, sparser at the edges) is a natural extension.
- **Deterministic but not validated against a schema.** The reference emits a small op vocabulary (`SCENE_INIT`, `SET_ENV`, `MAKE_REGION`, `SPAWN`). A production pipeline validates the full output against a strict scene schema (environment, navigation, entities, constraints, metadata) before sending it to the engine.
- **Single-stream replay.** `OpStream` retains a flat, capped history. A client that has been disconnected longer than the buffer depth (older than the oldest retained seq) must fall back to a full resynchronization.
- **No backpressure or acknowledgements.** Publishing does not wait for client consumption. Flow control and per-client acknowledgement of applied sequence numbers are out of scope for the reference.
