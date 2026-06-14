// Guide 73 — Reflective Runtime
//
// A minimal, dependency-free reference runtime that wires the Layer-2
// metacognition guides (66–72) onto the kernel loop (guide 00). One file,
// Node built-ins only.
//
//   Run with:  node reflective-runtime.ts
//         or:  npx tsx reflective-runtime.ts
//
// The other guides each describe one primitive in isolation. This is the
// integration: a single runnable loop that shows the primitives *composing*.
// It is deliberately ~500 lines and deterministic (a logical clock, no wall
// time, no randomness) so the trace reproduces byte-for-byte. It is a
// reference for the *shape* of the wiring, not a production runtime.
//
// What it demonstrates, in one loop:
//   - kernel loop         runTurn(): route -> score -> govern -> dispatch -> remember -> reflect
//   - memory read/write   a salience store with kinds + a consolidation pass   (guides 06/07/71)
//   - reflection cycle    a self-model graph that localizes a fault to a root  (guides 66/67)
//   - uncertainty         calibrated confidence -> act / escalate / abstain    (guide 68)
//   - capability registry tools gated by authority band + status, grown by gap (guides 37/69)
//   - self-repair hooks   fix a fault on a clone, verify, human-merge, recall  (guide 66)

// ============================================================================
// Shared vocabulary
// ============================================================================

type Risk = "low" | "medium" | "high" | "critical";
type Band = "read" | "prepare" | "write" | "irreversible";
type NodeKind = "subsystem" | "capability" | "resource";
type MemKind = "short" | "episodic" | "semantic" | "self";

const BAND_LEVEL: Record<Band, number> = {
  read: 0,
  prepare: 1,
  write: 2,
  irreversible: 3,
};

function clamp01(x: number): number {
  return Math.max(1e-6, Math.min(1, x));
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t.length > 1) out.add(t);
  return out;
}

function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// ============================================================================
// Memory — short / episodic / semantic / self, with a consolidation pass
// (guides 06 salience, 07 reflective sorting, 71 consolidation)
// ============================================================================

interface Mem {
  id: string;
  text: string;
  kind: MemKind;
  salience: number; // intrinsic importance in [0,1]
  uses: number; // recall reinforcement
  bornAt: number; // logical tick
  lastAt: number; // logical tick of last touch
  sessions: Set<number>; // distinct sessions that corroborated this
  pinned: boolean;
}

class Memory {
  items: Mem[] = [];
  private seq = 0;
  private halfLife = 40; // ticks
  private forgetFloor = 0.18;

  remember(
    text: string,
    kind: MemKind,
    salience: number,
    session: number,
    now: number,
  ): Mem {
    const m: Mem = {
      id: `m${++this.seq}`,
      text,
      kind,
      salience: clamp01(salience),
      uses: 0,
      bornAt: now,
      lastAt: now,
      sessions: new Set([session]),
      pinned: false,
    };
    this.items.push(m);
    return m;
  }

  private recency(m: Mem, now: number): number {
    return Math.pow(0.5, Math.max(0, now - m.lastAt) / this.halfLife);
  }

