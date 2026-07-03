# Agent Self-Model Graph


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A typed, queryable model of the agent's own subsystems, capabilities, and live health — the structure self-repair, uncertainty, and governance read before they act.*

A world-model graph ([guide 46](../46-typed-world-model-graph/)) answers "what do I know about the *user* and their goals?". This guide answers the other question a self-maintaining agent has to be able to ask: **"what am I made of, what part of me is broken right now, and what does that break downstream?"** It is the explicit *self*-model — the schema the metacognitive loop ([guide 66](../66-metacognitive-self-repair/)) was implicitly reasoning over, pulled out into its own first-class structure.

This is the second guide in the Layer-2 set (the agent operating on *itself*). Where guide 66 *repairs* a fault, this guide is the map it repairs against.

## Problem

When a user says "your memory is broken" or "music won't play", they are reporting a **symptom**, not a cause. An agent without an explicit model of itself has only two bad options:

- **Treat the symptom as the cause** — restart `play_audio`, re-run `recall_memory` — and thrash, because the real fault is one layer down (the audio endpoint is dead; the embedder is refusing connections).
- **Guess from a flat checklist** — probe everything, in no particular order, with no idea which failures *explain* which other failures.

Three things are missing, and they are all structural:

1. **A schema.** What are the parts that can fail, and what kind of thing is each (an internal subsystem? a capability the user invokes? an external resource)?
2. **Failure localization.** Given a failing symptom, which *upstream* dependency is the actual root cause — and how do you avoid stopping at an intermediate that looks healthy on its own?
3. **Blast radius.** Given a root cause, which user-facing capabilities does it actually take down — so the agent can say "recall and search are unavailable" instead of "something's wrong"?

This guide builds the self-model as a small typed dependency graph and implements those three queries against it.

## Design decisions

**Three node kinds, because they fail and heal differently.** A `subsystem` is an internal component the agent owns (router, dispatcher, memory store) — you fix it by changing code or config. A `capability` is something the user invokes (a tool/skill) — it is the *symptom surface*, what a complaint names. A `resource` is an external dependency (an endpoint, a provider, an embedder) — you fix it by repointing or waiting, not by editing yourself. Collapsing these into one "component" type loses exactly the distinction that tells self-repair *what kind of remedy applies*.

**The graph stores health; it never invents it.** `setHealth` is written by the introspection layer (the read-only probes of guide 66). The graph's job is structure and queries, not measurement. This keeps the boundary clean: probes decide *whether* a node is healthy; the graph decides *what that implies* for everything connected to it. A self-model that guessed at health would be a second, conflicting source of truth.

**Edges are "depends-on", validated on insert.** Every edge is `from depends-on to`, meaning a failure in `to` can degrade `from`. Inserts reject dangling endpoints (no edge to a node that does not exist) and reject anything that would create a cycle — a self-model with a dependency cycle has no well-defined root cause, so the structure forbids one rather than coping with it at query time.

