/**
 * Resource Self-Governance — reference implementation.
 *
 * An agent that always reaches for its best, most expensive path will run out
 * of budget (tokens, wall-clock, money) before it finishes the job. This is the
 * Layer-2 capability where the agent reasons about its OWN resource envelope:
 * it tracks what a task has cost so far, knows how much it has left, and — under
 * pressure — deliberately trades quality for cheaper paths so it can still reach
 * the finish line.
 *
 * The four things resource self-governance has to do:
 *
 *   1. Track a multi-resource budget   — tokens, latency, and cost at once; the
 *                                         BINDING resource (the one closest to
 *                                         empty) sets the pressure, not the average.
 *   2. Quote each path's cost          — every way to do a step carries an
 *                                         estimated cost vector and an expected
 *                                         utility (how good the result will be).
 *   3. Choose under pressure           — pick the path maximizing utility minus a
 *                                         cost penalty that GROWS as budget drains,
 *                                         so the same options resolve to the best
 *                                         path when rich and the cheapest viable
 *                                         path when poor.
 *   4. Protect a reserve               — keep a slice of budget back for the final
 *                                         "deliver the answer" step; ordinary
 *                                         mid-task steps may not spend it, so the
 *                                         agent can always afford to finish.
 *
 * This is the cost term that guide 68's decide() leaves open: 68 weighs
 * confidence against risk; this weighs a path's quality against what it burns.
 *
 * Run it:
 *   node resource-self-governance.ts --demo   # Node 24+ strips TS types natively
 *   npx tsx resource-self-governance.ts --demo
 *
 * Node.js built-ins only. No network, no persistence — the whole governor is an
 * in-memory object so the model can be read and run in one pass.
 */

// ─────────────────────────────────────────────────────────────────────────
// (1) A multi-resource budget. Three kinds, because a task can be rich in one
//     and starved in another — and it is the STARVED one that should drive the
//     decision. "Plenty of tokens but almost out of time" must behave like
//     "almost out of time", not like "plenty".
// ─────────────────────────────────────────────────────────────────────────

type ResourceKind = "tokens" | "latency_ms" | "cost_cents";
const RESOURCE_KINDS = ["tokens", "latency_ms", "cost_cents"] as const;

type Budget = Record<ResourceKind, number>;

function zeroBudget(): Budget {
  return { tokens: 0, latency_ms: 0, cost_cents: 0 };
}

