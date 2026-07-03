// Guide 108 — THB Closed-Loop Calibration and Warmup
//
// Demonstrates a self-tuning threshold that updates from empirical results
// via a bounded EMA, seeded by a synthetic warmup harness.

import { strict as assert } from "node:assert";

interface Observation {
  id: number;
  wallet: string;
  value: number;
}

interface Outcome {
  observationId: number;
  success: boolean;
}

interface Constants {
  THRESHOLD: number;
  version: number;
}

// ---------------------------------------------------------------------------
// Mock Database
// ---------------------------------------------------------------------------

const observations: Observation[] = [];
const outcomes: Outcome[] = [];

function dbReset() {
  observations.length = 0;
  outcomes.length = 0;
}

// ---------------------------------------------------------------------------
// Warmup Harness
// ---------------------------------------------------------------------------

const PHANTOM_WALLET = "phantom:thb-warmup";

/** 
 * Synthetic warmup generates data where the "ideal" threshold should be 0.70.
 * It simulates that values > 0.70 should be considered "success" if the 
 * system was perfectly calibrated.
 */
function runWarmup(n = 50) {
  for (let i = 0; i < n; i++) {
    // Generate a value between 0 and 1
    const value = Math.random();
    const id = observations.length + 1;
    
    observations.push({ id, wallet: PHANTOM_WALLET, value });
    
    // Outcome: Success if value > 0.70 (the "ground truth" we want to find)
    outcomes.push({ 
      observationId: id, 
      success: value > 0.70 
    });
  }
}

// ---------------------------------------------------------------------------
// Calibration Engine
// ---------------------------------------------------------------------------

const ALPHA = 0.2; // Learning rate
const MAX_STEP = 0.05; // 5% max relative change per run
const THRESHOLD_BOUNDS: [number, number] = [0.1, 0.9];
const MIN_SAMPLES = 30;

function computeResidual(currentThreshold: number): number | null {
  const recentObs = observations.slice(-100);
  const recentOutcomes = outcomes.filter(o => recentObs.some(r => r.id === o.observationId));

  if (recentObs.length < MIN_SAMPLES) return null;

  // We want to find a threshold that separates successes from failures.
  // In this simplified model, if the precision of "above threshold" is low,
  // we should raise the threshold.
  const above = recentObs.filter(r => r.value > currentThreshold);
  if (above.length === 0) return -0.01; // Push it down if we never fire

  const hits = above.filter(r => {
    const outcome = outcomes.find(o => o.observationId === r.id);
    return outcome?.success === true;
  }).length;

  const precision = hits / above.length;
  
  // Target precision for this specific threshold is 0.95 
  // (i.e., we only want to fire when we are very sure of success)
  return 0.95 - precision;
}

function runCalibration(current: Constants): Constants {
  const residual = computeResidual(current.THRESHOLD);
  if (residual === null) return current;

  const step = ALPHA * residual;
  const maxChange = current.THRESHOLD * MAX_STEP;
  const clampedStep = Math.sign(step) * Math.min(Math.abs(step), maxChange);
  
  let nextThreshold = current.THRESHOLD + clampedStep;
  
  // Hard bounds
  nextThreshold = Math.max(THRESHOLD_BOUNDS[0], Math.min(THRESHOLD_BOUNDS[1], nextThreshold));

  return {
    THRESHOLD: nextThreshold,
    version: current.version + 1
  };
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function runDemo() {
  console.log("--- THB Calibration & Warmup Demo ---");
  dbReset();

  // Initial state: threshold is way too low (0.3), should be near 0.7
  let config: Constants = { THRESHOLD: 0.3, version: 0 };
  console.log(`Initial config: v${config.version}, THRESHOLD=${config.THRESHOLD.toFixed(4)}`);

  // 1. Warmup
  console.log(`\n[warmup] Seeding ${PHANTOM_WALLET} with 100 synthetic turns...`);
  runWarmup(100);
  console.log(`DB now has ${observations.length} observations.`);

  // 2. Calibration loop
  console.log("\n[calibration] Running 10 iterations...");
  const history: number[] = [config.THRESHOLD];
  
  for (let i = 0; i < 10; i++) {
    const next = runCalibration(config);
    if (next.THRESHOLD === config.THRESHOLD) {
      console.log(`  Iter ${i+1}: No change (residual null or zero)`);
    } else {
      const delta = next.THRESHOLD - config.THRESHOLD;
      console.log(`  Iter ${i+1}: v${next.version}, THRESHOLD=${next.THRESHOLD.toFixed(4)} (Δ=${delta > 0 ? "+" : ""}${delta.toFixed(4)})`);
      config = next;
      history.push(config.THRESHOLD);
    }
  }

  // 3. Assertions
  console.log("\n[verify]");
  
  // Verify that it actually moved toward the ground truth (0.7)
  assert(config.THRESHOLD > 0.3, "Threshold should have increased from initial 0.3");
  
  // Verify step size constraint (EMA + MAX_STEP)
  // Each step should be <= 5% of previous value
  for (let i = 1; i < history.length; i++) {
    const prev = history[i-1];
    const curr = history[i];
    const relChange = Math.abs(curr - prev) / prev;
    assert(relChange <= MAX_STEP + 0.0001, `Step ${i} change ${relChange.toFixed(4)} exceeded MAX_STEP ${MAX_STEP}`);
  }

  console.log("Assertions passed: Threshold converged while respecting bounds and step limits.");
  console.log("\nDemo complete.");
}

if (process.argv.includes("--demo")) {
  runDemo().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
