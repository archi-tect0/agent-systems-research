/**
 * Agent Self-Model Graph — reference implementation.
 *
 * A typed, queryable model of the agent's OWN internals: the subsystems it is
 * built from, the capabilities those subsystems expose, the dependency edges
 * between them, and the live health of each. Where a world-model graph models
 * the USER's entities and goals, this models the AGENT itself — the structure
 * that self-repair, uncertainty, and governance all read from when they need to
 * answer "what part of me is broken, and what does that break downstream?".
 *
 * The four things a self-model has to do:
 *
 *   1. Represent structure   — typed nodes (subsystem / capability / resource)
 *                              and typed edges (depends-on), validated on insert.
 *   2. Carry live health     — every node has a status the introspection layer
 *                              writes; the graph never invents health, it stores it.
 *   3. Localize a fault      — given a failing leaf, walk dependency edges UP to
 *                              the deepest failing root cause, not the symptom.
 *   4. Compute blast radius  — given a failing node, walk edges DOWN to every
 *                              capability that transitively depends on it.
 *
 * Failure localization is the load-bearing query: a 404-ing tool and a dead
 * endpoint look identical at the symptom layer ("music won't play"), but the
 * graph distinguishes "the tool is broken" from "the resource the tool depends
 * on is broken" — which is the difference between fixing the right thing and
 * thrashing the wrong one.
 *
 * Run it:
 *   node self-model-graph.ts --demo     # Node 24+ strips TS types natively
 *   npx tsx self-model-graph.ts --demo
 *
 * Node.js built-ins only. No network, no persistence — the graph is an
 * in-memory object so the whole model can be read and run in one pass.
 */

// ─────────────────────────────────────────────────────────────────────────
// (1) Structure — typed nodes and edges.
//
// Three node kinds, because they fail and are fixed differently:
//   • subsystem — an internal component (router, dispatcher, memory store).
//   • capability — something the agent can DO (a tool/skill), owned by a
//     subsystem; this is what a user actually invokes.
//   • resource — an external dependency (an endpoint, a DB, a provider) that a
//     subsystem leans on but does not own.
// ─────────────────────────────────────────────────────────────────────────

type NodeKind = "subsystem" | "capability" | "resource";

type Health = "ok" | "degraded" | "down" | "unknown";

type SelfNode = {
  id: string;
  kind: NodeKind;
  /** Human-readable summary used in audit trails. */
  label: string;
  /** Live health, written by the introspection layer — never inferred here. */
  health: Health;
  /** Free-form evidence the introspection layer attached (last error, metric). */
  evidence: string | null;
  /** When health was last written (ms epoch); recency matters to callers. */
  updatedAt: number;
};

/** A directed "X depends on Y" edge: failure in `to` can degrade `from`. */
type DependsEdge = { from: string; to: string };

const HEALTH_RANK: Record<Health, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