  // READ: blend lexical similarity, recency, usage, and intrinsic salience.
  recall(query: string, k: number, now: number): Mem[] {
    const scored = this.items.map((m) => {
      const sim = jaccard(query, m.text);
      const usage = m.uses / (m.uses + 1);
      const score =
        0.45 * sim + 0.2 * this.recency(m, now) + 0.1 * usage + 0.25 * m.salience;
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    for (const s of top) {
      s.m.uses++;
      s.m.lastAt = now;
    }
    return top.map((s) => s.m);
  }

  // The consolidation "sleep" pass: forget noise, fuse duplicates, promote
  // what recurs across distinct sessions into durable semantic lessons.
  consolidate(now: number): { forgot: number; merged: number; promoted: number } {
    let forgot = 0;
    let merged = 0;
    let promoted = 0;

    // 1. Forget: low effective score, unless pinned.
    this.items = this.items.filter((m) => {
      if (m.pinned || m.kind === "semantic") return true;
      const eff = 0.55 * m.salience + 0.3 * this.recency(m, now) + 0.15 * (m.uses / (m.uses + 1));
      if (eff < this.forgetFloor) {
        forgot++;
        return false;
      }
      return true;
    });

    // 2. Dedupe: fuse near-duplicates (token-set Jaccard >= 0.6), anchored on
    //    the strongest phrasing. Corroboration accumulates as evidence.
    const survivors: Mem[] = [];
    const consumed = new Set<string>();
    const byStrength = [...this.items].sort((a, b) => b.salience - a.salience);
    for (const anchor of byStrength) {
      if (consumed.has(anchor.id)) continue;
      for (const other of byStrength) {
        if (other.id === anchor.id || consumed.has(other.id)) continue;
        if (jaccard(anchor.text, other.text) >= 0.6) {
          anchor.salience = clamp01(anchor.salience + 0.06);
          anchor.uses += other.uses;
          for (const s of other.sessions) anchor.sessions.add(s);
          anchor.lastAt = Math.max(anchor.lastAt, other.lastAt);
          consumed.add(other.id);
          merged++;
        }
      }
      survivors.push(anchor);
    }
    this.items = survivors;

    // 3. Promote: corroboration across >= 3 distinct sessions graduates an
    //    episodic memory into a pinned, high-salience semantic lesson.
    for (const m of this.items) {
      if (m.kind !== "semantic" && m.sessions.size >= 3) {
        m.kind = "semantic";
        m.pinned = true;
        m.salience = Math.max(m.salience, 0.9);
        promoted++;
      }
    }
    return { forgot, merged, promoted };
  }

  count(kind?: MemKind): number {
    return kind ? this.items.filter((m) => m.kind === kind).length : this.items.length;
  }
}

// ============================================================================
// Self-model graph — what the agent is made of, and what is broken right now
// (guide 67), the structure the repair loop reasons over (guide 66)
// ============================================================================

interface SNode {
  id: string;
  kind: NodeKind;
  healthy: boolean;
  note: string;
}

class SelfModel {
  nodes = new Map<string, SNode>();
  edges: Array<{ from: string; to: string }> = []; // "from depends-on to"

  add(id: string, kind: NodeKind, note = ""): this {
    this.nodes.set(id, { id, kind, healthy: true, note });
    return this;
  }

  // Edges are validated on insert: endpoints must exist and no cycle may form,
  // because a self-model with a dependency cycle has no well-defined root cause.
  link(from: string, to: string): this {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`link endpoints must exist: ${from} -> ${to}`);
    }
    if (this.reaches(to, from)) throw new Error(`cycle: ${from} -> ${to}`);
    this.edges.push({ from, to });
    return this;
  }

