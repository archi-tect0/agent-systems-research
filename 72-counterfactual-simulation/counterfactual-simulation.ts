/**
 * Counterfactual Simulation — reference implementation.
 *
 * Before an agent takes a multi-step, partly-irreversible action in the real
 * world, it should be able to ask "what happens if I run this plan?" — and get
 * the answer WITHOUT touching anything real. This is the Layer-2 capability of
 * dry-running a plan against a CLONE of the world model: stepping through it,
 * checking each action's preconditions, applying its effects to the copy, and
 * surfacing the branch where it goes wrong so the plan can be repaired before a
 * single real side-effect happens.
 *
 * The four things counterfactual simulation has to do:
 *
 *   1. Simulate on a clone     — every step mutates a structuredClone of the
 *                                world; the real state is never touched, so the
 *                                worst case of a bad plan is a discarded copy.
 *   2. Check preconditions      — each action declares what must be true before
 *                                it can run; the first unmet precondition is the
 *                                plan's failure point, reported with its reason.
 *   3. Explore failure branches — for irreversible actions, also simulate the
 *                                "what if this step FAILS at runtime" branch, so
 *                                a plan that strands the user (funds gone, not
 *                                confirmed) is flagged before it is run for real.
 *   4. Repair the plan          — when a precondition is unmet, look for an
 *                                enabler action that would satisfy it, splice it
 *                                in, and re-simulate until the plan is feasible.
 *
 * This shares its safety shape with guides 66 and 69 (act on a clone, never the
 * live thing) but points it forward: instead of repairing a fault after it
 * happens, it predicts the fault and avoids it.
 *
 * Run it:
 *   node counterfactual-simulation.ts --demo   # Node 24+ strips TS types natively
 *   npx tsx counterfactual-simulation.ts --demo
 *
 * Node.js built-ins only. No network — the world is a plain object so the whole
 * simulator can be read and run in one pass.
 */

// ─────────────────────────────────────────────────────────────────────────
// The world model. A flat, cloneable snapshot of the facts a plan depends on.
// In production this is a projection of the real world-model graph (guide 46);
// here it is a plain object so structuredClone gives a perfect, cheap copy.
// ─────────────────────────────────────────────────────────────────────────

type World = {
  walletBalanceEth: number;
  appInstalled: boolean;
  hasPasskey: boolean;
  networkUp: boolean;
  recipientWhitelisted: boolean;
  sentEth: number;
  confirmations: number;
};

