/**
 * World-Model & Belief State — reference implementation.
 *
 * An agent that stores facts as bare assertions (networkUp = true) can't tell a
 * hunch from a near-certainty, has no rule for how a new observation should move
 * a fact, can hold two facts that contradict each other without noticing, and
 * can't predict what it would believe after an action. This is the layer that
 * fixes all four: one belief state that holds facts WITH confidence, folds noisy
 * evidence in deterministically, catches contradictions, repairs them by weight,
 * and projects an action forward on a clone before committing.
 *
 * The five things a belief state has to do:
 *
 *   1. Hold confidence, not just facts — a belief is a value plus a confidence
 *                                        DERIVED from its evidence; you cannot
 *                                        set confidence by hand.
 *   2. Update from evidence            — each observation carries a source weight
 *                                        and whether it supports or contradicts;
 *                                        log-odds combination makes the update
 *                                        deterministic and calibratable.
 *   3. Check consistency               — explicit `contradicts` edges are walked
 *                                        to flag two beliefs that cannot both be
 *                                        true yet are both held confidently.
 *   4. Repair                          — merge corroborating duplicates and
 *                                        resolve contradictions by evidence
 *                                        weight, through the same math.
 *   5. Predict                         — clone the graph, apply an action's
 *                                        evidence, and read the projected
 *                                        confidences; the live state is untouched.
 *
 * This is the "space" the agent reasons over — it unifies guide 46's typed graph,
 * guide 68's calibrated confidence, and guide 72's clone-before-commit.
 *
 * Run it:
 *   node belief-state.ts --demo    # Node 24+ strips TS types natively
 *   npx tsx belief-state.ts --demo
 *
 * Node.js built-ins only. Deterministic: a logical clock, pure log-odds math,
 * no wall-time, no randomness.
 */

// ─────────────────────────────────────────────────────────────────────────
// Evidence & beliefs. All plain data so structuredClone gives a perfect copy
// for prediction. `weight` is the source's reliability in (0,1); `supports`
// says whether it argues FOR the belief's asserted value or against it.
// ─────────────────────────────────────────────────────────────────────────

type Evidence = { source: string; weight: number; supports: boolean; atTurn: number };

type Belief = {
  id: string;
  predicate: string;
  value: boolean; // the proposition asserted (confidence is P(this is true))
  confidence: number;
  evidence: Evidence[];
  updatedTurn: number;
};

type GraphState = {
  beliefs: Record<string, Belief>;
  contradicts: Array<[string, string]>;
  implies: Array<[string, string]>;
};

const CONSISTENCY_THRESHOLD = 0.7;

// ─────────────────────────────────────────────────────────────────────────
// The deterministic state estimator: fold weighted evidence into a confidence
// via log-odds. A neutral prior is 0.5 (log-odds 0); supporting evidence adds
// ln(w/(1-w)), contradicting evidence subtracts it; the logistic maps back.
// ─────────────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function confidenceFrom(evidence: Evidence[]): number {
  let logodds = 0;
  for (const e of evidence) {
    const w = clamp(e.weight, 0.01, 0.99);
    const term = Math.log(w / (1 - w));
    logodds += e.supports ? term : -term;
  }
  return 1 / (1 + Math.exp(-logodds));
}

function totalSupportingWeight(b: Belief): number {
  return b.evidence.filter((e) => e.supports).reduce((s, e) => s + e.weight, 0);
}

// ─────────────────────────────────────────────────────────────────────────
// An action for predictive simulation: a set of evidence to inject into target
// beliefs. Applying it to a CLONE of the graph yields the projected state.
// ─────────────────────────────────────────────────────────────────────────

type ActionEffect = { target: string; evidence: Omit<Evidence, "atTurn"> };
type Action = { id: string; label: string; effects: ActionEffect[] };

// ─────────────────────────────────────────────────────────────────────────
// The belief graph.
// ─────────────────────────────────────────────────────────────────────────

class BeliefGraph {
  private state: GraphState = { beliefs: {}, contradicts: [], implies: [] };
  private clock = 0;

  /** (1) Assert a new belief with no evidence yet (confidence 0.5 = neutral). */
  assert(id: string, predicate: string, value = true): Belief {
    const b: Belief = { id, predicate, value, confidence: 0.5, evidence: [], updatedTurn: this.clock };
    this.state.beliefs[id] = b;
    return b;
  }