function addBudget(a: Budget, b: Budget): Budget {
  return {
    tokens: a.tokens + b.tokens,
    latency_ms: a.latency_ms + b.latency_ms,
    cost_cents: a.cost_cents + b.cost_cents,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Pressure tiers. As the binding resource drains, the governor becomes more
// cost-averse (it penalizes expensive paths harder) and — only at the bottom —
// is allowed to dip into the protected reserve.
// ─────────────────────────────────────────────────────────────────────────

type Pressure = "abundant" | "tight" | "critical";

const PRESSURE_TIERS = [
  { name: "abundant", minFraction: 0.5, costAversion: 0.25 },
  { name: "tight", minFraction: 0.2, costAversion: 0.9 },
  { name: "critical", minFraction: 0.0, costAversion: 2.5 },
] as const;

// ─────────────────────────────────────────────────────────────────────────
// The ledger: what was budgeted, what has been spent, and the queries the
// governor reads. The reserve is a fraction of the ORIGINAL budget held back
// for the finalization step.
// ─────────────────────────────────────────────────────────────────────────

class ResourceLedger {
  budget: Budget;
  spent: Budget;
  reserveFraction: number;

  constructor(budget: Budget, reserveFraction = 0.15) {
    this.budget = { ...budget };
    this.spent = zeroBudget();
    this.reserveFraction = reserveFraction;
  }

  remaining(): Budget {
    const r = zeroBudget();
    for (const k of RESOURCE_KINDS) r[k] = Math.max(0, this.budget[k] - this.spent[k]);
    return r;
  }

  reserve(): Budget {
    const r = zeroBudget();
    for (const k of RESOURCE_KINDS) r[k] = this.budget[k] * this.reserveFraction;
    return r;
  }

  /** Fraction of the budget left in the BINDING (closest-to-empty) resource. */
  fractionRemaining(): number {
    const rem = this.remaining();
    let min = 1;
    for (const k of RESOURCE_KINDS) {
      if (this.budget[k] <= 0) continue;
      min = Math.min(min, rem[k] / this.budget[k]);
    }
    return min;
  }

  /** What a step may actually draw on; the reserve is excluded unless permitted. */
  available(includeReserve: boolean): Budget {
    const rem = this.remaining();
    if (includeReserve) return rem;
    const res = this.reserve();
    const a = zeroBudget();
    for (const k of RESOURCE_KINDS) a[k] = Math.max(0, rem[k] - res[k]);
    return a;
  }

  pressure(): Pressure {
    const f = this.fractionRemaining();
    for (const tier of PRESSURE_TIERS) {
      if (f >= tier.minFraction) return tier.name;
    }
    return "critical";
  }

  charge(cost: Budget): void {
    this.spent = addBudget(this.spent, cost);
  }
}

function tierFor(pressure: Pressure): (typeof PRESSURE_TIERS)[number] {
  return PRESSURE_TIERS.find((t) => t.name === pressure)!;
}

// ─────────────────────────────────────────────────────────────────────────
// (2) A path option: one way to do a step, with its estimated cost and the
//     expected utility (0..1) of the result it would produce.
// ─────────────────────────────────────────────────────────────────────────

type PathOption = {
  id: string;
  label: string;
  est: Budget;
  utility: number; // 0..1 — expected quality of this path's result
};

type Decision =
  | { kind: "proceed"; step: string; option: PathOption; pressure: Pressure; score: number; usedReserve: boolean; reason: string }
  | { kind: "abstain"; step: string; pressure: Pressure; reason: string };

// ─────────────────────────────────────────────────────────────────────────
// (3) + (4) The governor. Given the candidate paths for a step, it filters to
//     what is affordable (reserve protected unless this is a finalization step
//     or pressure is critical), then scores survivors by utility minus a
//     pressure-scaled cost penalty and picks the best.
// ─────────────────────────────────────────────────────────────────────────

class ResourceGovernor {
  ledger: ResourceLedger;

  constructor(ledger: ResourceLedger) {
    this.ledger = ledger;
  }

  /** Fraction of the ORIGINAL budget this option consumes in its binding resource. */
  private normCost(est: Budget): number {
    let max = 0;
    for (const k of RESOURCE_KINDS) {
      if (this.ledger.budget[k] <= 0) continue;
      max = Math.max(max, est[k] / this.ledger.budget[k]);
    }
    return max;
  }

  private fitsWithin(est: Budget, avail: Budget): boolean {
    return RESOURCE_KINDS.every((k) => est[k] <= avail[k]);
  }

  choose(step: string, options: PathOption[], opts?: { isFinalize?: boolean }): Decision {
    const pressure = this.ledger.pressure();
    const tier = tierFor(pressure);
    // Reserve is spendable ONLY when finishing the task. The reserve exists to
    // buy the finish, so every non-finalize step — at any pressure — must leave
    // it alone; that is what guarantees the agent can always afford to deliver.
    const includeReserve = Boolean(opts?.isFinalize);
    const avail = this.ledger.available(includeReserve);

    const affordable = options.filter((o) => this.fitsWithin(o.est, avail));
    if (affordable.length === 0) {
      return {
        kind: "abstain",
        step,
        pressure,
        reason: includeReserve
          ? "no path fits even with the reserve — cannot complete within budget"
          : "no path fits within the non-reserve budget — the finalization reserve is protected",
      };
    }

    let best = affordable[0];
    let bestScore = -Infinity;
    for (const o of affordable) {
      const score = o.utility - tier.costAversion * this.normCost(o.est);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }

    const reserveOnly = this.ledger.available(false);
    const usedReserve = !this.fitsWithin(best.est, reserveOnly);

    return {
      kind: "proceed",
      step,
      option: best,
      pressure,
      score: Number(bestScore.toFixed(3)),
      usedReserve,
      reason: `${pressure} pressure (costAversion=${tier.costAversion}) → chose '${best.label}' (utility ${best.utility})`,
    };
  }

  /** Commit to a decision: charge the ledger for the chosen path. */
  commit(decision: Decision): void {
    if (decision.kind === "proceed") this.ledger.charge(decision.option.est);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

const FULL_BUDGET: Budget = { tokens: 100000, latency_ms: 60000, cost_cents: 50 };

// Three ways to answer a research step, best → cheapest.
const ANSWER_PATHS: PathOption[] = [
  { id: "big", label: "frontier model + web search", est: { tokens: 40000, latency_ms: 25000, cost_cents: 22 }, utility: 0.95 },
  { id: "mid", label: "small model + cached context", est: { tokens: 12000, latency_ms: 9000, cost_cents: 5 }, utility: 0.78 },
  { id: "cheap", label: "heuristic + local memory", est: { tokens: 1500, latency_ms: 800, cost_cents: 0.3 }, utility: 0.5 },
];

// Two ways to deliver the final summary.
const FINALIZE_PATHS: PathOption[] = [
  { id: "full", label: "full structured summary", est: { tokens: 9000, latency_ms: 5000, cost_cents: 4 }, utility: 0.9 },
  { id: "terse", label: "terse summary", est: { tokens: 2500, latency_ms: 1500, cost_cents: 1 }, utility: 0.6 },
];

function show(d: Decision) {
  if (d.kind === "abstain") {
    console.log(`  ABSTAIN [${d.pressure}] — ${d.reason}`);
  } else {
    console.log(`  PROCEED [${d.pressure}] → ${d.option.label}  (score ${d.score}${d.usedReserve ? ", dipped into reserve" : ""})`);
  }
}

function freshGovernor(spent?: Budget): ResourceGovernor {
  const ledger = new ResourceLedger(FULL_BUDGET, 0.15);
  if (spent) ledger.charge(spent);
  return new ResourceGovernor(ledger);
}

function demo() {
  banner("Scenario 1 — abundant budget: spend for quality, pick the best path");
  {
    const gov = freshGovernor();
    const d = gov.choose("answer", ANSWER_PATHS);
    show(d);
    console.log("  (nothing spent yet → low cost-aversion → the frontier path wins on utility.)");
  }

  banner("Scenario 2 — tight budget: same options, gracefully degrade to a cheaper path");
  {
    const gov = freshGovernor({ tokens: 70000, latency_ms: 42000, cost_cents: 35 });
    console.log(`  binding resource at ${(gov.ledger.fractionRemaining() * 100).toFixed(0)}% remaining`);
    const d = gov.choose("answer", ANSWER_PATHS);
    show(d);
    console.log("  (the frontier path no longer fits the non-reserve budget; the mid path is chosen.)");
  }

  banner("Scenario 3 — critical pressure, a MID-TASK step: the reserve is protected");
  {
    const gov = freshGovernor({ tokens: 88000, latency_ms: 52000, cost_cents: 44 });
    console.log(`  binding resource at ${(gov.ledger.fractionRemaining() * 100).toFixed(0)}% remaining`);
    const d = gov.choose("answer", ANSWER_PATHS, { isFinalize: false });
    show(d);
    console.log("  (only the reserve is left; a non-finalize step may not spend it → abstain, so the");
    console.log("   agent still has enough budget to actually deliver an answer.)");
  }

  banner("Scenario 4 — the FINALIZE step is allowed to spend the reserve");
  {
    const gov = freshGovernor({ tokens: 88000, latency_ms: 52000, cost_cents: 44 });
    const d = gov.choose("finalize", FINALIZE_PATHS, { isFinalize: true });
    show(d);
    console.log("  (same depleted ledger as Scenario 3, but this is the finish line → the reserve");
    console.log("   unlocks and the summary gets delivered.)");
  }

  banner("Scenario 5 — truly empty: honest abstain even at the finish line");
  {
    const gov = freshGovernor({ tokens: 99000, latency_ms: 59500, cost_cents: 49.9 });
    const d = gov.choose("finalize", FINALIZE_PATHS, { isFinalize: true });
    show(d);
    console.log("  (reserve and all, nothing fits — the governor says so instead of pretending.)");
  }

  console.log("\nDone. The agent tracked its own multi-resource budget, let the BINDING resource");
  console.log("set the pressure, traded quality for cost as it drained, and protected a reserve");
  console.log("so it could always afford to finish — or abstained honestly when it could not.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { ResourceLedger, ResourceGovernor, zeroBudget, addBudget };
export type { ResourceKind, Budget, Pressure, PathOption, Decision };
