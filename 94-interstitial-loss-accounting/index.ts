// Guide 94 — Interstitial Loss Accounting Across Subsystem Boundaries
//
// Measures, per subsystem, how much information a "full state -> exposed
// subset" projection throws away, and identifies the worst-offending
// subsystem (bottleneck) plus a total system-wide loss budget.

interface SubsystemFrame {
  name: string;
  hostWeights: number[]; // weights over the FULL underlying set
  visibleWeights: number[]; // weights over the EXPOSED subset
  measurementFailed?: boolean;
}

interface SubsystemLoss {
  name: string;
  hostEntropy: number;
  visibleEntropy: number;
  projectionCost: number; // max(0, hostEntropy - visibleEntropy)
  countRatio: number; // |host| / |visible|
}

function normalizedShannonEntropy(weights: number[]): number {
  const positive = weights.filter((w) => w > 0);
  if (positive.length <= 1) return 0;
  const total = positive.reduce((a, b) => a + b, 0);
  const probs = positive.map((w) => w / total);
  const h = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
  const hMax = Math.log2(positive.length);
  return hMax === 0 ? 0 : h / hMax;
}

function computeSubsystemLoss(frame: SubsystemFrame): SubsystemLoss {
  if (frame.measurementFailed) {
    // Fail soft: report a zero-cost frame rather than aborting the budget.
    return {
      name: frame.name,
      hostEntropy: 0,
      visibleEntropy: 0,
      projectionCost: 0,
      countRatio: 1,
    };
  }

  const hostEntropy = normalizedShannonEntropy(frame.hostWeights);
  const visibleEntropy = normalizedShannonEntropy(frame.visibleWeights);
  const projectionCost = Math.max(0, hostEntropy - visibleEntropy);
  const countRatio = frame.hostWeights.length / Math.max(1, frame.visibleWeights.length);

  return { name: frame.name, hostEntropy, visibleEntropy, projectionCost, countRatio };
}

interface Budget {
  perSubsystem: SubsystemLoss[];
  totalCost: number;
  bottleneck: string;
  budgetRatio: number; // totalCost / numSubsystems, bounded in [0,1]
}

function computeBudget(frames: SubsystemFrame[]): Budget {
  const perSubsystem = frames.map(computeSubsystemLoss);
  const totalCost = perSubsystem.reduce((sum, s) => sum + s.projectionCost, 0);
  const bottleneck = perSubsystem.reduce((worst, s) =>
    s.projectionCost > worst.projectionCost ? s : worst,
  ).name;
  const budgetRatio = totalCost / Math.max(1, perSubsystem.length);

  return { perSubsystem, totalCost, bottleneck, budgetRatio };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const frames: SubsystemFrame[] = [
  {
    // Barely narrows its view: host and visible look similar in shape.
    name: "identity",
    hostWeights: [0.5, 0.5],
    visibleWeights: [0.5, 0.5],
  },
  {
    // Aggressively narrows a diverse full set down to one dominant item.
    name: "memory",
    hostWeights: [0.2, 0.2, 0.2, 0.2, 0.2],
    visibleWeights: [1.0],
  },
  {
    name: "world_model",
    hostWeights: [0.4, 0.3, 0.2, 0.1],
    visibleWeights: [0.7, 0.3],
  },
  {
    name: "policy_rules",
    hostWeights: [0.6, 0.4],
    visibleWeights: [0.6, 0.4],
  },
  {
    name: "background_jobs",
    hostWeights: [0.25, 0.25, 0.25, 0.25],
    visibleWeights: [0.5, 0.5],
  },
  {
    // A subsystem whose measurement failed this turn.
    name: "content_store",
    hostWeights: [],
    visibleWeights: [],
    measurementFailed: true,
  },
];

const budget = computeBudget(frames);

console.log("[per-subsystem loss]");
for (const s of budget.perSubsystem) {
  console.log(
    `${s.name.padEnd(16)} host=${s.hostEntropy.toFixed(3)} visible=${s.visibleEntropy.toFixed(3)} cost=${s.projectionCost.toFixed(3)} countRatio=${s.countRatio.toFixed(2)}`,
  );
}
console.log(
  `\ntotalCost=${budget.totalCost.toFixed(3)} bottleneck=${budget.bottleneck} budgetRatio=${budget.budgetRatio.toFixed(3)}`,
);

assert(budget.bottleneck === "memory", `expected "memory" to be the bottleneck, got "${budget.bottleneck}"`);
assert(
  budget.perSubsystem.find((s) => s.name === "content_store")!.projectionCost === 0,
  "a failed measurement must report zero cost, not poison the budget",
);
assert(budget.budgetRatio >= 0 && budget.budgetRatio <= 1, "budgetRatio must stay bounded in [0,1]");

// A degenerate all-maximum-loss case should still stay bounded.
const maxLossFrames: SubsystemFrame[] = Array.from({ length: 4 }, (_, i) => ({
  name: `sub_${i}`,
  hostWeights: [0.25, 0.25, 0.25, 0.25],
  visibleWeights: [1.0],
}));
const maxBudget = computeBudget(maxLossFrames);
assert(maxBudget.budgetRatio <= 1, "even worst-case loss across all subsystems must stay <= 1");

console.log("\n[property checks] bottleneck detection + fail-soft + bounded budget: PASS");
console.log("\nGuide 94 demo complete.");
