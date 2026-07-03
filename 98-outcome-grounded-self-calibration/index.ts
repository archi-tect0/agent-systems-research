// Guide 98 — Outcome-Grounded Self-Calibrating Constants Loop
//
// Periodically joins predictions to labeled outcomes, computes bounded
// residual-driven updates, enforces cross-constant invariants with full
// rollback on violation, and separately canary-monitors for slow drift
// against the first-ever calibrated baseline.

const BOOTSTRAP_MIN_SAMPLES = 10;
const MAX_RELATIVE_STEP = 0.08; // no single run may move a constant more than 8%
const DRIFT_ALERT_THRESHOLD = 0.35; // 35% cumulative drift from baseline triggers canary alert

interface Constants {
  warnLevel: number;
  criticalLevel: number;
}

interface AuditRow {
  tick: number;
  status: "committed" | "rolled_back" | "bootstrap_gated";
  proposed?: Constants;
}

function boundedEmaStep(current: number, target: number, maxRelativeStep: number): number {
  const maxDelta = Math.abs(current) * maxRelativeStep || maxRelativeStep;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, target - current));
  return current + delta;
}

function invariantsHold(c: Constants): boolean {
  return c.warnLevel < c.criticalLevel;
}

class CalibrationLoop {
  current: Constants;
  baseline: Constants;
  auditLog: AuditRow[] = [];
  private tick = 0;

  constructor(initial: Constants) {
    this.current = { ...initial };
    this.baseline = { ...initial };
  }

  run(residuals: { warnLevel: number; criticalLevel: number }, sampleCount: number) {
    this.tick++;
    if (sampleCount < BOOTSTRAP_MIN_SAMPLES) {
      this.auditLog.push({ tick: this.tick, status: "bootstrap_gated" });
      return;
    }

    const proposed: Constants = {
      warnLevel: boundedEmaStep(this.current.warnLevel, this.current.warnLevel + residuals.warnLevel, MAX_RELATIVE_STEP),
      criticalLevel: boundedEmaStep(
        this.current.criticalLevel,
        this.current.criticalLevel + residuals.criticalLevel,
        MAX_RELATIVE_STEP,
      ),
    };

    if (!invariantsHold(proposed)) {
      this.auditLog.push({ tick: this.tick, status: "rolled_back", proposed });
      return; // no partial apply
    }

    this.current = proposed;
    this.auditLog.push({ tick: this.tick, status: "committed", proposed });
  }

  canaryDrift(): { warnDrift: number; criticalDrift: number; alert: boolean } {
    const warnDrift = Math.abs(this.current.warnLevel - this.baseline.warnLevel) / this.baseline.warnLevel;
    const criticalDrift =
      Math.abs(this.current.criticalLevel - this.baseline.criticalLevel) / this.baseline.criticalLevel;
    return {
      warnDrift,
      criticalDrift,
      alert: warnDrift > DRIFT_ALERT_THRESHOLD || criticalDrift > DRIFT_ALERT_THRESHOLD,
    };
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const loop = new CalibrationLoop({ warnLevel: 0.3, criticalLevel: 0.7 });

// 1. Bootstrap gate: too few samples -> gated, no change.
loop.run({ warnLevel: 0.5, criticalLevel: 0.0 }, 3);
assert(loop.auditLog[0].status === "bootstrap_gated", "too few samples should be bootstrap-gated");
assert(loop.current.warnLevel === 0.3, "gated run must not change the constant");

// 2. Bounded step: a large residual still only moves the constant by <= MAX_RELATIVE_STEP.
const before = loop.current.warnLevel;
loop.run({ warnLevel: 5.0, criticalLevel: 0.0 }, 50); // huge residual, enough samples
const after = loop.current.warnLevel;
const relativeChange = Math.abs(after - before) / before;
console.log(`[bounded step] before=${before} after=${after} relativeChange=${relativeChange.toFixed(4)}`);
assert(
  relativeChange <= MAX_RELATIVE_STEP + 1e-9,
  `single run must not exceed the max relative step: got ${relativeChange}`,
);

// 3. Invariant violation -> full rollback, current stays unchanged.
// A large, persistent opposing residual pushes warnLevel up and criticalLevel down each
// tick by a bounded step; eventually the two constants would cross, at which point every
// subsequent tick must be rolled back in full (never partially applied), and the values
// must plateau exactly at their last valid state instead of drifting further.
let rolledBackAt = -1;
let plateau: Constants | null = null;
for (let i = 0; i < 60; i++) {
  loop.run({ warnLevel: 5.0, criticalLevel: -5.0 }, 50);
  const audit = loop.auditLog[loop.auditLog.length - 1];
  if (audit.status === "rolled_back" && rolledBackAt === -1) {
    rolledBackAt = i;
    plateau = { ...loop.current };
  } else if (rolledBackAt !== -1) {
    assert(
      loop.current.warnLevel === plateau!.warnLevel && loop.current.criticalLevel === plateau!.criticalLevel,
      `once rolled back, constants must plateau, not keep drifting (tick ${i})`,
    );
  }
}
assert(rolledBackAt !== -1, "expected the opposing-pressure residual to eventually trigger an invariant rollback");
console.log(`[rollback] first triggered at tick ${rolledBackAt}, plateau =`, plateau);

// 4. Canary drift: simulate many small, individually-valid updates that cumulatively drift past threshold.
const driftLoop = new CalibrationLoop({ warnLevel: 0.3, criticalLevel: 0.9 });
for (let i = 0; i < 40; i++) {
  driftLoop.run({ warnLevel: 0.02, criticalLevel: 0.0 }, 50); // each step individually bounded and valid
}
const drift = driftLoop.canaryDrift();
console.log("[canary check after 40 small valid updates]", drift);
assert(drift.alert, "cumulative small valid updates should eventually trip the canary drift alert");

console.log("\n[audit log tail]", loop.auditLog.slice(-3));
console.log("\n[property checks] bootstrap gate + bounded step + rollback + canary drift: PASS");
console.log("\nGuide 98 demo complete.");
