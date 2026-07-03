// Guide 93 — Free-Energy-Style Control Signal for Behavioral Mode Gating
//
// Fuses several independent [0,1] pressure signals into one comparable
// "how cautious should I be right now" scalar, with fixed thresholds mapped
// directly to behavior regimes. Plain TypeScript, no dependencies.

interface PressureInputs {
  uncertainty: number; // 0..1, e.g. blended session uncertainty (Guide 97)
  drift: number; // 0..1, fast-path vs full-fidelity divergence
  infoLoss: number; // 0..1, projection loss at subsystem boundaries (Guide 94)
  structuralIntegrity: number; // 0..1, how intact core invariants currently are
}

interface FusedSignal {
  raw: number;
  normalized: number; // tanh-squashed, in (0,1)
  regime: "stable" | "elevated" | "critical";
}

const ALPHA = 0.6; // weight on drift
const BETA = 0.8; // weight on information loss
const GAMMA = 0.5; // weight on structural integrity (subtracted)
const ELEVATED_THRESHOLD = 0.35;
const CRITICAL_THRESHOLD = 0.65;

function computeFusedSignal(inputs: PressureInputs): FusedSignal {
  const raw =
    inputs.uncertainty +
    ALPHA * inputs.drift +
    BETA * inputs.infoLoss -
    GAMMA * inputs.structuralIntegrity;
  const floored = Math.max(0, raw);
  const normalized = Math.tanh(floored);

  const regime: FusedSignal["regime"] =
    normalized >= CRITICAL_THRESHOLD
      ? "critical"
      : normalized >= ELEVATED_THRESHOLD
        ? "elevated"
        : "stable";

  return { raw: floored, normalized, regime };
}

function behaviorFor(regime: FusedSignal["regime"]): string {
  switch (regime) {
    case "critical":
      return "ask before acting; restrict write actions this turn";
    case "elevated":
      return "prefer cheap/read operations; surface caveats in the reply";
    case "stable":
      return "normal operation";
  }
}

// ---------------------------------------------------------------------------
// Property checks: monotonicity and protective direction.
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function runPropertyChecks(): void {
  const base: PressureInputs = {
    uncertainty: 0.2,
    drift: 0.2,
    infoLoss: 0.2,
    structuralIntegrity: 0.6,
  };
  const baseline = computeFusedSignal(base);

  // Raising any pressure component must never lower F.
  for (const key of ["uncertainty", "drift", "infoLoss"] as const) {
    const bumped = computeFusedSignal({ ...base, [key]: base[key] + 0.3 });
    assert(
      bumped.normalized >= baseline.normalized,
      `raising ${key} should never decrease the fused signal (baseline=${baseline.normalized.toFixed(4)}, bumped=${bumped.normalized.toFixed(4)})`,
    );
  }

  // Raising structural integrity must never raise F.
  const moreIntegrity = computeFusedSignal({
    ...base,
    structuralIntegrity: Math.min(1, base.structuralIntegrity + 0.3),
  });
  assert(
    moreIntegrity.normalized <= baseline.normalized,
    "raising structural integrity should never increase the fused signal",
  );

  // Zero pressure + full integrity should floor at zero raw / zero normalized.
  const allClear = computeFusedSignal({
    uncertainty: 0,
    drift: 0,
    infoLoss: 0,
    structuralIntegrity: 1,
  });
  assert(allClear.raw === 0, "zero pressure with full integrity should floor at raw=0");
  assert(allClear.regime === "stable", "zero pressure should be in the stable regime");

  console.log("[property checks] monotonicity + protective direction: PASS");
}

// ---------------------------------------------------------------------------
// Session trace demo
// ---------------------------------------------------------------------------

function runSessionTrace(): void {
  const trace: PressureInputs[] = [
    { uncertainty: 0.1, drift: 0.05, infoLoss: 0.1, structuralIntegrity: 0.9 },
    { uncertainty: 0.3, drift: 0.2, infoLoss: 0.25, structuralIntegrity: 0.75 },
    { uncertainty: 0.55, drift: 0.4, infoLoss: 0.4, structuralIntegrity: 0.55 },
    { uncertainty: 0.8, drift: 0.6, infoLoss: 0.6, structuralIntegrity: 0.3 },
    { uncertainty: 0.4, drift: 0.3, infoLoss: 0.2, structuralIntegrity: 0.7 },
  ];

  console.log("\n[session trace]");
  for (let turn = 0; turn < trace.length; turn++) {
    const signal = computeFusedSignal(trace[turn]);
    console.log(
      `turn ${turn}: F=${signal.normalized.toFixed(3)} regime=${signal.regime.padEnd(8)} -> ${behaviorFor(signal.regime)}`,
    );
  }

  // The trace is constructed to visit all three regimes at least once.
  const regimesSeen = new Set(trace.map((t) => computeFusedSignal(t).regime));
  assert(regimesSeen.size === 3, `expected all three regimes to appear, saw: ${[...regimesSeen].join(", ")}`);
}

runPropertyChecks();
runSessionTrace();
console.log("\nGuide 93 demo complete.");
