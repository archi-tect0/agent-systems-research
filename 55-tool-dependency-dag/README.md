# Dependency-Aware Parallel Tool Dispatch

## Problem

When a language model decides to call several tools in a single turn, the simplest dispatcher runs them one after another. That is correct but slow: if three of the calls are independent — say three separate searches — there is no reason to pay the latency of all three back to back. The total wall-clock time becomes the *sum* of every call's latency when it could be close to the *maximum*.

Naive parallelism (run everything with `Promise.all`) is wrong in the other direction. Some calls genuinely depend on others: a "summarize" call that consumes the outputs of three searches must not start until those searches finish. Fire them all at once and the summarize step runs against missing inputs. Worse, `Promise.all` rejects as soon as any single call throws, discarding the results of calls that already succeeded.

What is needed is a dispatcher that understands the **dependency structure** of a tool batch: run independent calls concurrently, hold dependent calls until their prerequisites complete, and aggregate results in a way that tolerates individual failures. It also has to defend against malformed input — if the model emits a circular dependency, the dispatcher must not deadlock.

## Design decisions

**Why infer dependencies from argument text instead of an explicit graph?**
Models emit tool calls as a flat list; they rarely produce an explicit adjacency list. But when one call needs another's output, the model almost always references the earlier call's id inside the later call's arguments (the tool_use id pattern). Detecting "call B's serialized args contain call A's id" recovers the edges from data the model already provides, with no extra protocol. It is a heuristic, but a high-precision one for this usage pattern.

**Why group calls into waves rather than schedule each node individually?**
A wave is the set of calls whose prerequisites are all already complete. Everything in a wave is mutually independent by construction, so a wave maps directly onto one `Promise.allSettled` batch. This keeps the executor trivial — run wave, await, run next wave — while still extracting all available parallelism. A per-node scheduler would be more granular but adds bookkeeping for no practical gain when batches are small.

**Why `Promise.allSettled` instead of `Promise.all`?**
`Promise.all` is reject-fast: one failing tool call discards the results of every other call in the same wave, even the ones that succeeded. Tool calls fail routinely (timeouts, bad arguments, upstream errors) and the model can often recover from a partial result set. `allSettled` lets every call in a wave finish and reports each outcome independently, so one failure never poisons its siblings.

**Why detect cycles and degrade instead of throwing?**
A circular dependency means no call in the cycle can ever become "ready," so a strict topological loop would spin forever or have to throw. Throwing turns a model mistake into a hard failure for the whole turn. Instead, when a pass finds no ready calls but work remains, the remaining calls are emitted as a final best-effort wave in their original order. They may not get their (impossible) inputs, but they run, return results or errors, and the turn completes deterministically.

**Why preserve original call order in the output?**
The caller (and the model) reasons about results positionally — result *i* corresponds to call *i*. Execution order is reordered by the wave schedule, so results are collected into a map keyed by call id and then re-emitted in the original input order, decoupling "how fast" from "in what order the answer is reported."

**Why pass an `AbortSignal` through every layer?**
A turn can be cancelled mid-flight (user interrupt, timeout, downstream abort). Threading the signal into the dispatcher lets it stop launching new waves and fill in not-yet-run calls with an abort result, rather than leaking in-flight work or hanging.

## Algorithm

```
buildDependencyGraph(calls):
  graph = { call.id -> {} for call in calls }
  for a in calls:
    for b in calls where b != a:
      if b.args contains a.id:
        graph[b.id].add(a.id)        # b depends on a
  return graph

buildDispatchWaves(calls):
  deps = buildDependencyGraph(calls)
  remaining = set(all ids); completed = {}; waves = []
  while remaining not empty:
    ready = [ call for call in calls
              if call.id in remaining
              and every dep in deps[call.id] is in completed ]
    if ready is empty:                # cycle: degrade, do not deadlock
      waves.push([ call for call in calls if call.id in remaining ])
      break
    waves.push(ready)
    for call in ready: remaining.remove(call.id); completed.add(call.id)
  return waves

dispatchWave(wave, registry, signal):
  settled = await Promise.allSettled(
    wave.map(call => dispatchOne(call, registry, signal)))
  return settled mapped to ToolResult (rejections -> {error})

dispatchAll(calls, registry, signal):
  byId = {}
  for wave in buildDispatchWaves(calls):
    if signal.aborted: fill remaining with abort results; break
    for r in await dispatchWave(wave, registry, signal): byId[r.id] = r
  return calls.map(call => byId[call.id] ?? missing-result)   # original order

detectCycle(calls):                    # ids that can never become ready
  resolve iteratively; any id never resolved participates in a cycle
```

## Reference implementation

See [`tool-dependency-dag.ts`](./tool-dependency-dag.ts) in this directory. It uses only Node built-ins (`Promise.allSettled`, `setTimeout`, `AbortController`/`AbortSignal`); no external dependencies.

## Usage

```typescript
import {
  dispatchAll,
  buildDependencyGraph,
  buildDispatchWaves,
  detectCycle,
} from "./tool-dependency-dag.js";
import type { ToolCallSpec, ToolRegistry } from "./tool-dependency-dag.js";

// Tool implementations: name -> async (args) => string
const registry: ToolRegistry = {
  search: async (args) => `results for ${String(args.query)}`,
  summarize: async () => "combined summary",
};

// A fan-out (two independent searches) plus one dependent summarize.
const calls: ToolCallSpec[] = [
  { id: "t1", name: "search", args: JSON.stringify({ query: "alpha" }) },
  { id: "t2", name: "search", args: JSON.stringify({ query: "beta" }) },
  { id: "t3", name: "summarize", args: JSON.stringify({ sources: ["t1", "t2"] }) },
];

// Inspect the plan, then execute.
buildDependencyGraph(calls); // t3 -> [t1, t2]
buildDispatchWaves(calls);   // [[t1, t2], [t3]]
detectCycle(calls);          // empty set

const ctrl = new AbortController();
const results = await dispatchAll(calls, registry, ctrl.signal);
// results preserve original order; each has .result or .error and .durationMs
```

## Limitations and extensions

- **Dependency detection is by id substring.** It assumes the model embeds prerequisite ids in dependent calls' arguments. A call that depends on another's output without naming its id will be treated as independent and may run too early. A typed/explicit dependency field would remove the heuristic.
- **False-positive edges are possible.** If a call's arguments happen to contain a string equal to another call's id by coincidence, a spurious dependency is added (it only ever delays, never corrupts). Use opaque, high-entropy ids to make accidental matches negligible.
- **No result substitution.** This dispatcher orders execution but does not splice an upstream call's output into a downstream call's arguments. Wiring real values from prerequisites into dependents is a separate concern layered on top.
- **Cycle handling is best-effort, not corrective.** On a cycle the remaining calls still run but without their (impossible) inputs. The dispatcher reports the cycle via `detectCycle`; deciding whether to drop, retry, or surface an error to the model is left to the caller.
- **Wave-level concurrency is unbounded.** Every call in a wave launches at once. For large fan-outs against rate-limited backends, add a concurrency cap (e.g. a semaphore) inside `dispatchWave`.
