// Guide 96 — Proactive Capacity-Limit Estimation for Context Offload
//
// Models effective working-context capacity as a function of window size and
// reasoning depth, triggers proactive archiving before overflow, and flags
// when the fixed anchor set can't losslessly represent current load.

const KAPPA = 4; // scaling constant for the log-capacity model
const DEPTH_WEIGHT = 0.15;
const NEAR_BOUND_THRESHOLD = 0.85;
const BASELINE_TOKENS = 2000;

interface CapacityInputs {
  windowTokens: number;
  recentToolCallCount: number;
  load: number; // sum of per-subsystem projection cost, e.g. from Guide 94
  anchorCount: number;
}

interface CapacityReport {
  depthFactor: number;
  effectiveCapacity: number;
  saturation: number;
  nearBound: boolean;
  requiredAnchors: number;
  anchorDeficit: number;
}

function computeCapacityReport(inputs: CapacityInputs): CapacityReport {
  const depthFactor = 1 + Math.log1p(inputs.recentToolCallCount) * DEPTH_WEIGHT;
  const effectiveCapacity =
    KAPPA * Math.log2(Math.max(1, inputs.windowTokens / BASELINE_TOKENS) + 1) * depthFactor;

  const saturation = inputs.load / Math.max(1e-6, effectiveCapacity);
  const nearBound = saturation > NEAR_BOUND_THRESHOLD;

  const requiredAnchors = Math.ceil(inputs.load / Math.LN2);
  const anchorDeficit = Math.max(0, requiredAnchors - inputs.anchorCount);

  return { depthFactor, effectiveCapacity, saturation, nearBound, requiredAnchors, anchorDeficit };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// 1. nearBound fires before saturation would silently exceed 1.0.
const growingLoad = [0.5, 2.0, 4.0, 6.0, 8.0, 9.8, 10.5, 11.0].map((load) =>
  computeCapacityReport({ windowTokens: 8000, recentToolCallCount: 3, load, anchorCount: 10 }),
);
console.log("[growing load trace]");
let sawNearBoundBeforeOverflow = false;
for (let i = 0; i < growingLoad.length; i++) {
  const r = growingLoad[i];
  console.log(
    `load step ${i}: saturation=${r.saturation.toFixed(3)} nearBound=${r.nearBound} capacity=${r.effectiveCapacity.toFixed(3)}`,
  );
  if (r.nearBound && r.saturation < 1.0) sawNearBoundBeforeOverflow = true;
}
assert(sawNearBoundBeforeOverflow, "expected at least one step to be nearBound while still under saturation=1.0");

// 2. Higher depth factor raises effective capacity (more chained reasoning "buys" more room).
const shallow = computeCapacityReport({ windowTokens: 8000, recentToolCallCount: 0, load: 1, anchorCount: 10 });
const deep = computeCapacityReport({ windowTokens: 8000, recentToolCallCount: 20, load: 1, anchorCount: 10 });
assert(
  deep.effectiveCapacity > shallow.effectiveCapacity,
  `expected deeper reasoning to raise effective capacity: shallow=${shallow.effectiveCapacity.toFixed(3)}, deep=${deep.effectiveCapacity.toFixed(3)}`,
);
assert(
  deep.depthFactor / shallow.depthFactor < 3,
  "depth factor must saturate (log1p), not scale linearly without bound",
);

// 3. Low anchor count produces a nonzero deficit even when saturation is low — independent failure modes.
const lowAnchorCase = computeCapacityReport({
  windowTokens: 32000,
  recentToolCallCount: 5,
  load: 0.5,
  anchorCount: 0,
});
assert(
  lowAnchorCase.saturation < NEAR_BOUND_THRESHOLD,
  "this case should have low saturation (plenty of window headroom)",
);
assert(
  lowAnchorCase.anchorDeficit > 0,
  "a near-zero anchor count should still produce a nonzero deficit regardless of saturation",
);

console.log("\n[demo] shallow vs deep depth factor:", {
  shallow: shallow.depthFactor,
  deep: deep.depthFactor,
});
console.log("[demo] low-saturation but anchor-starved case:", lowAnchorCase);

console.log("\n[property checks] proactive trigger + depth saturation + independent failure modes: PASS");
console.log("\nGuide 96 demo complete.");
