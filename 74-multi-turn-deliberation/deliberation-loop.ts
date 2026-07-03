/**
 * Multi-Turn Deliberation & Multi-Step Planning — reference implementation.
 *
 * A single-turn agent re-derives its intent from scratch every turn and forgets
 * what it was doing the moment the turn ends. This is the layer that lets an
 * agent think LONGER than one turn: hold one intent across many turns, decompose
 * it into a plan graph, run it a subgoal at a time, re-check the assumptions each
 * subgoal rests on as new information arrives, repair the plan when one breaks,
 * and exit cleanly when risk spikes or confidence collapses.
 *
 * The five things multi-turn deliberation has to do:
 *
 *   1. Carry intent across turns  — one deliberation buffer (root goal, plan,
 *                                   confidence, a logical clock, a log) persists
 *                                   across every step; continuity is a data
 *                                   structure you keep, not a hope.
 *   2. Decompose into a graph     — subgoals declare dependencies; the engine
 *                                   runs the first READY subgoal each turn, so
 *                                   parallel branches interleave and blocked
 *                                   ones wait.
 *   3. Monitor assumptions        — before executing a subgoal, re-read the world
 *                                   fact it assumes against the LIVE world, not
 *                                   the world the plan was drafted against.
 *   4. Repair, don't restart      — when an assumption breaks, splice an enabler
 *                                   in before the failing subgoal and re-deliberate
 *                                   next turn; work already done is preserved.
 *   5. Terminate explicitly       — succeeded / failed / escalated (risk ceiling,
 *                                   pause for a human, no side effect) / abandoned
 *                                   (confidence collapsed).
 *
 * This is the multi-turn counterpart to guide 73's single-turn reflective loop
 * and points guide 72's clone-before-commit repair forward across time.
 *
 * Run it:
 *   node deliberation-loop.ts --demo    # Node 24+ strips TS types natively
 *   npx tsx deliberation-loop.ts --demo
 *
 * Node.js built-ins only. Deterministic: a logical clock, no wall-time, no
 * randomness; new information arrives from a scripted tape so the trace
 * reproduces byte-for-byte.
 */

// ─────────────────────────────────────────────────────────────────────────
// The world. A flat map of the facts a plan's assumptions reference. In
// production this is a projection of the typed world-model graph (guide 46)
// kept fresh by the ambient snapshot bus (guide 47); here it is a plain object.
// ─────────────────────────────────────────────────────────────────────────

type World = Record<string, boolean | number>;