  belief(id: string): Belief | undefined {
    return this.state.beliefs[id];
  }

  contradicts(a: string, b: string) {
    this.state.contradicts.push([a, b]);
  }

  implies(a: string, b: string) {
    this.state.implies.push([a, b]);
  }

  /** (2) Fold an observation into a belief and recompute its confidence. */
  observe(id: string, ev: Omit<Evidence, "atTurn">): Belief {
    const b = this.state.beliefs[id];
    if (!b) throw new Error(`no belief '${id}'`);
    b.evidence.push({ ...ev, atTurn: ++this.clock });
    b.confidence = confidenceFrom(b.evidence);
    b.updatedTurn = this.clock;
    return b;
  }

  /** (3) Flag every contradicting pair both held true above the threshold. */
  checkConsistency(): Array<{ a: string; b: string; ca: number; cb: number }> {
    const out: Array<{ a: string; b: string; ca: number; cb: number }> = [];
    for (const [aId, bId] of this.state.contradicts) {
      const a = this.state.beliefs[aId];
      const b = this.state.beliefs[bId];
      if (!a || !b) continue;
      if (a.value && b.value && a.confidence >= CONSISTENCY_THRESHOLD && b.confidence >= CONSISTENCY_THRESHOLD) {
        out.push({ a: aId, b: bId, ca: a.confidence, cb: b.confidence });
      }
    }
    return out;
  }

  /** (4) Merge corroborating duplicates, then resolve contradictions by weight. */
  repair(): string[] {
    const notes: string[] = [];

    // Merge beliefs that assert the same predicate+value: corroboration.
    const byKey: Record<string, string[]> = {};
    for (const b of Object.values(this.state.beliefs)) {
      const key = `${b.predicate}=${b.value}`;
      (byKey[key] ||= []).push(b.id);
    }
    for (const ids of Object.values(byKey)) {
      if (ids.length < 2) continue;
      const keep = this.state.beliefs[ids[0]];
      for (const dropId of ids.slice(1)) {
        const drop = this.state.beliefs[dropId];
        keep.evidence.push(...drop.evidence);
        delete this.state.beliefs[dropId];
        this.rewire(dropId, keep.id);
      }
      keep.evidence.sort((x, y) => x.atTurn - y.atTurn);
      const before = keep.confidence;
      keep.confidence = confidenceFrom(keep.evidence);
      keep.updatedTurn = ++this.clock;
      notes.push(`merged ${ids.length} '${keep.predicate}' beliefs → confidence ${before.toFixed(2)} → ${keep.confidence.toFixed(2)} (corroboration)`);
    }

    // Resolve each remaining contradiction by total supporting weight.
    for (const inc of this.checkConsistency()) {
      const a = this.state.beliefs[inc.a];
      const b = this.state.beliefs[inc.b];
      const keep = totalSupportingWeight(a) >= totalSupportingWeight(b) ? a : b;
      const lose = keep === a ? b : a;
      // The loser defers: inject a contradicting observation weighted by the
      // winner's confidence, so its confidence falls through the same machinery.
      this.observe(lose.id, { source: `consistency_repair(${keep.id})`, weight: clamp(keep.confidence, 0.01, 0.99), supports: false });
      notes.push(`resolved '${a.id}' vs '${b.id}': kept '${keep.id}' (weight ${totalSupportingWeight(keep).toFixed(2)}), '${lose.id}' deferred → ${lose.confidence.toFixed(2)}`);
    }
    return notes;
  }

  private rewire(from: string, to: string) {
    const fix = (pair: [string, string]): [string, string] => [pair[0] === from ? to : pair[0], pair[1] === from ? to : pair[1]];
    this.state.contradicts = this.state.contradicts.map(fix).filter(([x, y]) => x !== y);
    this.state.implies = this.state.implies.map(fix).filter(([x, y]) => x !== y);
  }

