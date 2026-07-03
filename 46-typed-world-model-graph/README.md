# Typed World-Model Graph with Goal Topology


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Most agent "memory" systems are flat: a vector store of text chunks retrieved by
similarity. That works for "what did the user say about X?" but it falls apart
the moment the agent needs to *reason about the user's situation* rather than
recall a sentence. There is no notion of which goal a task belongs to, which
project is blocked, who the people in the user's life are, or what hard
constraints (budget, deadlines, aversions) bound every plan. The model re-reads
raw snippets every turn and re-derives the structure from scratch — expensively
and inconsistently.

What's missing is a *structured* model: typed entities with typed relationships,
properties, and confidence scores. A goal is a goal, a project is a project, and
a project can belong to a goal. Once the data is typed, the agent can be handed a
compact hierarchy ("here is the goal tree, here are the active constraints")
instead of a pile of text, and it reasons about blockers and milestones directly.

The hard part is doing this without a heavy graph database. Adjacency tables and
recursive `WITH RECURSIVE` queries are operationally annoying and slow. The
insight here is that a single flat table of rows — each row optionally naming its
parent inside a JSON properties field — is enough. The tree is reconstructed in
memory at read time in two linear passes. No graph engine, no recursive SQL.

## Design decisions

**Why typed entities instead of free-form memory?**
A type tells the agent how to use a fact. A `constraint` ("runway: 7 months")
must bound every plan; an `aversion` ("hates surprise meetings") must filter
suggestions; a `goal` can have children. Typing is what lets the renderer group
and prioritise — people, goals, commitments, constraints, threats each get their
own line in the injected block, in a fixed order the model learns to rely on.

**Why store the parent link in JSON properties instead of a foreign key column?**
Because it keeps the schema flat and migration-free. Adding a new relationship
kind never requires a schema change — it's just another property. The tradeoff
is that referential integrity isn't enforced by the database, so the reader must
tolerate dangling parent ids (it does: an unknown parent simply makes the node a
root). For a per-user model that is rebuilt continuously from extraction, that's
the right tradeoff.

**Why reconstruct the tree at read time?**
The hierarchy is needed only when assembling context, which happens once per
turn over a small per-user set (tens of entities, not millions). Two linear
passes — build a node map, then wire parents — is trivially fast and avoids
recursive queries entirely. Materialising the tree on write would mean keeping it
consistent under every upsert; reconstructing on read makes writes dumb and
cheap.

**Why merge on upsert instead of inserting duplicates?**
The same entity surfaces repeatedly as the user talks. Keying on a deterministic
slug (`goal.ship_the_product`) and merging — union properties, keep the higher
confidence — means repeated mentions *reinforce* an entity rather than spawning
near-duplicates. Confidence is monotonic upward on agreement, which is a simple
proxy for "we've heard this several times, trust it more."

**Why a compact rendered block instead of dumping JSON?**
Tokens. The injected block uses short labels, caps each category at a few items,
and only expands the goal tree two levels deep. The model gets the shape of the
user's life in ~100 tokens instead of a verbose object graph.

## Algorithm

```
upsert(input):
  entityId = input.entityId or slugify(type, label)
  props    = input.properties; if parentEntityId: props.parentEntityId = it
  if entity with entityId exists:
    merge label, props (new wins), confidence = max(old, new), updatedAt = now
  else:
    create entity { id, type, entityId, label, props, confidence, confirmed }

getGoalTree():                       # two linear passes, no recursion
  flat    = listByType([goal, project, commitment, routine])
  nodeMap = { e.entityId -> {…e, children:[], depth:0} for e in flat }
  roots   = []
  for node in nodeMap.values():
    parent = nodeMap[node.props.parentEntityId]   # may be missing
    if parent: node.depth = parent.depth + 1; parent.children.push(node)
    else:      roots.push(node)
  return sortByConfidenceDesc(roots, recursively)

renderContext():
  gather people, goalTree, commitments, constraints, aversions, threats
  emit "[World Model]" header
  emit "People: a, b, c (+N)"
  emit "Goals:" + indented tree (icons per type, max depth 2, max 3 per level)
  emit "Commitments / Constraints / Aversions / Active threats" lines
```

## Reference implementation

See [`world-model-graph.ts`](./world-model-graph.ts) in this directory.

Runs on Node.js built-ins only — no external dependencies. The store is an
in-memory `Map`; the production version persists rows to Postgres keyed by wallet
and filters on an `archivedAt IS NULL` predicate, but the tree-reconstruction and
rendering logic are byte-for-byte the same.

## Usage

```typescript
import { WorldModelGraph } from "./world-model-graph.js";

const g = new WorldModelGraph();

// Build a goal hierarchy with parent links.
const life = g.upsert({ entityType: "goal", label: "Ship the product", confidence: 0.97 });
const proj = g.upsert({ entityType: "project", label: "Beta launch", parentEntityId: life.entityId });
g.upsert({ entityType: "goal", label: "Pass security review", parentEntityId: proj.entityId });

// Cross-cutting facts.
g.upsert({ entityType: "person", label: "Dana (co-founder)" });
g.upsert({ entityType: "constraint", label: "Runway: 7 months", confidence: 0.99 });

// Reconstruct the tree (linear, no recursive queries) and render for the prompt.
const roots = g.getGoalTree();
const contextBlock = g.renderContext();
```

## Limitations and extensions

- **No referential integrity.** A dangling `parentEntityId` silently makes the
  node a root. If integrity matters, validate parent existence on upsert or run a
  periodic sweep.
- **In-memory store.** This reference holds everything in a `Map`. For
  persistence, back each entity with a row and filter by user/wallet; the graph
  logic is unchanged.
- **Cycle handling.** The tree builder assumes parent links form a forest. A
  malformed cycle would not infinite-loop (each node is visited once) but would
  drop a node from `roots`. Add a cycle check if parents are user-supplied.
- **Confidence is heuristic.** It only moves up on agreement. A real system also
  needs decay and contradiction handling (a `correction` entity that lowers or
  retires a stale fact).
- **Extension — automatic extraction.** Upstream, a cheap extraction pass turns
  each conversational turn into typed facts and calls `upsert`. The graph is the
  durable structure; extraction is just the feeder.