function demoWorld(overrides?: Partial<World>): World {
  return {
    walletBalanceEth: 0,
    appInstalled: false,
    hasPasskey: false,
    networkUp: true,
    recipientWhitelisted: false,
    sentEth: 0,
    confirmations: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// An action. `pre` returns whether it may run (and why not); `effect` returns
// the next world; `failureEffect` (optional) is the COUNTERFACTUAL — what the
// world looks like if this action half-succeeds or fails at runtime, which is
// only meaningful for irreversible actions.
// ─────────────────────────────────────────────────────────────────────────

type Precheck = { ok: boolean; reason?: string };

type Action = {
  id: string;
  label: string;
  reversible: boolean;
  pre: (w: World) => Precheck;
  effect: (w: World) => World;
  failureEffect?: (w: World) => World; // the "what if it fails" branch
  // which world predicate this action makes true — used by plan repair
  satisfies?: string;
};

type StepTrace = {
  action: string;
  ok: boolean;
  reason?: string;
  reversible: boolean;
};

type SimResult = {
  feasible: boolean;
  trace: StepTrace[];
  firstFailure?: { step: number; action: string; reason: string };
  terminal: World;
  // counterfactual: terminal world if the last irreversible step had failed
  riskBranch?: { afterStep: number; action: string; terminal: World; stranded: boolean };
};

// ─────────────────────────────────────────────────────────────────────────
// A small library of "enabler" actions, keyed by the world predicate they make
// true. Plan repair consults this when a precondition is unmet.
// ─────────────────────────────────────────────────────────────────────────

const ENABLERS: Record<string, Action> = {
  appInstalled: {
    id: "install_app",
    label: "install the wallet app",
    reversible: true,
    satisfies: "appInstalled",
    pre: () => ({ ok: true }),
    effect: (w) => ({ ...w, appInstalled: true }),
  },
  hasPasskey: {
    id: "enroll_passkey",
    label: "enroll a passkey",
    reversible: true,
    satisfies: "hasPasskey",
    pre: (w) => (w.appInstalled ? { ok: true } : { ok: false, reason: "app must be installed before passkey enrollment" }),
    effect: (w) => ({ ...w, hasPasskey: true }),
  },
  recipientWhitelisted: {
    id: "whitelist_recipient",
    label: "whitelist the recipient",
    reversible: true,
    satisfies: "recipientWhitelisted",
    pre: (w) => (w.hasPasskey ? { ok: true } : { ok: false, reason: "passkey required to change the whitelist" }),
    effect: (w) => ({ ...w, recipientWhitelisted: true }),
  },
};

// ─────────────────────────────────────────────────────────────────────────
// The simulator.
// ─────────────────────────────────────────────────────────────────────────

class CounterfactualSimulator {
  /** (1)+(2)+(3) Dry-run a plan against a CLONE; never mutate `world`. */
  simulate(world: World, plan: Action[]): SimResult {
    const sandbox: World = structuredClone(world); // the clone — real state untouched
    const trace: StepTrace[] = [];
    let firstFailure: SimResult["firstFailure"] | undefined;
    let riskBranch: SimResult["riskBranch"] | undefined;

    for (let i = 0; i < plan.length; i++) {
      const action = plan[i];
      const check = action.pre(sandbox);
      trace.push({ action: action.id, ok: check.ok, reason: check.reason, reversible: action.reversible });

      if (!check.ok) {
        firstFailure = { step: i, action: action.id, reason: check.reason ?? "precondition failed" };
        break; // a plan stops at its first unmet precondition
      }

      // (3) Counterfactual: before applying an irreversible action's success
      // effect, simulate its FAILURE branch on a fork to see if it strands us.
      if (!action.reversible && action.failureEffect) {
        const fork = action.failureEffect(structuredClone(sandbox));
        const stranded = fork.sentEth > sandbox.sentEth && fork.confirmations === 0;
        riskBranch = { afterStep: i, action: action.id, terminal: fork, stranded };
      }

      Object.assign(sandbox, action.effect(sandbox));
    }

    return {
      feasible: !firstFailure,
      trace,
      firstFailure,
      terminal: sandbox,
      riskBranch,
    };
  }

  /** (4) Given a failed simulation, splice in enablers for unmet preconditions
   *  and re-simulate until feasible or no enabler helps. */
  repairPlan(world: World, plan: Action[], maxInserts = 5): { plan: Action[]; inserted: string[]; result: SimResult } {
    let current = [...plan];
    const inserted: string[] = [];

    for (let round = 0; round < maxInserts; round++) {
      const result = this.simulate(world, current);
      if (result.feasible) return { plan: current, inserted, result };

      const failedAt = result.firstFailure!;
      const failedAction = current[failedAt.step];
      // Which predicate is the failing action waiting on? Probe enablers: insert
      // the one whose `satisfies` flips the failing precondition to ok.
      const enabler = this.findEnabler(world, current, failedAt.step, failedAction);
      if (!enabler) return { plan: current, inserted, result }; // unrepairable

      current = [...current.slice(0, failedAt.step), enabler, ...current.slice(failedAt.step)];
      inserted.push(enabler.id);
    }

    return { plan: current, inserted, result: this.simulate(world, current) };
  }

  /** Find an enabler that fixes the failing precondition or makes progress toward it. */
  private findEnabler(world: World, plan: Action[], stepIndex: number, failed: Action): Action | undefined {
    // Replay the plan up to the failure to get the world state there.
    const sandbox: World = structuredClone(world);
    for (let i = 0; i < stepIndex; i++) {
      if (!plan[i].pre(sandbox).ok) break;
      Object.assign(sandbox, plan[i].effect(sandbox));
    }
    const base = failed.pre(sandbox);
    for (const key of Object.keys(ENABLERS)) {
      const enabler = ENABLERS[key];
      if (plan.some((a) => a.id === enabler.id)) continue; // already in the plan
      const after = failed.pre(enabler.effect(structuredClone(sandbox)));
      // Accept an enabler that fixes the failing precondition OR makes progress
      // (flips it to a *different* unmet precondition we can resolve next round).
      if (after.ok || after.reason !== base.reason) return enabler;
    }
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Concrete actions for the demo: the irreversible send + its confirmation.
// ─────────────────────────────────────────────────────────────────────────

function sendEth(amount: number): Action {
  return {
    id: "send_eth",
    label: `send ${amount} ETH`,
    reversible: false,
    pre: (w) => {
      if (!w.hasPasskey) return { ok: false, reason: "passkey is the floor for a value transfer" };
      if (!w.recipientWhitelisted) return { ok: false, reason: "recipient is not whitelisted" };
      if (w.walletBalanceEth < amount) return { ok: false, reason: `insufficient balance (${w.walletBalanceEth} < ${amount})` };
      if (!w.networkUp) return { ok: false, reason: "network is down" };
      return { ok: true };
    },
    effect: (w) => ({ ...w, walletBalanceEth: w.walletBalanceEth - amount, sentEth: w.sentEth + amount }),
    // counterfactual: broadcast succeeded, but the network dropped before any
    // confirmation came back — funds left the wallet, transfer unconfirmed.
    failureEffect: (w) => ({ ...w, walletBalanceEth: w.walletBalanceEth - amount, sentEth: w.sentEth + amount, networkUp: false, confirmations: 0 }),
  };
}

const confirmTx: Action = {
  id: "confirm_tx",
  label: "wait for confirmation",
  reversible: true,
  pre: (w) => (w.networkUp ? { ok: true } : { ok: false, reason: "cannot confirm while network is down" }),
  effect: (w) => ({ ...w, confirmations: 1 }),
};

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function printTrace(r: SimResult) {
  for (const s of r.trace) {
    console.log(`    ${s.ok ? "✓" : "✗"} ${s.action}${s.reversible ? "" : " (irreversible)"}${s.reason ? " — " + s.reason : ""}`);
  }
}

function demo() {
  const sim = new CounterfactualSimulator();

  banner("Scenario 1 — a feasible plan: dry-run succeeds, real state untouched");
  {
    const world = demoWorld({ walletBalanceEth: 2, appInstalled: true, hasPasskey: true, recipientWhitelisted: true });
    const plan = [sendEth(1), confirmTx];
    const r = sim.simulate(world, plan);
    printTrace(r);
    console.log(`  feasible=${r.feasible}  terminal: balance=${r.terminal.walletBalanceEth} sent=${r.terminal.sentEth} confirmations=${r.terminal.confirmations}`);
    console.log(`  real world after simulation: balance=${world.walletBalanceEth} sent=${world.sentEth}  ← unchanged (clone proof)`);
  }

  banner("Scenario 2 — an infeasible plan: the first unmet precondition is surfaced");
  {
    const world = demoWorld({ walletBalanceEth: 2, appInstalled: true, hasPasskey: false, recipientWhitelisted: false });
    const plan = [sendEth(1), confirmTx];
    const r = sim.simulate(world, plan);
    printTrace(r);
    console.log(`  feasible=${r.feasible}  firstFailure: step ${r.firstFailure!.step} (${r.firstFailure!.action}) — ${r.firstFailure!.reason}`);
    console.log("  (nothing was sent for real — the agent learned the plan is invalid by simulating it.)");
  }

  banner("Scenario 3 — counterfactual failure branch: would this plan STRAND the user?");
  {
    const world = demoWorld({ walletBalanceEth: 2, appInstalled: true, hasPasskey: true, recipientWhitelisted: true });
    const plan = [sendEth(1), confirmTx];
    const r = sim.simulate(world, plan);
    const rb = r.riskBranch!;
    console.log(`  irreversible step '${rb.action}' failure branch → balance=${rb.terminal.walletBalanceEth} sent=${rb.terminal.sentEth} confirmations=${rb.terminal.confirmations}`);
    console.log(`  stranded=${rb.stranded}  (funds would leave the wallet with NO confirmation if the network drops mid-send)`);
    console.log("  → the agent flags this risk and can require a confirmation-gated/abortable send before running it for real.");
  }

  banner("Scenario 4 — plan repair: splice in enablers until the plan is feasible");
  {
    const world = demoWorld({ walletBalanceEth: 2 }); // nothing set up: no app, no passkey, not whitelisted
    const plan = [sendEth(1), confirmTx];
    const before = sim.simulate(world, plan);
    console.log(`  original plan feasible=${before.feasible} (fails: ${before.firstFailure!.reason})`);
    const repaired = sim.repairPlan(world, plan);
    console.log(`  inserted enablers: ${JSON.stringify(repaired.inserted)}`);
    console.log("  repaired plan: " + repaired.plan.map((a) => a.id).join(" → "));
    console.log(`  repaired feasible=${repaired.result.feasible}`);
    console.log("  (the simulator discovered the missing setup steps and ordered them correctly,");
    console.log("   all on clones — the user's real wallet was never touched during planning.)");
  }

  console.log("\nDone. The agent dry-ran multi-step plans on a CLONE of its world: it proved a good");
  console.log("plan safe, caught a bad plan's first failure, exposed an irreversible step's strand");
  console.log("risk, and repaired an incomplete plan into a feasible one — all before acting.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { CounterfactualSimulator, demoWorld, sendEth, confirmTx, ENABLERS };
export type { World, Action, Precheck, StepTrace, SimResult };