  /** (5) Project an action onto a CLONE; the live graph is never touched. */
  predict(action: Action): Record<string, number> {
    const sandbox = new BeliefGraph();
    sandbox.state = structuredClone(this.state); // the clone — real beliefs untouched
    sandbox.clock = this.clock;
    for (const eff of action.effects) sandbox.observe(eff.target, eff.evidence);
    const out: Record<string, number> = {};
    for (const b of Object.values(sandbox.state.beliefs)) out[b.id] = b.confidence;
    return out;
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of Object.values(this.state.beliefs)) out[b.id] = b.confidence;
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  banner("Scenario 1 — state estimation: confidence tracks corroborating & conflicting evidence");
  {
    const g = new BeliefGraph();
    g.assert("net", "networkUp", true);
    const obs: Array<Omit<Evidence, "atTurn">> = [
      { source: "rpc_ping_A", weight: 0.7, supports: true },
      { source: "rpc_ping_B", weight: 0.75, supports: true },
      { source: "mempool_probe", weight: 0.8, supports: true },
      { source: "timeout_seen", weight: 0.6, supports: false }, // a conflicting source arrives
    ];
    for (const o of obs) {
      const b = g.observe("net", o);
      console.log(`    +${o.supports ? "for " : "against"} ${o.source} (w=${o.weight}) → confidence ${b.confidence.toFixed(3)}`);
    }
    console.log("  (confidence compounds with agreement and dips on conflict — pure log-odds, reproducible.)");
  }

  banner("Scenario 2 — consistency check: two contradicting beliefs both held confidently");
  {
    const g = new BeliefGraph();
    g.assert("known", "recipientIsKnownContact", true);
    g.assert("unknown", "recipientIsUnrecognized", true);
    g.contradicts("known", "unknown");
    g.observe("known", { source: "contacts_book", weight: 0.85, supports: true });
    g.observe("unknown", { source: "fraud_heuristic", weight: 0.75, supports: true });
    const issues = g.checkConsistency();
    for (const i of issues) console.log(`    ⚠ inconsistency: '${i.a}' (${i.ca.toFixed(2)}) contradicts '${i.b}' (${i.cb.toFixed(2)})`);
    console.log(`  found ${issues.length} inconsistency — the agent knows it holds two facts that can't both be true.`);
  }

  banner("Scenario 3 — belief repair: merge corroboration, resolve contradiction by weight");
  {
    const g = new BeliefGraph();
    g.assert("known", "recipientIsKnownContact", true);
    g.assert("known_dup", "recipientIsKnownContact", true); // duplicate predicate → corroboration
    g.assert("unknown", "recipientIsUnrecognized", true);
    g.contradicts("known", "unknown");
    g.observe("known", { source: "contacts_book", weight: 0.8, supports: true });
    g.observe("known_dup", { source: "prior_transfer_history", weight: 0.75, supports: true });
    g.observe("unknown", { source: "fraud_heuristic", weight: 0.8, supports: true });
    console.log("  before:", g.snapshot());
    for (const note of g.repair()) console.log("    · " + note);
    console.log("  after: ", g.snapshot());
    console.log(`  remaining inconsistencies: ${g.checkConsistency().length}`);
  }

  banner("Scenario 4 — predictive simulation: pick the action with the better projected belief");
  {
    const g = new BeliefGraph();
    g.assert("ok", "transferSucceeds", true);
    g.observe("ok", { source: "prior", weight: 0.55, supports: true });
    const broadcastNow: Action = {
      id: "broadcast_now",
      label: "broadcast immediately",
      effects: [{ target: "ok", evidence: { source: "optimistic_send", weight: 0.6, supports: true } }],
    };
    const stabilizeFirst: Action = {
      id: "stabilize_then_broadcast",
      label: "stabilize the connection, then broadcast",
      effects: [{ target: "ok", evidence: { source: "confirmed_route", weight: 0.9, supports: true } }],
    };
    const a = g.predict(broadcastNow);
    const b = g.predict(stabilizeFirst);
    console.log(`    '${broadcastNow.id}' → transferSucceeds ${a.ok.toFixed(3)}`);
    console.log(`    '${stabilizeFirst.id}' → transferSucceeds ${b.ok.toFixed(3)}`);
    const choice = b.ok >= a.ok ? stabilizeFirst : broadcastNow;
    console.log(`  agent picks '${choice.id}' (higher predicted confidence).`);
    console.log(`  live belief after both predictions: transferSucceeds=${g.belief("ok")!.confidence.toFixed(3)}  ← unchanged (clone proof)`);
  }

  console.log("\nDone. The belief state folded noisy evidence into calibrated confidence, flagged two");
  console.log("facts that couldn't both be true, repaired them by weight and corroboration, and chose");
  console.log("an action by its predicted effect — all on clones, with the live beliefs untouched.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { BeliefGraph, confidenceFrom };
export type { Belief, Evidence, GraphState, Action, ActionEffect };