  private deps(id: string): string[] {
    return this.edges.filter((e) => e.from === id).map((e) => e.to);
  }

  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop() as string;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...this.deps(n));
    }
    return false;
  }

  setHealth(id: string, healthy: boolean, note = ""): void {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    n.healthy = healthy;
    if (note) n.note = note;
  }

  // Failure localization: descend from a symptom into its unhealthy
  // dependencies and return the deepest one — the actual root cause, not an
  // intermediate that looks fine on its own.
  rootCause(id: string): SNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node: ${id}`);
    for (const dep of this.deps(id)) {
      const dn = this.nodes.get(dep) as SNode;
      if (!dn.healthy) return this.rootCause(dep);
    }
    return n;
  }

  // Blast radius: which capabilities does a given fault take down?
  blastRadius(id: string): string[] {
    const out: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === "capability" && this.reaches(node.id, id)) out.push(node.id);
    }
    return out;
  }

  clone(): SelfModel {
    const c = new SelfModel();
    for (const n of this.nodes.values()) {
      c.nodes.set(n.id, { ...n });
    }
    c.edges = this.edges.map((e) => ({ ...e }));
    return c;
  }

  render(): string {
    return [...this.nodes.values()]
      .map((n) => `  [${n.kind[0]}] ${n.id}: ${n.healthy ? "ok" : "DOWN"}${n.note ? ` (${n.note})` : ""}`)
      .join("\n");
  }
}

// ============================================================================
// Calibrated uncertainty — one honest number, then act / escalate / abstain
// against a floor that scales with the stakes (guide 68)
// ============================================================================

interface Evidence {
  corroboration: number; // independent sources that agree
  freshness: number; // how current the data is
  priorReliability: number; // measured track record on this kind of claim
  support: number; // how much evidence backs it
}

type Decision = "act" | "escalate" | "abstain";

class Uncertainty {
  private bins = Array.from({ length: 10 }, () => ({ correct: 0, n: 0 }));
  private log: Array<{ conf: number; correct: boolean }> = [];
  private floors: Record<Risk, number> = {
    low: 0.5,
    medium: 0.65,
    high: 0.8,
    critical: 0.92,
  };
  private escalateBand = 0.1;

  // Weighted GEOMETRIC mean: a single near-zero factor (no corroboration at
  // all) drags the whole score down instead of being averaged away.
  score(e: Evidence): number {
    const factors: Array<[number, number]> = [
      [e.corroboration, 1.2],
      [e.freshness, 0.8],
      [e.priorReliability, 1.0],
      [e.support, 1.0],
    ];
    let acc = 0;
    let wsum = 0;
    for (const [v, w] of factors) {
      acc += w * Math.log(clamp01(v));
      wsum += w;
    }
    return Math.exp(acc / wsum);
  }

  // Bend a raw confidence toward the measured hit rate of its bin, blended by
  // how much data the bin has (Laplace-smoothed; trusts the prior when thin).
  calibrate(raw: number): number {
    const b = this.bins[Math.min(9, Math.floor(raw * 10))];
    if (b.n === 0) return raw;
    const empirical = (b.correct + 1) / (b.n + 2); // Laplace toward 0.5
    const trust = b.n / (b.n + 5);
    return trust * empirical + (1 - trust) * raw;
  }

  decide(conf: number, risk: Risk): Decision {
    const floor = this.floors[risk];
    if (conf >= floor) return "act";
    if (conf >= floor - this.escalateBand) return "escalate";
    return "abstain";
  }

  record(conf: number, correct: boolean): void {
    const b = this.bins[Math.min(9, Math.floor(conf * 10))];
    b.n++;
    if (correct) b.correct++;
    this.log.push({ conf, correct });
  }

  // Lower is better: mean squared error of confidence vs. outcome.
  brier(): number {
    if (this.log.length === 0) return 0;
    let s = 0;
    for (const r of this.log) s += (r.conf - (r.correct ? 1 : 0)) ** 2;
    return s / this.log.length;
  }
}

// ============================================================================
// Governance — authority bands + named grants (guide 37)
// ============================================================================

class Governance {
  maxBand: Band = "read";
  private grants = new Set<string>();

  setMaxBand(b: Band): void {
    this.maxBand = b;
  }
  allowsBand(b: Band): boolean {
    return BAND_LEVEL[b] <= BAND_LEVEL[this.maxBand];
  }
  grant(name: string): void {
    this.grants.add(name);
  }
  revoke(name: string): void {
    this.grants.delete(name);
  }
  has(name: string): boolean {
    return this.grants.has(name);
  }
}

// ============================================================================
// Capability registry — tools gated by authority band + status (guide 37/69)
// ============================================================================

interface Capability {
  name: string;
  triggers: string[];
  band: Band;
  status: "active" | "proposed";
  needs?: string[]; // self-model nodes this capability depends on
  run: (intent: string) => unknown;
}

class Registry {
  caps = new Map<string, Capability>();

  register(c: Capability): void {
    this.caps.set(c.name, c);
  }

  // Route only among ACTIVE capabilities; a proposed-but-unapproved tool is
  // unreachable until a human turns it on.
  route(intent: string): Capability | null {
    const lower = intent.toLowerCase();
    let best: Capability | null = null;
    let bestScore = 0;
    for (const c of this.caps.values()) {
      if (c.status !== "active") continue;
      let score = 0;
      for (const t of c.triggers) if (lower.includes(t)) score++;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }
}

// A tiny synthesis library: how the agent drafts a tool for a recurring gap.
// Each entry carries its own generated test cases — a candidate must pass all
// of them before it can even be proposed (guide 69).
interface Synth {
  match: (intent: string) => boolean;
  draft: () => Capability;
  tests: Array<{ intent: string; expect: number }>;
}

const SYNTH_LIBRARY: Synth[] = [
  {
    match: (i) => /percent|what percent|% of/.test(i.toLowerCase()),
    draft: () => ({
      name: "percent",
      triggers: ["percent", "% of"],
      band: "read",
      status: "proposed",
      run: (intent: string) => {
        const nums = (intent.match(/\d+(\.\d+)?/g) ?? []).map(Number);
        const [x, y] = nums;
        return y ? (x / y) * 100 : 0;
      },
    }),
    tests: [
      { intent: "what percent is 30 of 200", expect: 15 },
      { intent: "what percent is 1 of 4", expect: 25 },
    ],
  },
];

// ============================================================================
// The reflective runtime — the loop that threads all of the above
// ============================================================================

interface TurnResult {
  status: "ok" | "abstained" | "escalated" | "denied" | "no-tool" | "proposed";
  detail: string;
  output?: unknown;
  confidence?: number;
}

class ReflectiveRuntime {
  memory = new Memory();
  self = new SelfModel();
  uncertainty = new Uncertainty();
  governance = new Governance();
  registry = new Registry();

  private tick = 0;
  session = 1;
  private gaps = new Map<string, number>();
  private gapThreshold = 2;
  private lastRepairAt = new Map<string, number>();
  private repairCooldown = 5; // ticks; a re-fix inside this window is "flapping"
  private remedies = new Map<string, string>(); // nodeId -> remedy label

  registerRemedy(nodeId: string, label: string): void {
    this.remedies.set(nodeId, label);
  }

  // One agent turn: route -> score -> govern -> dispatch -> remember -> reflect.
  async runTurn(
    intent: string,
    opts: { risk?: Risk; evidence: Evidence; approve?: boolean },
  ): Promise<TurnResult> {
    this.tick++;
    const risk = opts.risk ?? "low";

    // 1. ROUTE. No active tool => count the gap; acquire if it recurs.
    const cap = this.registry.route(intent);
    if (!cap) {
      return this.handleGap(intent);
    }

    // 2. SCORE. Calibrated confidence -> act / escalate / abstain by risk.
    const raw = this.uncertainty.score(opts.evidence);
    const conf = this.uncertainty.calibrate(raw);
    const decision = this.uncertainty.decide(conf, risk);
    if (decision === "abstain") {
      return { status: "abstained", detail: `conf ${conf.toFixed(2)} below ${risk} floor`, confidence: conf };
    }
    if (decision === "escalate" && !opts.approve) {
      return { status: "escalated", detail: `conf ${conf.toFixed(2)} in ${risk} escalation band`, confidence: conf };
    }

    // 3. GOVERN. The capability's authority band must be granted.
    if (!this.governance.allowsBand(cap.band)) {
      return { status: "denied", detail: `band '${cap.band}' exceeds granted '${this.governance.maxBand}'`, confidence: conf };
    }

    // 4. DISPATCH — with a reflect-and-repair hook on failure.
    let value: unknown;
    try {
      value = this.dispatch(cap, intent);
    } catch (err) {
      const fault = err as Error & { code?: string; dep?: string };
      // Only a dependency-health fault enters reflection. Any other tool error
      // (a logic bug, a bad argument) fails closed rather than being
      // misdiagnosed as an outage and "repaired".
      const repaired =
        fault.code === "DEP_DOWN" && fault.dep
          ? this.reflectAndRepair(cap, fault.dep, String(err))
          : null;
      if (!repaired || !repaired.repaired) {
        this.uncertainty.record(conf, false);
        return {
          status: repaired?.escalate ? "escalated" : "denied",
          detail: repaired ? repaired.detail : `dispatch failed: ${String(err)}`,
          confidence: conf,
        };
      }
      // Retry once after a verified, human-merged repair.
      value = this.dispatch(cap, intent);
    }

    // 5. REMEMBER. Episodic record of the outcome; calibration learns from it.
    this.memory.remember(`turn: "${intent}" -> ${cap.name} = ${JSON.stringify(value)}`, "episodic", 0.55, this.session, this.tick);
    this.uncertainty.record(conf, true);
    return { status: "ok", detail: `${cap.name} ran`, output: value, confidence: conf };
  }

  private dispatch(cap: Capability, intent: string): unknown {
    // Health-check every declared dependency. A down dependency is a *tagged*
    // fault so the loop can tell it apart from an ordinary tool-logic error.
    for (const dep of cap.needs ?? []) {
      const node = this.self.nodes.get(dep);
      if (node && !node.healthy) {
        const e = new Error(`dependency ${dep} is down`) as Error & { code?: string; dep?: string };
        e.code = "DEP_DOWN";
        e.dep = dep;
        throw e;
      }
    }
    return cap.run(intent);
  }

  // The metacognitive self-repair loop: localize the fault, fix it on a CLONE,
  // verify the clone, then land it only behind a human merge — and remember.
  private reflectAndRepair(
    cap: Capability,
    failingDep: string,
    err: string,
  ): { repaired: boolean; escalate?: boolean; detail: string } {
    // Localize from the dependency that actually failed: descend the self-model
    // to the deepest unhealthy node (the root cause), then report blast radius.
    const root = this.self.rootCause(failingDep);
    const blast = this.self.blastRadius(root.id);
    this.memory.remember(`diagnosis: "${cap.name}" failed (${err}); root cause ${root.id}; blast ${blast.join(",")}`, "self", 0.7, this.session, this.tick);

    // Temporal awareness: a fault re-fixed seconds ago is flapping — escalate
    // instead of looping.
    const last = this.lastRepairAt.get(root.id);
    if (last !== undefined && this.tick - last < this.repairCooldown) {
      return { repaired: false, escalate: true, detail: `root ${root.id} is flapping; escalating to a human` };
    }

    const remedy = this.remedies.get(root.id);
    if (!remedy) return { repaired: false, detail: `no known remedy for ${root.id}` };

    // Memory-driven adaptation: have we landed this exact remedy before?
    const priorFix = this.memory.recall(`remedy ${root.id}`, 1, this.tick).find((m) => m.kind === "self" && m.text.includes(`remedy ${root.id}`));

    // Apply the remedy on a throwaway clone — the live self-model is untouched
    // until the fix is proven.
    const branch = this.self.clone();
    branch.setHealth(root.id, true, `repaired: ${remedy}`);
    const verified = branch.rootCause(failingDep).healthy;
    if (!verified) return { repaired: false, detail: `remedy did not clear ${root.id} on the branch` };

    // Governance-gated healing: diagnosis is autonomous, LANDING is not.
    if (!this.governance.has("self-repair.merge")) {
      return { repaired: false, escalate: true, detail: `verified fix for ${root.id} awaits human merge` };
    }

    // Merge the verified branch into the live model and remember the remedy.
    this.self.setHealth(root.id, true, `repaired: ${remedy}`);
    this.lastRepairAt.set(root.id, this.tick);
    this.memory.remember(`remedy ${root.id}: ${remedy}${priorFix ? " (recalled)" : ""}`, "self", 0.85, this.session, this.tick);
    return { repaired: true, detail: `${root.id} repaired via ${remedy}${priorFix ? " (known-good, recalled from memory)" : ""}` };
  }

  // Capability acquisition: a gap earned by recurrence is drafted on a clone,
  // proven against generated tests, and registered INERT until a human
  // approves it and assigns an authority band (guide 69).
  private handleGap(intent: string): TurnResult {
    const n = (this.gaps.get(intent) ?? 0) + 1;
    this.gaps.set(intent, n);
    if (n < this.gapThreshold) {
      return { status: "no-tool", detail: `no tool for intent (gap seen ${n}x)` };
    }
    const synth = SYNTH_LIBRARY.find((s) => s.match(intent));
    if (!synth) return { status: "no-tool", detail: `recurring gap but no synthesis recipe` };

    const candidate = synth.draft();
    // Verify on a clone: the candidate must pass ALL generated tests.
    for (const t of synth.tests) {
      if (Math.abs(Number(candidate.run(t.intent)) - t.expect) > 1e-9) {
        this.memory.remember(`rejected capability ${candidate.name}: failed its own tests`, "self", 0.6, this.session, this.tick);
        return { status: "no-tool", detail: `candidate ${candidate.name} failed verification` };
      }
    }
    this.registry.register(candidate); // status: "proposed" — unreachable until approved
    this.memory.remember(`proposed capability ${candidate.name} (inert, awaiting human approval)`, "self", 0.7, this.session, this.tick);
    return { status: "proposed", detail: `drafted + verified '${candidate.name}'; awaiting human approval` };
  }

  // The human act: approve a proposed tool and assign it an authority band.
  approveCapability(name: string, band: Band): boolean {
    const c = this.registry.caps.get(name);
    if (!c || c.status !== "proposed") return false;
    c.status = "active";
    c.band = band;
    this.memory.remember(`approved ${name} at band '${band}'`, "self", 0.8, this.session, this.tick);
    return true;
  }

  consolidate(): { forgot: number; merged: number; promoted: number } {
    return this.memory.consolidate(this.tick);
  }

  context(query: string): string {
    const mems = this.memory.recall(query, 3, this.tick);
    return mems.length ? mems.map((m) => `  - [${m.kind}] ${m.text}`).join("\n") : "  (none)";
  }
}

// ============================================================================
// Demo — one scenario that drives every path
// ============================================================================

async function main(): Promise<void> {
  const rt = new ReflectiveRuntime();

  // Self-model: a small dependency graph the agent has of *itself*.
  rt.self
    .add("router", "subsystem")
    .add("memory", "subsystem")
    .add("llm", "resource", "primary endpoint")
    .add("summarize", "capability")
    .add("recall", "capability");
  rt.self.link("summarize", "llm"); // summarize depends-on the llm endpoint
  rt.self.link("summarize", "router");
  rt.self.link("recall", "memory");
  rt.registerRemedy("llm", "repoint to backup endpoint");

  // Capabilities: a read tool and an irreversible spend tool.
  rt.registry.register({
    name: "summarize",
    triggers: ["summarize", "summary"],
    band: "read",
    status: "active",
    needs: ["llm", "router"],
    run: () => "（summary）3 bullet points",
  });
  rt.registry.register({
    name: "transfer",
    triggers: ["send", "transfer", "pay"],
    band: "irreversible",
    status: "active",
    run: (intent) => ({ sent: true, intent }),
  });

  const strong: Evidence = { corroboration: 0.9, freshness: 0.9, priorReliability: 0.85, support: 0.9 };
  const thin: Evidence = { corroboration: 0.2, freshness: 0.5, priorReliability: 0.5, support: 0.3 };

  const show = (label: string, r: TurnResult) =>
    console.log(`  ${label.padEnd(34)} ${r.status.toUpperCase().padEnd(10)} ${r.detail}${r.output !== undefined ? ` => ${JSON.stringify(r.output)}` : ""}`);

  // Warm up the calibrator so a later 0.9 has a track record to be bent against.
  for (let i = 0; i < 10; i++) rt.uncertainty.record(0.9, i < 6); // historic 0.9 only hit 6/10

  console.log("=== 1. Confidence gates the action by stakes ===");
  rt.governance.setMaxBand("read");
  show("summarize (low risk, strong)", await rt.runTurn("summarize this thread", { risk: "low", evidence: strong }));
  show("transfer (critical, thin)", await rt.runTurn("send 2 eth to alice", { risk: "critical", evidence: thin }));
  show("transfer (critical, strong)", await rt.runTurn("send 2 eth to alice", { risk: "critical", evidence: strong }));

  console.log("\n=== 2. Authority band gates the write ===");
  show("transfer w/ read band", await rt.runTurn("send 1 eth", { risk: "critical", evidence: strong, approve: true }));
  rt.governance.setMaxBand("irreversible");
  show("transfer w/ irreversible band", await rt.runTurn("send 1 eth", { risk: "critical", evidence: strong, approve: true }));

  console.log("\n=== 3. A fault triggers reflect-and-repair ===");
  rt.self.setHealth("llm", false, "endpoint moved");
  console.log("  (llm endpoint goes down; summarize now depends on a dead resource)");
  show("summarize (no merge grant)", await rt.runTurn("summarize this thread", { risk: "low", evidence: strong }));
  rt.governance.grant("self-repair.merge");
  console.log("  (human grants self-repair.merge)");
  show("summarize (merge granted)", await rt.runTurn("summarize this thread", { risk: "low", evidence: strong }));

  console.log("\n=== 4. A recurring gap grows a new capability ===");
  show("percent (1st time)", await rt.runTurn("what percent is 30 of 200", { risk: "low", evidence: strong }));
  show("percent (2nd time -> draft)", await rt.runTurn("what percent is 30 of 200", { risk: "low", evidence: strong }));
  console.log("  (human approves the proposed tool at the 'read' band)");
  rt.approveCapability("percent", "read");
  show("percent (now active)", await rt.runTurn("what percent is 30 of 200", { risk: "low", evidence: strong }));

  console.log("\n=== 5. Memory consolidation ('sleep') ===");
  // Simulate the same lesson recurring across distinct sessions.
  for (const s of [2, 3, 4]) {
    rt.session = s;
    await rt.runTurn("summarize this thread", { risk: "low", evidence: strong });
  }
  const before = rt.memory.count();
  const c = rt.consolidate();
  console.log(`  items ${before} -> ${rt.memory.count()}  (forgot ${c.forgot}, merged ${c.merged}, promoted ${c.promoted} to semantic)`);

  console.log("\n=== Self-model ===");
  console.log(rt.self.render());
  console.log(`\n  calibration Brier score: ${rt.uncertainty.brier().toFixed(3)} (lower = more honest)`);
  console.log("\n=== Context block the agent would inject (query: 'summarize') ===");
  console.log(rt.context("summarize thread"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