function worse(a: Health, b: Health): Health {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────
// The self-model graph.
// ─────────────────────────────────────────────────────────────────────────

class SelfModelGraph {
  private nodes = new Map<string, SelfNode>();
  /** Adjacency: id -> set of ids it depends on. */
  private deps = new Map<string, Set<string>>();
  /** Reverse adjacency: id -> set of ids that depend on it. */
  private dependents = new Map<string, Set<string>>();
  now: () => number = () => Date.now();

  addNode(id: string, kind: NodeKind, label: string): this {
    if (this.nodes.has(id)) throw new Error(`duplicate node: ${id}`);
    this.nodes.set(id, { id, kind, label, health: "unknown", evidence: null, updatedAt: this.now() });
    this.deps.set(id, new Set());
    this.dependents.set(id, new Set());
    return this;
  }

  /** Declare that `from` depends on `to`. Both must already exist (no dangling). */
  addDependency(from: string, to: string): this {
    if (!this.nodes.has(from)) throw new Error(`unknown node: ${from}`);
    if (!this.nodes.has(to)) throw new Error(`unknown node: ${to}`);
    if (from === to) throw new Error(`a node cannot depend on itself: ${from}`);
    if (this.wouldCycle(from, to)) throw new Error(`dependency ${from}->${to} would create a cycle`);
    this.deps.get(from)!.add(to);
    this.dependents.get(to)!.add(from);
    return this;
  }

  /** The introspection layer calls this; the graph stores, it never guesses. */
  setHealth(id: string, health: Health, evidence: string | null = null): this {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    n.health = health;
    n.evidence = evidence;
    n.updatedAt = this.now();
    return this;
  }

  get(id: string): Readonly<SelfNode> {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    return n;
  }

  // ───────────────────────────────────────────────────────────────────────
  // (3) Failure localization — symptom -> root cause.
  //
  // Walk the dependency edges DOWN from a failing symptom toward its cause. At
  // each step descend into the dependency whose EFFECTIVE health is worst — so a
  // healthy-looking intermediate (a subsystem that probes "ok" but leans on a
  // dead resource) is still traversed THROUGH to the real culprit. The root
  // cause is the deepest node none of whose dependencies are effectively
  // failing. A tool that 404s because its endpoint is down localizes to the
  // endpoint (resource), not the tool — that is the whole point.
  // ───────────────────────────────────────────────────────────────────────

  localizeFault(symptomId: string): { rootCause: SelfNode; chain: SelfNode[] } {
    const start = this.nodes.get(symptomId);
    if (!start) throw new Error(`unknown node: ${symptomId}`);

    const chain: SelfNode[] = [];
    const seen = new Set<string>();
    let current = start;

    for (;;) {
      chain.push(current);
      seen.add(current.id);
      const failingDep = [...this.deps.get(current.id)!]
        .map((id) => this.nodes.get(id)!)
        // Follow effective health so a green intermediate is still traversed.
        .filter((n) => !seen.has(n.id) && isFailing(this.effectiveHealth(n.id)))
        // Prefer the worst effective health as the likeliest culprit, breaking
        // ties on the node's own declared health.
        .sort((a, b) =>
          HEALTH_RANK[this.effectiveHealth(b.id)] - HEALTH_RANK[this.effectiveHealth(a.id)] ||
          HEALTH_RANK[b.health] - HEALTH_RANK[a.health],
        )[0];
      if (!failingDep) break;
      current = failingDep;
    }
    return { rootCause: current, chain };
  }

  // ───────────────────────────────────────────────────────────────────────
  // (4) Blast radius — root cause -> everything it takes down.
  //
  // Walk the REVERSE edges DOWN from a node to find every capability that
  // transitively depends on it. This is what turns "the embedder is down" into
  // "recall_memory and semantic_search are unavailable" — the user-facing list.
  // ───────────────────────────────────────────────────────────────────────

  blastRadius(rootId: string): { affected: SelfNode[]; capabilities: SelfNode[] } {
    if (!this.nodes.has(rootId)) throw new Error(`unknown node: ${rootId}`);
    const affected: SelfNode[] = [];
    const seen = new Set<string>([rootId]);
    const queue = [...this.dependents.get(rootId)!];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = this.nodes.get(id)!;
      affected.push(n);
      for (const up of this.dependents.get(id)!) if (!seen.has(up)) queue.push(up);
    }
    return { affected, capabilities: affected.filter((n) => n.kind === "capability") };
  }

  // ───────────────────────────────────────────────────────────────────────
  // (2) Health rollup — a subsystem is only as healthy as its dependencies.
  //
  // The EFFECTIVE health of a node is the worst of its own declared health and
  // the effective health of everything it depends on. A subsystem that probes
  // "ok" but depends on a "down" resource is effectively degraded — the rollup
  // surfaces that without the introspection layer having to know the topology.
  // ───────────────────────────────────────────────────────────────────────

  effectiveHealth(id: string): Health {
    return this.rollup(id, new Set());
  }

  private rollup(id: string, stack: Set<string>): Health {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    if (stack.has(id)) return n.health; // cycle guard (addDependency prevents these)
    stack.add(id);
    let h = n.health;
    for (const dep of this.deps.get(id)!) h = worse(h, this.rollup(dep, stack));
    stack.delete(id);
    return h;
  }

  /** A compact, injectable self-summary — the block a prompt would carry. */
  summarize(): string {
    const lines: string[] = [];
    for (const n of this.nodes.values()) {
      const eff = this.effectiveHealth(n.id);
      const flag = eff === "ok" ? "  " : eff === "unknown" ? "? " : "! ";
      const note = eff !== n.health ? ` (self:${n.health}, effective:${eff})` : "";
      lines.push(`${flag}[${n.kind}] ${n.id} — ${eff}${note}`);
    }
    return lines.join("\n");
  }

  private wouldCycle(from: string, to: string): boolean {
    // Adding from->to creates a cycle iff `from` is already reachable from `to`.
    const seen = new Set<string>();
    const queue = [to];
    while (queue.length) {
      const id = queue.shift()!;
      if (id === from) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of this.deps.get(id) ?? []) queue.push(dep);
    }
    return false;
  }
}

function isFailing(h: Health): boolean {
  return h === "degraded" || h === "down";
}

// ─────────────────────────────────────────────────────────────────────────
// A self-model of an example agent, used by the demo.
// ─────────────────────────────────────────────────────────────────────────