**Localization follows *effective* health, not declared health.** This is the load-bearing decision. A subsystem can probe "ok" on its own checks while being effectively dead because something it depends on is down (the `memory` subsystem answers, but its embedder is refusing connections). If localization only descended through nodes whose *own* declared health was failing, it would stop at the first healthy-looking intermediate and blame the wrong thing. Instead, at each step it descends into the dependency whose **effective** health (the worst of its own health and all its dependencies') is worst — so it traverses *through* a green intermediate to the real culprit underneath. The root cause is the deepest node none of whose dependencies are effectively failing.

**Effective health rolls up the worst of the subtree.** `effectiveHealth(x)` = worst of `x`'s declared health and the effective health of everything `x` depends on. This is what lets a prompt-injected self-summary show `agent_bridge` as *degraded* the moment its model provider degrades, without the introspection layer having to know the topology — the topology lives in the graph, and the rollup reads it.

**Blast radius walks the reverse edges.** Given a root cause, the set of affected nodes is everything reachable by *dependents* edges; the user-facing slice is the `capability` nodes in that set. This turns "the embedder is down" into the precise, honest list "`recall_memory` is unavailable; everything else is fine" — and, just as importantly, proves what is *not* affected.

## Algorithm

```
addNode(id, kind, label)        # kind ∈ {subsystem, capability, resource}
addDependency(from, to):        # "from depends on to"
  reject if from or to unknown  # no dangling edges
  reject if from == to
  reject if `from` reachable from `to`   # no cycles
  deps[from].add(to); dependents[to].add(from)

setHealth(id, health, evidence) # written by the read-only introspection layer

effectiveHealth(id):            # worst of own health and all deps' effective health
  return worst(node.health, max over deps( effectiveHealth(dep) ))

# (3) symptom -> root cause: descend the worst EFFECTIVE-failing dependency
localizeFault(symptom):
  current = symptom; chain = []
  loop:
    chain.push(current)
    dep = argmax over deps(current) where effectiveHealth(dep) is failing
          ranked by effectiveHealth desc, then declared health desc
    if no such dep: break          # current depends on nothing failing -> root
    current = dep
  return { rootCause: current, chain }

# (4) root cause -> what it takes down: walk reverse edges
blastRadius(root):
  affected = BFS over dependents starting at root
  return { affected, capabilities: affected.filter(kind == capability) }
```

## Reference implementation

[`self-model-graph.ts`](./self-model-graph.ts) — a standalone, dependency-free `SelfModelGraph`. Nodes and edges are plain `Map`s, health is a stored field, and the queries are pure graph walks with an injectable clock for `updatedAt`. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node self-model-graph.ts --demo

# or with tsx:
npx tsx self-model-graph.ts --demo
```

The demo builds a Kylum-shaped self-model (router / dispatcher / memory / agent-bridge subsystems, cloud-model / embedder / audio-endpoint resources, answer / recall_memory / play_audio capabilities) and exercises five scenarios:

1. **Healthy self-model** — structure plus the effective-health rollup, all green.
2. **Embedder down** — symptom `recall_memory` localizes *through* the green `memory` subsystem to the `embedder` resource; blast radius lists exactly `recall_memory` and proves `answer`/`play_audio` are unaffected.
3. **Symptom vs cause** — the user blames `play_audio`; localization names `audio_endpoint` as the thing to fix (the same shape as the real owner-blocked-embed playback fault).
4. **Effective-health rollup** — a degraded `cloud_model` makes `agent_bridge` read *degraded* even though its own declared health is `ok`.
5. **Structural guards** — dangling and cyclic edges are rejected at insert time.

## How this maps to the production system

| Self-model concept | Production mechanism |
|--------------------|----------------------|
| `subsystem` nodes | the router, tool dispatcher, pgvector memory, agent-bridge turn loop — each separately probeable |
| `resource` nodes | the active cloud provider, the embedding endpoint, music/audio endpoints, the database |
| `capability` nodes | the registered tools the agent exposes (what a user complaint actually names) |
| `setHealth` (writes) | the read-only introspection probes of [guide 66](../66-metacognitive-self-repair/) (`git_status`, backend `HealthGuard`, connector status, tool error telemetry) |
| `localizeFault` | the diagnosis step that produces a stable fault `signature` for memory + cooldowns to key on |
| `blastRadius` | the user-facing "what's affected" list and the input to the conversation-state empty-response guard |
| `effectiveHealth` rollup | the compact self-status block injected into the prompt so the agent knows its own degraded surface |
| cycle/dangling rejection | the invariant that the self-model has a well-defined root cause for every fault |

## Limitations and extensions

- **One root cause per symptom.** Real incidents can be comorbid (a degraded model *and* a dead endpoint at once). Extend `localizeFault` to return a ranked set of roots rather than the single worst branch, and let the caller sequence repairs — but keep each repair independently verified, the way guide 66 does.
- **Health is a four-value enum.** `ok / degraded / down / unknown` is deliberately coarse. If you need finer signal (a latency percentile, an error rate), attach it to `evidence` and let the diagnoser read it; keep the rollup on the coarse enum so the topology math stays cheap and total.
- **Edges are unweighted.** Every dependency is treated as load-bearing. If some dependencies are soft (a cache that can be missed) and others hard (the model), add an edge weight and let the rollup treat a failed soft dependency as `degraded` rather than `down`.
- **No automatic discovery.** The graph here is constructed explicitly. In a large system, generate it from the dependency-injection wiring or the route/tool registry so it cannot drift from the real topology — a self-model that lies about its own structure is worse than none.
- **Static snapshot.** This models health *now*. Pair it with the temporal awareness of guide 66 (cooldowns, flapping) so "down for 2s during a deploy" and "down for an hour" produce different decisions.
