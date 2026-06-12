/**
 * Competence-Gated On-Device Distillation Router
 *
 * A routing layer that decides, per turn, whether a request should be handled
 * by a large cloud model or a smaller local (on-device) model. The decision is
 * driven by DEMONSTRATED COMPETENCE: every time the cloud model handles a turn,
 * that decision is logged as a training pair. Once a given intent has produced
 * enough training pairs that the local model can plausibly have learned it,
 * "simple" instances of that intent are routed locally and only hard instances
 * still escalate to the cloud.
 *
 * Scoring uses three cheap, DB-free signals:
 *   1. Tool entropy      — fewer tools selected ⇒ simpler turn ⇒ higher score.
 *   2. Intent familiarity — known-simple intents score higher.
 *   3. Message length     — shorter messages score higher.
 *
 * Two hard gates run before scoring:
 *   - Pair gate:    an intent must have accumulated >= minPairs cloud decisions
 *                   before ANY local routing is allowed for it.
 *   - Escalate gate: high-stakes intents always go to the cloud.
 *
 * This file keeps the training-pair store in memory; production persists it.
 *
 * Dependencies: none (Node built-ins only).
 */

// ── Config ────────────────────────────────────────────────────────────────────

export interface RouterConfig {
  minPairs:            number;   // pairs an intent needs before local routing
  confidenceThreshold: number;   // 0..1 — score at/above which we route local
  simpleIntents:       Set<string>;
  alwaysEscalate:      Set<string>;
}

export const DEFAULT_CONFIG: RouterConfig = {
  minPairs:            20,
  confidenceThreshold: 0.75,
  simpleIntents: new Set([
    "remember", "recall", "navigate", "weather", "translate",
    "timezone", "greeting", "chitchat", "explain",
  ]),
  alwaysEscalate: new Set([
    "spend", "token_swap", "vault_write", "threat_respond",
    "run_code", "generate_image", "delegate_subtask",
  ]),
};

// ── Decision shape ────────────────────────────────────────────────────────────

export interface RoutingDecision {
  routeLocal: boolean;
  score:      number;
  reason:     string;
  pairCount:  number;   // pairs accumulated for THIS intent
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * The router holds a per-intent count of logged cloud decisions (training
 * pairs). An intent graduates to local-eligible once it crosses minPairs.
 */
export class CompetenceRouter {
  config: RouterConfig;
  pairCounts: Map<string, number>;

  constructor(config: RouterConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.pairCounts = new Map<string, number>();
  }

  /** Record that the cloud model handled an instance of `intentKind`. */
  recordCloudDecision(intentKind: string): number {
    const next = (this.pairCounts.get(intentKind) ?? 0) + 1;
    this.pairCounts.set(intentKind, next);
    return next;
  }

  getPairCount(intentKind: string): number {
    return this.pairCounts.get(intentKind) ?? 0;
  }

  /**
   * Decide where this turn should run.
   *
   * @param intentKind The classified intent of the turn.
   * @param toolNames  Tools the selector picked for this turn.
   * @param messageLen Character length of the user message.
   */
  route(intentKind: string, toolNames: string[], messageLen: number): RoutingDecision {
    const pairCount = this.getPairCount(intentKind);

    // Gate 1 — not enough demonstrated competence for this intent yet.
    if (pairCount < this.config.minPairs) {
      return {
        routeLocal: false, score: 0, pairCount,
        reason: `pair_gate: ${pairCount}/${this.config.minPairs} pairs for "${intentKind}"`,
      };
    }

    // Gate 2 — high-stakes intents never route locally.
    if (this.config.alwaysEscalate.has(intentKind) ||
        toolNames.some(n => this.config.alwaysEscalate.has(n))) {
      return { routeLocal: false, score: 0, pairCount, reason: `always_escalate: "${intentKind}"` };
    }

    // Scoring.
    let score = 0.5; // baseline

    // Signal 1 — intent familiarity.
    if (this.config.simpleIntents.has(intentKind)) score += 0.25;

    // Signal 2 — tool entropy.
    const toolCount = toolNames.length;
    if      (toolCount === 0) score += 0.20;
    else if (toolCount <= 2)  score += 0.10;
    else if (toolCount <= 4)  score += 0.00;
    else if (toolCount <= 8)  score -= 0.10;
    else                      score -= 0.20;

    // Signal 3 — message length.
    if      (messageLen < 60)  score += 0.10;
    else if (messageLen < 200) score += 0.05;
    else if (messageLen > 600) score -= 0.10;

    // Bonus — the more pairs beyond the gate, the more confident we route local.
    score += Math.min(0.10, (pairCount - this.config.minPairs) / 200);

    score = Math.max(0, Math.min(1, score));
    const routeLocal = score >= this.config.confidenceThreshold;

    return {
      routeLocal,
      score:     Math.round(score * 1000) / 1000,
      pairCount,
      reason: routeLocal
        ? `confident: score=${score.toFixed(3)} intent="${intentKind}" tools=${toolCount}`
        : `escalate: score=${score.toFixed(3)} < threshold=${this.config.confidenceThreshold}`,
    };
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const router = new CompetenceRouter({ ...DEFAULT_CONFIG, minPairs: 5 });

  // A stream of incoming turns. Each cloud-handled turn becomes a training pair.
  const stream: Array<{ intent: string; tools: string[]; len: number }> = [
    { intent: "weather", tools: ["get_weather"], len: 30 },
    { intent: "weather", tools: ["get_weather"], len: 28 },
    { intent: "weather", tools: ["get_weather"], len: 35 },
    { intent: "weather", tools: ["get_weather"], len: 22 },
    { intent: "weather", tools: ["get_weather"], len: 31 },
    { intent: "weather", tools: ["get_weather"], len: 40 }, // 6th — past the gate
    { intent: "weather", tools: ["get_weather"], len: 26 },
    { intent: "token_swap", tools: ["token_swap"], len: 45 }, // always escalates
  ];

  console.log(`Gate = ${router.config.minPairs} pairs, threshold = ${router.config.confidenceThreshold}\n`);
  for (const turn of stream) {
    const d = router.route(turn.intent, turn.tools, turn.len);
    console.log(
      `${d.routeLocal ? "LOCAL " : "CLOUD "} [${turn.intent}] ` +
      `pairs=${d.pairCount} score=${d.score} :: ${d.reason}`,
    );
    // Only cloud-handled turns add to the training set.
    if (!d.routeLocal) router.recordCloudDecision(turn.intent);
  }

  console.log("\nFinal weather pair count:", router.getPairCount("weather"));
}