function buildDemoSelfModel(): SelfModelGraph {
  const g = new SelfModelGraph();
  // Subsystems
  g.addNode("router", "subsystem", "LLM router / fallback chain");
  g.addNode("dispatcher", "subsystem", "tool dispatcher");
  g.addNode("memory", "subsystem", "pgvector agent memory");
  g.addNode("agent_bridge", "subsystem", "agent bridge / turn loop");
  // Resources (external dependencies)
  g.addNode("cloud_model", "resource", "active cloud model provider");
  g.addNode("embedder", "resource", "embedding endpoint");
  g.addNode("audio_endpoint", "resource", "music/audio search endpoint");
  // Capabilities (what the user invokes)
  g.addNode("answer", "capability", "answer a question");
  g.addNode("recall_memory", "capability", "recall a stored memory");
  g.addNode("play_audio", "capability", "play a track");

  // Dependencies (X depends on Y)
  g.addDependency("router", "cloud_model");
  g.addDependency("memory", "embedder");
  g.addDependency("dispatcher", "router");
  g.addDependency("agent_bridge", "router");
  g.addDependency("agent_bridge", "dispatcher");
  g.addDependency("answer", "agent_bridge");
  g.addDependency("recall_memory", "memory");
  g.addDependency("recall_memory", "dispatcher");
  g.addDependency("play_audio", "dispatcher");
  g.addDependency("play_audio", "audio_endpoint");

  // All green by default.
  for (const id of ["router", "dispatcher", "memory", "agent_bridge", "cloud_model", "embedder", "audio_endpoint", "answer", "recall_memory", "play_audio"]) {
    g.setHealth(id, "ok");
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  banner("Scenario 1 — healthy self-model: structure + rollup");
  {
    const g = buildDemoSelfModel();
    console.log(g.summarize());
  }

  banner("Scenario 2 — embedder down → localize fault, then blast radius");
  {
    const g = buildDemoSelfModel();
    // Symptom the user reports: recall_memory keeps failing.
    g.setHealth("recall_memory", "down", "recall returns 0 hits");
    // Introspection found the real failing dependency:
    g.setHealth("embedder", "down", "ECONNREFUSED 127.0.0.1:11434");

    const { rootCause, chain } = g.localizeFault("recall_memory");
    console.log("  symptom : recall_memory");
    console.log("  chain   : " + chain.map((n) => n.id).join(" -> "));
    console.log(`  ROOT    : ${rootCause.id} (${rootCause.kind}) — ${rootCause.evidence}`);

    const { capabilities } = g.blastRadius("embedder");
    console.log("  capabilities affected by embedder being down:");
    for (const c of capabilities) console.log(`    • ${c.id} — ${c.label}`);
    console.log("  (note: play_audio and answer are NOT in the list — correct.)");
  }

  banner("Scenario 3 — symptom vs root cause: play_audio fails, endpoint is the cause");
  {
    const g = buildDemoSelfModel();
    g.setHealth("play_audio", "degraded", "audio card never reaches PLAYING");
    g.setHealth("audio_endpoint", "down", "owner-blocked embed / dead fallback");
    const { rootCause } = g.localizeFault("play_audio");
    console.log(`  user blames : play_audio (the capability)`);
    console.log(`  real cause  : ${rootCause.id} (${rootCause.kind}) — fix THIS, not the tool`);
  }

  banner("Scenario 4 — effective-health rollup: a green subsystem reads degraded");
  {
    const g = buildDemoSelfModel();
    g.setHealth("cloud_model", "degraded", "provider 401 / rate-limited");
    // agent_bridge itself is 'ok' but depends (via router) on the degraded model.
    console.log(`  agent_bridge declared health : ${g.get("agent_bridge").health}`);
    console.log(`  agent_bridge effective health: ${g.effectiveHealth("agent_bridge")}  <- rolled up from cloud_model`);
    console.log("\n  full rollup:");
    console.log(g.summarize());
  }

  banner("Scenario 5 — structural guards: no dangling edges, no cycles");
  {
    const g = buildDemoSelfModel();
    try { g.addDependency("router", "does_not_exist"); }
    catch (e) { console.log("  rejected dangling edge:  " + (e as Error).message); }
    try { g.addDependency("cloud_model", "answer"); } // would close a loop
    catch (e) { console.log("  rejected cyclic edge:    " + (e as Error).message); }
  }

  console.log("\nDone. The self-model stores health it is GIVEN, localizes a symptom to its");
  console.log("deepest failing dependency, and computes exactly which capabilities a fault");
  console.log("takes down — the structure self-repair and governance read before they act.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { SelfModelGraph, buildDemoSelfModel };
export type { SelfNode, DependsEdge, NodeKind, Health };
