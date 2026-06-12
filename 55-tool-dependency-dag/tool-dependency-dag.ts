/**
 * Dependency-Aware Parallel Tool Dispatch
 *
 * When an LLM emits several tool calls in one turn, running them strictly in
 * sequence wastes wall-clock time: independent calls could run concurrently.
 * This module builds a directed acyclic graph (DAG) over a batch of tool calls,
 * groups them into topological "waves" of mutually-independent calls, runs each
 * wave concurrently, and chains dependent calls behind their prerequisites.
 *
 * Dependency rule (kept deliberately simple): call B depends on call A if B's
 * serialized arguments mention A's id. This captures the common pattern where a
 * model references an earlier tool_use id inside a later call's arguments.
 *
 * Aggregation uses Promise.allSettled, so one failing call never rejects the
 * whole wave. Cycles are detected and degraded safely: any calls that can never
 * become ready are emitted as a final best-effort wave instead of deadlocking.
 *
 * Built-ins only. Tools here are stub async functions backed by setTimeout.
 *
 * Run the demo:  node tool-dependency-dag.ts --demo
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolCallSpec = {
  id: string;
  name: string;
  /** Serialized JSON arguments. Dependencies are detected by id substring. */
  args: string;
};

export type ToolResult = {
  id: string;
  name: string;
  result: string;
  error?: string;
  durationMs: number;
};

/** A tool implementation: receives parsed args, returns a string result. */
export type ToolFn = (args: Record<string, unknown>) => Promise<string>;

export type ToolRegistry = Record<string, ToolFn>;

// ── Dependency graph ──────────────────────────────────────────────────────────

/**
 * Build a dependency graph for a batch of calls.
 * Returns a map: callId -> Set of prerequisite callIds.
 */
export function buildDependencyGraph(calls: ToolCallSpec[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const call of calls) graph.set(call.id, new Set<string>());

  for (let i = 0; i < calls.length; i++) {
    const a = calls[i]!;
    for (let j = 0; j < calls.length; j++) {
      if (i === j) continue;
      const b = calls[j]!;
      if (b.args.includes(a.id)) graph.get(b.id)!.add(a.id);
    }
  }
  return graph;
}

/**
 * Detect whether the dependency graph contains a cycle.
 * Returns the set of call ids that participate in (or are blocked by) a cycle.
 */
export function detectCycle(calls: ToolCallSpec[]): Set<string> {
  const deps = buildDependencyGraph(calls);
  const resolved = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const call of calls) {
      if (resolved.has(call.id)) continue;
      const callDeps = deps.get(call.id) ?? new Set<string>();
      let ready = true;
      for (const d of callDeps) {
        if (!resolved.has(d)) { ready = false; break; }
      }
      if (ready) { resolved.add(call.id); progress = true; }
    }
  }
  const stuck = new Set<string>();
  for (const call of calls) if (!resolved.has(call.id)) stuck.add(call.id);
  return stuck;
}

/**
 * Topologically sort calls into ordered waves. Each wave holds calls whose
 * prerequisites are all satisfied by earlier waves, so a wave runs concurrently.
 * On a cycle, the remaining calls are emitted as a final best-effort wave.
 */
export function buildDispatchWaves(calls: ToolCallSpec[]): ToolCallSpec[][] {
  if (calls.length === 0) return [];

  const deps = buildDependencyGraph(calls);
  const remaining = new Set<string>(calls.map(c => c.id));
  const completed = new Set<string>();
  const waves: ToolCallSpec[][] = [];

  while (remaining.size > 0) {
    const ready: ToolCallSpec[] = [];
    for (const call of calls) {
      if (!remaining.has(call.id)) continue;
      const callDeps = deps.get(call.id) ?? new Set<string>();
      let satisfied = true;
      for (const d of callDeps) {
        if (!completed.has(d)) { satisfied = false; break; }
      }
      if (satisfied) ready.push(call);
    }

    if (ready.length === 0) {
      // Cycle: emit remaining calls (original order) as a final wave, no throw.
      const fallback: ToolCallSpec[] = [];
      for (const call of calls) if (remaining.has(call.id)) fallback.push(call);
      if (fallback.length > 0) waves.push(fallback);
      break;
    }

    waves.push(ready);
    for (const call of ready) {
      remaining.delete(call.id);
      completed.add(call.id);
    }
  }
  return waves;
}

// ── Execution ─────────────────────────────────────────────────────────────────

function abortMessage(signal: AbortSignal): string {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (typeof reason === "string" && reason) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "Aborted";
}

