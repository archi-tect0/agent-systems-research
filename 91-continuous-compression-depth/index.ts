// Guide 91 — Continuous Compression-Depth Signal
//
// Compares three views of the same underlying entropy measurement:
//   1. raw per-sample miss-rate (noisy)
//   2. binary hysteresis mode flag (stable but all-or-nothing)
//   3. continuous depth signal + a graduated downstream window size
//
// Run: node index.ts   (or: npx tsx index.ts)

const ALPHA = 0.30;           // EMA smoothing factor
const UPPER = 0.55;           // mode flips permissive -> restricted above this
const LOWER = 0.35;           // mode flips restricted -> permissive below this
const MID   = (UPPER + LOWER) / 2;
const K     = 12;             // sigmoid steepness, tuned to saturate inside [LOWER, UPPER]

const MAX_WINDOW = 20;
const MIN_WINDOW = 6;
const SHRINK     = 0.7;

function sigmoidDepth(ema: number): number {
  return 1 / (1 + Math.exp(-K * (ema - MID)));
}

function graduatedWindow(depth: number): number {
  return Math.max(MIN_WINDOW, Math.round(MAX_WINDOW * (1 - depth * SHRINK)));
}

type Mode = "permissive" | "restricted";

class DepthTracker {
  private ema: number = 0;
  private mode: Mode = "permissive";

  step(missRate: number): { ema: number; mode: Mode; depth: number; window: number } {
    this.ema = ALPHA * missRate + (1 - ALPHA) * this.ema;

    if (this.mode === "permissive" && this.ema >= UPPER) this.mode = "restricted";
    else if (this.mode === "restricted" && this.ema <= LOWER) this.mode = "permissive";

    const depth = sigmoidDepth(this.ema);
    const window = this.mode === "restricted" ? graduatedWindow(depth) : MAX_WINDOW;

    return { ema: this.ema, mode: this.mode, depth, window };
  }
}

// ── Simulate a stream that deliberately hovers near the hysteresis boundary ──
// (real traffic does this whenever content novelty is borderline — e.g. a
// session mixing familiar boilerplate with a burst of new terminology).
function buildNoisyBoundaryTrace(n: number): number[] {
  const trace: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = 0.47 + 0.11 * Math.sin(i / 3);      // hovers around MID, occasionally crossing UPPER
    const noise = (Math.sin(i * 7.13) * 0.5 + 0.5) * 0.06 - 0.03;
    trace.push(Math.min(1, Math.max(0, base + noise)));
  }
  return trace;
}

const trace = buildNoisyBoundaryTrace(40);
const tracker = new DepthTracker();

console.log("tick | missRate |   ema   |   mode      | depth | window");
console.log("-----|----------|---------|-------------|-------|-------");

const windows: number[] = [];
const modes: Mode[] = [];

trace.forEach((missRate, i) => {
  const { ema, mode, depth, window } = tracker.step(missRate);
  windows.push(window);
  modes.push(mode);
  console.log(
    `${String(i + 1).padStart(4)} |  ${missRate.toFixed(3)}  | ${ema.toFixed(3)}  | ${mode.padEnd(11)} | ${depth.toFixed(3)} | ${window}`,
  );
});

// ── Assertions ────────────────────────────────────────────────────────────
console.log("\n--- Assertions ---");

// 1. Within a run of consecutive "restricted" samples, the graduated window
//    never jumps by more than a small step between adjacent ticks — i.e. the
//    continuous signal doesn't thrash even while the underlying ema wobbles.
let maxAdjacentWindowJump = 0;
for (let i = 1; i < windows.length; i++) {
  if (modes[i] === "restricted" && modes[i - 1] === "restricted") {
    maxAdjacentWindowJump = Math.max(maxAdjacentWindowJump, Math.abs(windows[i] - windows[i - 1]));
  }
}
console.log(`Max adjacent window jump while in restricted mode: ${maxAdjacentWindowJump} entries (bounded, no cliff).`);
if (maxAdjacentWindowJump > 4) {
  throw new Error("Graduated window is not smooth — jumped more than expected between adjacent ticks.");
}

// 2. Count mode flips — with the hysteresis band this should be small even
//    though the trace hovers near the midpoint; without a band (both
//    thresholds equal to MID) it would flip on almost every tick.
let flips = 0;
for (let i = 1; i < modes.length; i++) {
  if (modes[i] !== modes[i - 1]) flips++;
}
console.log(`Mode flips over ${trace.length} ticks with hysteresis band [${LOWER}, ${UPPER}]: ${flips}`);

// Compare against a naive single-threshold (no hysteresis) tracker to show
// what the guide's design decision is actually buying you.
let naiveMode: Mode = "permissive";
let naiveEma = 0;
let naiveFlips = 0;
trace.forEach((missRate) => {
  naiveEma = ALPHA * missRate + (1 - ALPHA) * naiveEma;
  const next: Mode = naiveEma >= MID ? "restricted" : "permissive";
  if (next !== naiveMode) naiveFlips++;
  naiveMode = next;
});
console.log(`Mode flips with a single threshold at MID=${MID.toFixed(2)} (no hysteresis band): ${naiveFlips}`);

if (naiveFlips <= flips) {
  throw new Error("Expected the hysteresis band to reduce mode flips relative to a single threshold.");
}

console.log("\nOK — continuous depth signal is smooth, and the hysteresis band measurably reduces boundary thrashing.");