function demoWorld(overrides?: World): World {
  return {
    rootGoalValid: true,
    hasPasskey: false,
    hardwarePaired: false,
    destWhitelisted: false,
    networkUp: true,
    transferred: false,
    guardiansEnrolled: false,
    recoveryArmed: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// A subgoal. `deps` are other subgoal ids that must be `done` first; `assumes`
// is a world fact re-checked each turn before the subgoal runs; `risk` is the
// stakes of executing it (checked against the engine's ceiling).
// ─────────────────────────────────────────────────────────────────────────

type SubgoalStatus = "pending" | "done" | "failed";

type Subgoal = {
  id: string;
  goal: string;
  deps: string[];
  risk: number;
  assumes?: string;
  status: SubgoalStatus;
  reason?: string;
};

type PlanGraph = { rootGoal: string; nodes: Subgoal[] };

// The deliberation buffer — the single object that carries one intent across
// turns. This IS the agent's continuity.
type Deliberation = {
  rootGoal: string;
  plan: PlanGraph;
  turn: number; // logical clock
  confidence: number; // confidence the root goal is still worth pursuing
  status: "running" | "succeeded" | "failed" | "escalated" | "abandoned";
  log: string[];
};

// ─────────────────────────────────────────────────────────────────────────
// Effects: what executing a subgoal does to the world (pure, deterministic).
// Repairs: enabler subgoals keyed by the world fact they re-establish.
// ─────────────────────────────────────────────────────────────────────────

type Effects = Record<string, (w: World) => void>;

const REPAIRS: Record<string, Subgoal> = {
  networkUp: {
    id: "await_network",
    goal: "wait for the network to recover before transferring",
    deps: [],
    risk: 0.1,
    status: "pending",
  },
  hasPasskey: {
    id: "enroll_passkey",
    goal: "enroll a passkey (the floor for value transfers)",
    deps: [],
    risk: 0.2,
    status: "pending",
  },
};

const CONFIDENCE_FLOOR = 0.3;

// ─────────────────────────────────────────────────────────────────────────
// The engine.
// ─────────────────────────────────────────────────────────────────────────

class DeliberationEngine {
  private effects: Effects;
  private repairs: Record<string, Subgoal>;
  private riskCeiling: number;

  constructor(effects: Effects, repairs: Record<string, Subgoal> = REPAIRS, riskCeiling = 0.8) {
    this.effects = effects;
    this.repairs = repairs;
    this.riskCeiling = riskCeiling;
  }

  /** The first pending subgoal whose dependencies are all done. */
  private nextReady(plan: PlanGraph): Subgoal | undefined {
    return plan.nodes.find(
      (n) => n.status === "pending" && n.deps.every((d) => plan.nodes.find((x) => x.id === d)?.status === "done"),
    );
  }

  /** One turn of deliberation against the live world. Order matters:
   *  confidence → readiness → risk → assumptions → execute. */
  step(d: Deliberation, world: World): Deliberation {
    if (d.status !== "running") return d;
    d.turn++;

    // (5a) Confidence: has the root goal been invalidated by new information?
    if (world.rootGoalValid === false) d.confidence = 0.1;
    if (d.confidence < CONFIDENCE_FLOOR) {
      d.status = "abandoned";
      d.log.push(`t${d.turn}: confidence ${d.confidence.toFixed(2)} < floor — abandoning '${d.rootGoal}'`);
      return d;
    }

    // (2) Readiness: pick the first ready subgoal, or terminate.
    const node = this.nextReady(d.plan);
    if (!node) {
      const allDone = d.plan.nodes.every((n) => n.status === "done");
      d.status = allDone ? "succeeded" : "failed";
      d.log.push(`t${d.turn}: no ready subgoal — ${d.status}`);
      return d;
    }

    // (5b) Risk: a step over the ceiling pauses for a human — it never acts.
    if (node.risk > this.riskCeiling) {
      d.status = "escalated";
      d.log.push(`t${d.turn}: '${node.id}' risk ${node.risk} > ceiling ${this.riskCeiling} — escalating to human, NO side effect`);
      return d;
    }

    // (3) Assumption: re-check the world fact this subgoal rests on, live.
    if (node.assumes && !world[node.assumes]) {
      const enabler = this.repairs[node.assumes];
      if (enabler && !d.plan.nodes.some((n) => n.id === enabler.id)) {
        // (4) Repair: splice the enabler in before the failing subgoal.
        const idx = d.plan.nodes.indexOf(node);
        d.plan.nodes.splice(idx, 0, { ...enabler, status: "pending" });
        d.log.push(`t${d.turn}: assumption '${node.assumes}' broke for '${node.id}' — spliced repair '${enabler.id}'`);
        return d; // re-deliberate next turn
      }
      node.status = "failed";
      node.reason = `assumption '${node.assumes}' unmet, no repair available`;
      d.status = "failed";
      d.log.push(`t${d.turn}: '${node.id}' failed — ${node.reason}`);
      return d;
    }

    // (1)/(2) Execute: apply the subgoal's deterministic effect.
    this.effects[node.id]?.(world);
    node.status = "done";
    d.log.push(`t${d.turn}: executed '${node.id}' — ${node.goal}`);

    if (d.plan.nodes.every((n) => n.status === "done")) {
      d.status = "succeeded";
      d.log.push(`t${d.turn}: all subgoals done — '${d.rootGoal}' achieved`);
    }
    return d;
  }

  /** Drive deliberation across turns. `tape[t]` injects the new information that
   *  arrives at the start of turn t (a world delta). */
  run(d: Deliberation, world: World, tape: Array<(w: World) => void> = [], maxTurns = 24): Deliberation {
    for (let t = 0; t < maxTurns && d.status === "running"; t++) {
      tape[t]?.(world);
      this.step(d, world);
    }
    return d;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The concrete long-horizon intent for the demo:
//   "move savings to the hardware wallet and arm recovery"
// ─────────────────────────────────────────────────────────────────────────

function savingsPlan(transferRisk: number): PlanGraph {
  return {
    rootGoal: "move savings to hardware wallet and arm recovery",
    nodes: [
      { id: "verify_passkey", goal: "verify the passkey floor", deps: [], risk: 0.2, status: "pending" },
      { id: "pair_hardware", goal: "pair the hardware wallet", deps: [], risk: 0.3, status: "pending" },
      { id: "whitelist_dest", goal: "whitelist the destination", deps: ["verify_passkey", "pair_hardware"], risk: 0.3, assumes: "hasPasskey", status: "pending" },
      { id: "transfer_funds", goal: "transfer the savings (irreversible)", deps: ["whitelist_dest"], risk: transferRisk, assumes: "networkUp", status: "pending" },
      { id: "enroll_guardians", goal: "enroll recovery guardians", deps: [], risk: 0.3, status: "pending" },
      { id: "verify_quorum", goal: "verify the recovery quorum", deps: ["enroll_guardians"], risk: 0.2, assumes: "guardiansEnrolled", status: "pending" },
    ],
  };
}

const EFFECTS: Effects = {
  verify_passkey: (w) => { w.hasPasskey = true; },
  pair_hardware: (w) => { w.hardwarePaired = true; },
  whitelist_dest: (w) => { w.destWhitelisted = true; },
  transfer_funds: (w) => { w.transferred = true; },
  enroll_guardians: (w) => { w.guardiansEnrolled = true; },
  verify_quorum: (w) => { w.recoveryArmed = true; },
  await_network: (w) => { w.networkUp = true; },
  enroll_passkey: (w) => { w.hasPasskey = true; },
};

function freshDeliberation(plan: PlanGraph): Deliberation {
  return { rootGoal: plan.rootGoal, plan, turn: 0, confidence: 0.9, status: "running", log: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function printRun(d: Deliberation) {
  for (const line of d.log) console.log("    " + line);
  console.log(`  → status=${d.status}  turns=${d.turn}  confidence=${d.confidence.toFixed(2)}`);
}

function demo() {
  banner("Scenario 1 — happy path: one intent carried across turns to completion");
  {
    const engine = new DeliberationEngine(EFFECTS);
    const world = demoWorld();
    const d = freshDeliberation(savingsPlan(0.5));
    engine.run(d, world);
    printRun(d);
    console.log(`  world: transferred=${world.transferred} recoveryArmed=${world.recoveryArmed}`);
    console.log("  (the deliberation buffer held the plan across every turn — no intent amnesia.)");
  }

  banner("Scenario 2 — assumption breaks mid-plan: monitor catches it, repair splices an enabler");
  {
    const engine = new DeliberationEngine(EFFECTS);
    const world = demoWorld();
    const d = freshDeliberation(savingsPlan(0.5));
    // New information: the network drops at the start of turn 4, right before the transfer.
    const tape: Array<(w: World) => void> = [];
    tape[3] = (w) => { w.networkUp = false; };
    engine.run(d, world, tape);
    printRun(d);
    console.log(`  plan now: ${d.plan.nodes.map((n) => n.id).join(" → ")}`);
    console.log("  (the broken 'networkUp' assumption was repaired without discarding finished work.)");
  }

  banner("Scenario 3 — risk escalation: a high-stakes step pauses for a human, no side effect");
  {
    const engine = new DeliberationEngine(EFFECTS);
    const world = demoWorld();
    const d = freshDeliberation(savingsPlan(0.95)); // transfer now exceeds the ceiling
    engine.run(d, world);
    printRun(d);
    console.log(`  world: transferred=${world.transferred}  ← funds untouched; transfer left for human approval`);
  }

  banner("Scenario 4 — abandonment: new info invalidates the goal, confidence collapses");
  {
    const engine = new DeliberationEngine(EFFECTS);
    const world = demoWorld();
    const d = freshDeliberation(savingsPlan(0.5));
    // New information: the user already moved the funds elsewhere at the start of turn 2.
    const tape: Array<(w: World) => void> = [];
    tape[1] = (w) => { w.rootGoalValid = false; };
    engine.run(d, world, tape);
    printRun(d);
    console.log(`  world: transferred=${world.transferred}  ← nothing further executed after abandonment`);
  }

  console.log("\nDone. One intent was pursued across many turns: it completed a six-step plan, repaired");
  console.log("a broken assumption mid-flight, paused a high-stakes step for a human, and abandoned a");
  console.log("goal whose reason for existing had evaporated — all on a deterministic logical clock.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { DeliberationEngine, demoWorld, savingsPlan, freshDeliberation, EFFECTS, REPAIRS };
export type { World, Subgoal, PlanGraph, Deliberation, Effects };
