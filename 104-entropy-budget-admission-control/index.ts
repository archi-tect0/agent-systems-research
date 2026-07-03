// Guide 104 — Entropy-Budget Admission Control
//
// An admission-control pattern that uses an information-theoretic
// entropy budget to prevent runaway context growth and silent context displacement.

interface EntropyBudgetState {
  currentInfo: number;    // Current total information content (nats)
  maxInfo: number;        // Entropy budget ceiling (S_max)
  saturation: number;     // currentInfo / maxInfo
  headroom: number;       // Remaining capacity
  nearBound: boolean;     // Saturation > 0.85
  invariantCoverage: {
    invariantDOF: number; // Size of the invariant set G
    requiredDOF: number;  // DOF needed for lossless encoding
    complete: boolean;    // requiredDOF <= invariantDOF
  };
}

// Calibration constants (matching artifacts/api-server/src/lib/entropyBudget.ts)
const KAPPA = 2.5;
const T_BASE = 4096;
const DEPTH_BASE = 1.0;
const INVARIANT_DOF_DEFAULT = 7;

/**
 * Compute the entropy budget ceiling.
 * 
 * @param totalEntropy Total measured entropy across subsystems (nats)
 * @param contextTokens Available context window size
 * @param depth Total tool calls/reasoning cycles (expands the ceiling)
 * @param invariants Number of active kernel invariants (G-set)
 */
function computeEntropyBudgetState(
  totalEntropy: number,
  contextTokens: number = 32000,
  depth: number = 0,
  invariants: number = INVARIANT_DOF_DEFAULT
): EntropyBudgetState {
  const depthFactor = DEPTH_BASE + Math.log1p(depth) * 0.2;
  const contextRatio = Math.max(1, contextTokens / T_BASE);
  const maxInfo = KAPPA * Math.log2(contextRatio) * depthFactor;
  
  const saturation = maxInfo > 0 ? Math.min(2, totalEntropy / maxInfo) : 0;
  const requiredDOF = Math.ceil(totalEntropy / Math.LN2);

  return {
    currentInfo: totalEntropy,
    maxInfo,
    saturation,
    headroom: Math.max(0, maxInfo - totalEntropy),
    nearBound: saturation > 0.85,
    invariantCoverage: {
      invariantDOF: invariants,
      requiredDOF,
      complete: requiredDOF <= invariants
    }
  };
}

/**
 * Admission Control Gate
 */
class AdmissionGate {
  private contextSize: number;
  private invariants: number;
  private entropy: number = 0;
  private depth: number = 0;

  constructor(
    contextSize: number = 32000,
    invariants: number = 7
  ) {
    this.contextSize = contextSize;
    this.invariants = invariants;
  }

  /**
   * Propose adding a new block of information.
   * Returns true if admitted, false if rejected by the entropy budget.
   */
  propose(newEntropy: number): { admitted: boolean; reason?: string } {
    const projectedState = computeEntropyBudgetState(
      this.entropy + newEntropy,
      this.contextSize,
      this.depth,
      this.invariants
    );

    if (projectedState.saturation > 1.0) {
      return { 
        admitted: false, 
        reason: `Entropy budget exceeded (${(projectedState.saturation * 100).toFixed(1)}%). Context displacement likely on next turn.` 
      };
    }

    if (!projectedState.invariantCoverage.complete) {
      // In this demo, we admit but warn when invariant coverage is insufficient.
      // A stricter gate might reject here.
      console.log(`[Gate] Warning: Invariant coverage insufficient. Deficit: ${projectedState.invariantCoverage.requiredDOF - projectedState.invariantCoverage.invariantDOF} DOF.`);
    }

    this.entropy += newEntropy;
    return { admitted: true };
  }

  incrementDepth() {
    this.depth++;
  }

  getState() {
    return computeEntropyBudgetState(this.entropy, this.contextSize, this.depth, this.invariants);
  }
}

// ---------------------------------------------------------------------------
// Assertions & Demo
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (process.argv.includes("--demo")) {
  console.log("--- Entropy-Budget Admission Control Demo ---\n");

  const gate = new AdmissionGate(16384, 7); // 16K context, 7 invariants
  
  console.log("Scenario 1: Adding moderate entropy...");
  const first = gate.propose(5.0);
  assert(first.admitted, "Should admit moderate entropy");
  console.log(`Admitted 5.0 nats. Saturation: ${(gate.getState().saturation * 100).toFixed(1)}%\n`);

  console.log("Scenario 2: Adding a large state that pushes near the bound...");
  // maxInfo for 16K context is ~2.5 * log2(4) * 1.0 = 5.0 nats (very tight for demo)
  // Let's re-calculate: log2(16384/4096) = 2. 2.5 * 2 = 5.0 nats.
  // Wait, the KAPPA is 2.5, T_BASE is 4096. 
  // 16384/4096 = 4. log2(4) = 2. 2.5 * 2 = 5.0. 
  // So 5.0 is the exact bound for depth 0.
  
  assert(gate.getState().saturation === 1.0, "Should be at 100% saturation");
  assert(gate.getState().nearBound === true, "Should be near bound");

  console.log("Scenario 3: Rejecting overflow...");
  const overflow = gate.propose(1.0);
  assert(!overflow.admitted, "Should reject overflow");
  console.log(`Rejected: ${overflow.reason}\n`);

  console.log("Scenario 4: Depth expansion...");
  console.log("Making tool calls to expand the budget...");
  for (let i = 0; i < 5; i++) gate.incrementDepth();
  
  const stateAfterDepth = gate.getState();
  console.log(`New maxInfo after depth expansion: ${stateAfterDepth.maxInfo.toFixed(2)} nats`);
  console.log(`New saturation: ${(stateAfterDepth.saturation * 100).toFixed(1)}%`);
  
  assert(stateAfterDepth.saturation < 1.0, "Depth expansion should have lowered saturation");
  
  const retry = gate.propose(1.0);
  assert(retry.admitted, "Should now admit the previously rejected block due to depth expansion");
  console.log("Admitted 1.0 nats after depth expansion.\n");

  console.log("Scenario 5: Invariant coverage check...");
  const highEntropy = gate.propose(2.0); // Total ~8.0 nats
  const finalState = gate.getState();
  console.log(`Final entropy: ${finalState.currentInfo.toFixed(2)} nats`);
  console.log(`Required DOF: ${finalState.invariantCoverage.requiredDOF}`);
  console.log(`Current DOF: ${finalState.invariantCoverage.invariantDOF}`);
  
  // 8.0 / ln(2) approx 11.54 -> requiredDOF = 12.
  assert(!finalState.invariantCoverage.complete, "Should be under-provisioned");
  assert(finalState.invariantCoverage.requiredDOF > finalState.invariantCoverage.invariantDOF, "Required DOF should exceed invariants");
  
  console.log("\n[property checks] saturation gating + depth expansion + invariant coverage check: PASS");
  console.log("\nGuide 104 demo complete.");
}