async function dispatchOne(
  call: ToolCallSpec,
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult> {
  const t0 = Date.now();
  if (signal.aborted) {
    return { id: call.id, name: call.name, result: "", error: abortMessage(signal), durationMs: 0 };
  }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(call.args) as Record<string, unknown>; }
  catch { parsed = { _raw: call.args }; }

  const fn = registry[call.name];
  if (!fn) {
    return { id: call.id, name: call.name, result: "", error: `Unknown tool: ${call.name}`, durationMs: Date.now() - t0 };
  }

  try {
    const result = await fn(parsed);
    return { id: call.id, name: call.name, result, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "Tool execution failed";
    return { id: call.id, name: call.name, result: "", error: msg, durationMs: Date.now() - t0 };
  }
}

/**
 * Dispatch one wave concurrently using Promise.allSettled. Never throws; each
 * call yields a ToolResult (with .error set on failure).
 */
export async function dispatchWave(
  wave: ToolCallSpec[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  if (wave.length === 0) return [];
  const settled = await Promise.allSettled(wave.map(c => dispatchOne(c, registry, signal)));
  return settled.map((item, idx): ToolResult => {
    if (item.status === "fulfilled") return item.value;
    const call = wave[idx]!;
    const reason = item.reason;
    const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Tool execution failed";
    return { id: call.id, name: call.name, result: "", error: msg, durationMs: 0 };
  });
}

/**
 * Dispatch all calls with dependency-aware batching. Independent calls run
 * concurrently; dependents wait for their prerequisite waves. Results are
 * returned in original call order. Never throws.
 */
export async function dispatchAll(
  calls: ToolCallSpec[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  if (calls.length === 0) return [];
  const waves = buildDispatchWaves(calls);
  const byId = new Map<string, ToolResult>();

  for (const wave of waves) {
    if (signal.aborted) {
      for (const call of calls) {
        if (!byId.has(call.id)) {
          byId.set(call.id, { id: call.id, name: call.name, result: "", error: abortMessage(signal), durationMs: 0 });
        }
      }
      break;
    }
    const results = await dispatchWave(wave, registry, signal);
    for (const r of results) byId.set(r.id, r);
  }

  return calls.map(call => {
    const r = byId.get(call.id);
    if (r) return r;
    return {
      id: call.id,
      name: call.name,
      result: "",
      error: signal.aborted ? abortMessage(signal) : "Tool execution missing",
      durationMs: 0,
    };
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const line = (s: string) => console.log(s);
  const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

  // Stub tools with artificial latency. Each records its declared delay.
  const DELAYS: Record<string, number> = {
    search_a: 120,
    search_b: 140,
    search_c: 100,
    summarize: 90,
  };

  const registry: ToolRegistry = {
    search_a: async () => { await sleep(DELAYS.search_a!); return "results from source A"; },
    search_b: async () => { await sleep(DELAYS.search_b!); return "results from source B"; },
    search_c: async () => { await sleep(DELAYS.search_c!); return "results from source C"; },
    // Depends on the three searches; references their ids in its args.
    summarize: async () => { await sleep(DELAYS.summarize!); return "combined summary of A, B, C"; },
  };

  // Fan-out: three independent searches, then one dependent summarize that
  // references all three ids in its arguments.
  const calls: ToolCallSpec[] = [
    { id: "t1", name: "search_a", args: JSON.stringify({ query: "alpha" }) },
    { id: "t2", name: "search_b", args: JSON.stringify({ query: "beta" }) },
    { id: "t3", name: "search_c", args: JSON.stringify({ query: "gamma" }) },
    { id: "t4", name: "summarize", args: JSON.stringify({ sources: ["t1", "t2", "t3"] }) },
  ];

  line("=== Dependency-Aware Parallel Tool Dispatch demo ===\n");

  const graph = buildDependencyGraph(calls);
  line("Dependency graph (call -> prerequisites):");
  for (const call of calls) {
    const deps = [...(graph.get(call.id) ?? [])];
    line(`  ${call.id} (${call.name}) -> [${deps.join(", ") || "none"}]`);
  }
  line("");

  const waves = buildDispatchWaves(calls);
  line("Execution waves (each wave runs concurrently):");
  waves.forEach((w, i) => line(`  wave ${i + 1}: ${w.map(c => c.id).join(", ")}`));
  line("");

  const cycle = detectCycle(calls);
  line(`Cycle detected: ${cycle.size > 0 ? "yes" : "no"}`);
  line("");

  // Serial baseline = sum of all delays (what strict sequential would cost).
  const serialSumMs = Object.values(DELAYS).reduce((a, b) => a + b, 0);

  (async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const results = await dispatchAll(calls, registry, ctrl.signal);
    const wallMs = Date.now() - t0;

    line("Results (original order):");
    for (const r of results) {
      const status = r.error ? `ERROR: ${r.error}` : r.result;
      line(`  ${r.id} (${r.name}) [${r.durationMs}ms] ${status}`);
    }
    line("");

    line(`Serial sum of delays   : ${serialSumMs}ms`);
    line(`Parallel wall-clock    : ${wallMs}ms`);
    const speedup = serialSumMs / Math.max(wallMs, 1);
    line(`Speedup                : ${speedup.toFixed(2)}x`);
    line("");

    // Sanity: cycle-detection on a deliberately cyclic graph.
    const cyclic: ToolCallSpec[] = [
      { id: "c1", name: "search_a", args: JSON.stringify({ ref: "c2" }) },
      { id: "c2", name: "search_b", args: JSON.stringify({ ref: "c1" }) },
    ];
    const cyclicStuck = detectCycle(cyclic);
    line(`Cyclic-graph stuck nodes: [${[...cyclicStuck].join(", ")}]`);
    const cyclicWaves = buildDispatchWaves(cyclic);
    line(`Cyclic-graph degrades to ${cyclicWaves.length} wave(s) (no deadlock)`);

    const allOk = results.every(r => !r.error);
    const fasterThanSerial = wallMs < serialSumMs;
    const cycleHandled = cyclicStuck.size === 2 && cyclicWaves.length >= 1;

    if (!allOk || !fasterThanSerial || !cycleHandled) {
      console.error("\nDemo invariant failed.");
      process.exit(1);
    }
    line("\nDemo complete.");
  })();
}
