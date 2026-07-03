/**
 * Guide 88 — Cognitive Curriculum Engine
 *
 * Part of the token evacuation strategy.
 *
 * Demonstrates:
 *   A. Simulated turn telemetry with C_r (Compression Efficiency Ratio)
 *   B. Gating matrix — FLAT-LINE / MIDDLE / FRICTION classification
 *   C. CurriculumAnomaly isolation + priority assignment
 *   D. Regression alert detection
 *   E. Intent clustering (proxy for embedding similarity)
 *   F. Maturity gate (MIN_CLUSTER_SIZE = 4)
 *   G. Curriculum structuring — negative + positive training pairs
 *   H. Bake queue submission (REPAIR-first ordering)
 *   I. Novelty meter — session-level C_r averages
 *   J. Post-bake C_r projection
 */

import { createHash } from "node:crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const FRICTION_THRESHOLD  = 0.50;  // C_r ≤ this → FRICTION state (curriculum candidate)
const FLATLINE_THRESHOLD  = 0.80;  // C_r ≥ this → FLAT-LINE state (familiar territory)
const MIN_CLUSTER_SIZE    = 4;     // minimum anomalies per cluster to enter bake queue
const POST_BAKE_CR        = 0.85;  // projected C_r for formerly-friction turns after bake
const BASE_FINGERPRINT    = "kylum-os:latest";

// ── Types ─────────────────────────────────────────────────────────────────────

type Outcome  = "success" | "user_correction" | "stalled";
type State    = "FLAT-LINE" | "MIDDLE" | "FRICTION";
type Priority = "REPAIR" | "EXPAND" | "BAKE" | "REGRESSION";

interface TurnRecord {
  turnId:      string;
  sessionId:   string;
  intent:      string;      // proxy for embedding cluster in demo
  userMessage: string;
  agentResponse: string;
  rawTokens:   number;
  compressedTokens: number;
  cr:          number;      // Compression Efficiency Ratio
  outcome:     Outcome;
}

interface CurriculumAnomaly {
  anomalyId:          string;
  baseModelFingerprint: string;
  compressionRatio:   number;   // C_r
  rawImprovisation:   string;   // uncompressible delta (tokens the SQ stack could not reduce)
  stateVariables:     Record<string, unknown>;
  interactionOutcome: Outcome;
  // derived
  priority:           Priority;
  intent:             string;
  turnId:             string;
  sessionId:          string;
}

interface TrainingPair {
  anomalyId: string;
  priority:  Priority;
  intent:    string;
  negative:  { instruction: string; response: string };  // raw improvisation
  positive:  { instruction: string; response: string };  // SQ-ZT ideal form
}

interface CurriculumCluster {
  intent:    string;
  priority:  Priority;
  anomalies: CurriculumAnomaly[];
  pairs:     TrainingPair[];
  mature:    boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeCr(raw: number, compressed: number): number {
  return parseFloat(((raw - compressed) / raw).toFixed(3));
}

function classifyState(cr: number): State {
  if (cr >= FLATLINE_THRESHOLD)  return "FLAT-LINE";
  if (cr <= FRICTION_THRESHOLD)  return "FRICTION";
  return "MIDDLE";
}

function assignPriority(state: State, outcome: Outcome): Priority {
  if (state === "FLAT-LINE") {
    return outcome === "success" ? "BAKE" : "REGRESSION";
  }
  if (state === "FRICTION") {
    return (outcome === "user_correction" || outcome === "stalled") ? "REPAIR" : "EXPAND";
  }
  // MIDDLE zone — not a curriculum candidate in the primary filter
  return outcome === "success" ? "EXPAND" : "REPAIR";
}

function anomalyId(turn: TurnRecord): string {
  const payload = `${turn.sessionId}:${turn.turnId}:${turn.cr}:${turn.outcome}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Extract the uncompressible delta — in production this is the residual after
 *  all SQ layers have consumed their matches. In this demo we simulate it as
 *  the portion of the response that "escaped" compression, estimated by token savings. */
function extractDelta(turn: TurnRecord): string {
  const escapedFraction = 1 - turn.cr;
  const escapedWords    = Math.round(turn.rawTokens * escapedFraction * 0.75); // ~0.75 words/token
  // Deterministic slice of the response proportional to escaped content
  const words = turn.agentResponse.split(" ");
  return words.slice(0, Math.min(escapedWords, words.length)).join(" ");
}

/** Simulate the positive (SQ-ZT ideal) form of a response.
 *  In production a local SLM generates this. Here we produce a deterministic
 *  idealized version showing the SQ-ZT wire format. */
function synthesizePositive(turn: TurnRecord): string {
  return `[SQCE:${turn.intent}|outcome=${turn.outcome === "success" ? "ok" : "corrected"}] ` +
         `→ [SQDS:${turn.intent}_result|confidence=high|source=weight_resident]`;
}

// ── A. Turn Log (Simulated Telemetry) ────────────────────────────────────────

function buildTurnLog(): TurnRecord[] {
  // 20 turns across 3 sessions, deterministic C_r values.
  // Session A: wallet_ops (familiar domain — mostly FLAT-LINE with a few novel patches)
  // Session B: defi_yield (new domain — mostly FRICTION)
  // Session C: covenant_legal (new domain — mostly FRICTION)
  return [
    // ── Session A: wallet_ops ────────────────────────────────────────────────
    { turnId:"A1", sessionId:"sess_A", intent:"wallet_ops",
      userMessage:"What is my ETH balance?",
      agentResponse:"Your primary wallet balance is 4.2180 ETH.",
      rawTokens:84, compressedTokens:11,
      cr: computeCr(84, 11), outcome:"success" },

    { turnId:"A2", sessionId:"sess_A", intent:"wallet_ops",
      userMessage:"Show me the last 17 vault entries.",
      agentResponse:"I've retrieved your ETH vault — 17 entries, last updated 2 minutes ago.",
      rawTokens:69, compressedTokens:9,
      cr: computeCr(69, 9), outcome:"success" },

    { turnId:"A3", sessionId:"sess_A", intent:"vault_novel",
      userMessage:"Explain the entropy model used for my vault's key derivation.",
      agentResponse:"The vault key derivation uses HKDF-SHA256 with your passkey-bound PRF seed. " +
                    "Entropy is drawn from the WebAuthn authenticator's internal counter combined " +
                    "with a per-device salt established at pairing time. The effective key space " +
                    "is 256 bits after HKDF expansion, independent of passphrase length.",
      rawTokens:72, compressedTokens:56,
      cr: computeCr(72, 56), outcome:"user_correction" },

    { turnId:"A4", sessionId:"sess_A", intent:"vault_novel",
      userMessage:"What is the forward secrecy guarantee of my vault sessions?",
      agentResponse:"Each vault session derives an ephemeral key via X25519 ECDH. " +
                    "The session key is discarded after the session closes. " +
                    "Compromise of a past session key does not expose future sessions " +
                    "because each ECDH handshake is independent.",
      rawTokens:68, compressedTokens:51,
      cr: computeCr(68, 51), outcome:"user_correction" },

    { turnId:"A5", sessionId:"sess_A", intent:"wallet_ops",
      userMessage:"Execute a transfer of 0.3 ETH.",
      agentResponse:"The ETH transfer completed successfully — tx hash 0xdeadbeef1234abcd.",
      rawTokens:91, compressedTokens:10,
      cr: computeCr(91, 10), outcome:"success" },

    { turnId:"A6", sessionId:"sess_A", intent:"vault_novel",
      userMessage:"Can you describe the key rotation schedule?",
      agentResponse:"Key rotation is triggered by three conditions: a guardian attestation event, " +
                    "a passkey re-enrollment, or the 90-day automatic rotation policy. " +
                    "Each rotation derives a new vault key from the updated PRF seed.",
      rawTokens:77, compressedTokens:54,
      cr: computeCr(77, 54), outcome:"success" },

    { turnId:"A7", sessionId:"sess_A", intent:"wallet_ops",
      userMessage:"Show fee report for the last transfer.",
      agentResponse:"The transaction fee totaled 0.0023 ETH, charged from your primary wallet.",
      rawTokens:62, compressedTokens:8,
      cr: computeCr(62, 8), outcome:"user_correction" },   // ← REGRESSION

    // ── Session B: defi_yield ────────────────────────────────────────────────
    { turnId:"B1", sessionId:"sess_B", intent:"defi_yield",
      userMessage:"Compare Aave v3 vs Compound v3 yield on USDC right now.",
      agentResponse:"Aave v3 currently shows 4.82% APY on USDC supply, driven by borrow demand " +
                    "from leveraged ETH positions. Compound v3 shows 4.31% APY. " +
                    "The spread is 51 bps. Risk-adjusted, Aave carries higher smart-contract " +
                    "exposure due to its broader collateral set.",
      rawTokens:96, compressedTokens:63,
      cr: computeCr(96, 63), outcome:"user_correction" },

    { turnId:"B2", sessionId:"sess_B", intent:"defi_yield",
      userMessage:"What is the impermanent loss risk for ETH/USDC at current volatility?",
      agentResponse:"At 30-day realized volatility of 42%, a ±20% ETH price move produces " +
                    "approximately 1.9% impermanent loss against a 50/50 ETH/USDC position. " +
                    "This is offset by fee income at typical Uniswap v3 pool utilization.",
      rawTokens:88, compressedTokens:54,
      cr: computeCr(88, 54), outcome:"success" },

    { turnId:"B3", sessionId:"sess_B", intent:"wallet_ops",
      userMessage:"What is my USDC staking balance?",
      agentResponse:"Your USDC staking wallet balance is 250.0000 USDC.",
      rawTokens:75, compressedTokens:10,
      cr: computeCr(75, 10), outcome:"success" },

    { turnId:"B4", sessionId:"sess_B", intent:"defi_yield",
      userMessage:"Explain the risk of Aave's e-mode and how it affects my collateral ratio.",
      agentResponse:"Aave e-mode allows correlated assets to use higher LTV ratios. " +
                    "For ETH-correlated assets, LTV rises to 90% vs the standard 80%. " +
                    "This increases capital efficiency but also increases liquidation risk " +
                    "if correlation breaks — as it did during the May 2022 ETH drawdown.",
      rawTokens:93, compressedTokens:56,
      cr: computeCr(93, 56), outcome:"user_correction" },

    { turnId:"B5", sessionId:"sess_B", intent:"defi_yield",
      userMessage:"Model the yield curve sensitivity for a Curve 3pool position.",
      agentResponse:"Curve 3pool yield depends on stablecoin depeg risk and swap volume. " +
                    "At current base rates the 7-day APY is 1.4%, with CRV rewards adding " +
                    "2.1% at current CRV price. Duration sensitivity is low since all " +
                    "positions are stablecoins.",
      rawTokens:86, compressedTokens:50,
      cr: computeCr(86, 50), outcome:"success" },

    { turnId:"B6", sessionId:"sess_B", intent:"defi_yield",
      userMessage:"What is the governance attack surface on Compound v3?",
      agentResponse:"Compound v3 governance attack surface includes timelock bypass via " +
                    "proposal spam if quorum is misconfigured, and delegate concentration " +
                    "risk — the top 5 delegates control 38% of voting weight. " +
                    "A coordinated 51% vote can drain protocol reserves without a " +
                    "guardian veto.",
      rawTokens:98, compressedTokens:52,
      cr: computeCr(98, 52), outcome:"user_correction" },

    // ── Session C: covenant_legal ────────────────────────────────────────────
    { turnId:"C1", sessionId:"sess_C", intent:"covenant_legal",
      userMessage:"What legal jurisdiction does a covenant NFT bind to?",
      agentResponse:"A covenant NFT does not bind to any specific legal jurisdiction by default — " +
                    "it is an on-chain commitment enforced by the smart contract, not a court. " +
                    "Parties seeking legal enforceability must attach an off-chain arbitration " +
                    "clause and ensure the counterparty has provided informed consent under " +
                    "their local contract law.",
      rawTokens:104, compressedTokens:62,
      cr: computeCr(104, 62), outcome:"user_correction" },

    { turnId:"C2", sessionId:"sess_C", intent:"covenant_legal",
      userMessage:"Can a covenant NFT be used as evidence in a civil dispute?",
      agentResponse:"On-chain covenant NFTs can serve as timestamped evidence of intent " +
                    "and agreement terms. Courts in common law jurisdictions have admitted " +
                    "blockchain records as documentary evidence under the business records " +
                    "exception. Admissibility depends on chain-of-custody attestation " +
                    "for the signing wallet.",
      rawTokens:91, compressedTokens:54,
      cr: computeCr(91, 54), outcome:"success" },

    { turnId:"C3", sessionId:"sess_C", intent:"wallet_ops",
      userMessage:"Show my guardian attestation status.",
      agentResponse:"Fetching guardian attestation from the recovery oracle — this may take a moment.",
      rawTokens:79, compressedTokens:11,
      cr: computeCr(79, 11), outcome:"success" },

    { turnId:"C4", sessionId:"sess_C", intent:"covenant_legal",
      userMessage:"What happens if one party to a covenant NFT is a sanctioned entity?",
      agentResponse:"If a counterparty is added to an OFAC sanctions list after covenant creation, " +
                    "interaction with the NFT — including transfers, attestations, and settlement " +
                    "calls — may constitute a sanctions violation for US persons. " +
                    "The smart contract has no OFAC oracle; compliance is the responsibility " +
                    "of the interacting wallet.",
      rawTokens:99, compressedTokens:51,
      cr: computeCr(99, 51), outcome:"user_correction" },

    { turnId:"C5", sessionId:"sess_C", intent:"covenant_legal",
      userMessage:"Explain the inheritance mechanics if a covenant holder's wallet is lost.",
      agentResponse:"Covenant inheritance is not handled by the base contract. " +
                    "Recovery requires the guardian attestation flow in the DBK identity layer: " +
                    "a quorum of guardians can attest to a key rotation, transferring covenant " +
                    "control to a new wallet. Without guardian quorum, the covenant is " +
                    "permanently bound to the lost wallet.",
      rawTokens:87, compressedTokens:52,
      cr: computeCr(87, 52), outcome:"success" },

    { turnId:"C6", sessionId:"sess_C", intent:"wallet_ops",
      userMessage:"What is my dispatch_write grant status?",
      agentResponse:"I'm checking your dispatch_write grant — status: active.",
      rawTokens:71, compressedTokens:10,
      cr: computeCr(71, 10), outcome:"success" },

    { turnId:"C7", sessionId:"sess_C", intent:"covenant_legal",
      userMessage:"Does the covenant NFT standard support conditional release clauses?",
      agentResponse:"The current DBK covenant standard supports three settlement triggers: " +
                    "mutual attestation, timelock expiry, and guardian override. " +
                    "Conditional release based on external oracle data is not natively supported — " +
                    "it requires a custom resolver contract that the covenant points to " +
                    "via a conditionURI field.",
      rawTokens:94, compressedTokens:53,
      cr: computeCr(94, 53), outcome:"user_correction" },
  ];
}

// ── B. Gating Matrix ──────────────────────────────────────────────────────────

function applyGatingMatrix(turns: TurnRecord[]): {
  flatLine:   TurnRecord[];
  middle:     TurnRecord[];
  friction:   TurnRecord[];
} {
  const flatLine: TurnRecord[]  = [];
  const middle:   TurnRecord[]  = [];
  const friction: TurnRecord[]  = [];

  for (const t of turns) {
    const s = classifyState(t.cr);
    if (s === "FLAT-LINE") flatLine.push(t);
    else if (s === "MIDDLE") middle.push(t);
    else friction.push(t);
  }
  return { flatLine, middle, friction };
}

// ── C. Anomaly Isolation ──────────────────────────────────────────────────────

function isolateAnomalies(friction: TurnRecord[]): {
  candidates: CurriculumAnomaly[];
  regressions: CurriculumAnomaly[];
  bake: CurriculumAnomaly[];
} {
  const candidates:  CurriculumAnomaly[] = [];
  const regressions: CurriculumAnomaly[] = [];
  const bake:        CurriculumAnomaly[] = [];

  // also classify flat-line turns for bake/regression
  for (const t of friction) {
    const state    = classifyState(t.cr);
    const priority = assignPriority(state, t.outcome);
    const anomaly: CurriculumAnomaly = {
      anomalyId:            anomalyId(t),
      baseModelFingerprint: BASE_FINGERPRINT,
      compressionRatio:     t.cr,
      rawImprovisation:     extractDelta(t),
      stateVariables:       { sessionId: t.sessionId, outcome: t.outcome, cr: t.cr },
      interactionOutcome:   t.outcome,
      priority,
      intent:    t.intent,
      turnId:    t.turnId,
      sessionId: t.sessionId,
    };
    if (priority === "REPAIR" || priority === "EXPAND") candidates.push(anomaly);
    else if (priority === "BAKE")       bake.push(anomaly);
    else if (priority === "REGRESSION") regressions.push(anomaly);
  }
  return { candidates, regressions, bake };
}

function isolateRegressions(flatLine: TurnRecord[]): CurriculumAnomaly[] {
  return flatLine
    .filter(t => t.outcome !== "success")
    .map(t => ({
      anomalyId:            anomalyId(t),
      baseModelFingerprint: BASE_FINGERPRINT,
      compressionRatio:     t.cr,
      rawImprovisation:     extractDelta(t),
      stateVariables:       { sessionId: t.sessionId, outcome: t.outcome, cr: t.cr },
      interactionOutcome:   t.outcome,
      priority:             "REGRESSION" as Priority,
      intent:    t.intent,
      turnId:    t.turnId,
      sessionId: t.sessionId,
    }));
}

// ── E. Intent Clustering ──────────────────────────────────────────────────────

function clusterAnomalies(anomalies: CurriculumAnomaly[]): Map<string, CurriculumAnomaly[]> {
  const clusters = new Map<string, CurriculumAnomaly[]>();
  for (const a of anomalies) {
    const group = clusters.get(a.intent) ?? [];
    group.push(a);
    clusters.set(a.intent, group);
  }
  return clusters;
}

function clusterPriority(anomalies: CurriculumAnomaly[]): Priority {
  // Cluster inherits highest priority among its members
  return anomalies.some(a => a.priority === "REPAIR") ? "REPAIR" : "EXPAND";
}

// ── G. Curriculum Structuring ────────────────────────────────────────────────

function structureCurriculum(
  clusters: Map<string, CurriculumAnomaly[]>,
  allTurns: TurnRecord[],
): CurriculumCluster[] {
  const turnMap = new Map(allTurns.map(t => [t.turnId, t]));
  const result: CurriculumCluster[] = [];

  for (const [intent, anomalies] of clusters) {
    const mature  = anomalies.length >= MIN_CLUSTER_SIZE;
    const priority = clusterPriority(anomalies);

    const pairs: TrainingPair[] = anomalies.map(a => {
      const turn = turnMap.get(a.turnId)!;
      return {
        anomalyId: a.anomalyId,
        priority:  a.priority,
        intent,
        negative: {
          instruction: turn.userMessage,
          response:    turn.agentResponse,   // raw improvisation — uncompressed form
        },
        positive: {
          instruction: turn.userMessage,
          response:    synthesizePositive(turn),  // SQ-ZT ideal form
        },
      };
    });

    result.push({ intent, priority, anomalies, pairs, mature });
  }

  // Sort: mature first, then by priority (REPAIR before EXPAND)
  return result.sort((a, b) => {
    if (a.mature !== b.mature) return a.mature ? -1 : 1;
    if (a.priority !== b.priority) return a.priority === "REPAIR" ? -1 : 1;
    return 0;
  });
}

// ── H. Bake Queue ─────────────────────────────────────────────────────────────

interface BakeQueueEntry {
  intent:      string;
  priority:    Priority;
  pairCount:   number;
  repairCount: number;
  expandCount: number;
  pairs:       TrainingPair[];
}

function buildBakeQueue(clusters: CurriculumCluster[]): BakeQueueEntry[] {
  return clusters
    .filter(c => c.mature)
    .map(c => ({
      intent:      c.intent,
      priority:    c.priority,
      pairCount:   c.pairs.length,
      repairCount: c.anomalies.filter(a => a.priority === "REPAIR").length,
      expandCount: c.anomalies.filter(a => a.priority === "EXPAND").length,
      pairs:       c.pairs,
    }));
}

// ── I. Novelty Meter (Session-Level) ─────────────────────────────────────────

function sessionNoveltyMeter(turns: TurnRecord[]): Map<string, {
  avgCr: number; frictionCount: number; flatLineCount: number; sessionLabel: string;
}> {
  const sessions = new Map<string, TurnRecord[]>();
  for (const t of turns) {
    const g = sessions.get(t.sessionId) ?? [];
    g.push(t);
    sessions.set(t.sessionId, g);
  }

  const meter = new Map<string, {
    avgCr: number; frictionCount: number; flatLineCount: number; sessionLabel: string;
  }>();

  for (const [sid, sts] of sessions) {
    const avgCr        = parseFloat((sts.reduce((s, t) => s + t.cr, 0) / sts.length).toFixed(3));
    const frictionCount = sts.filter(t => classifyState(t.cr) === "FRICTION").length;
    const flatLineCount = sts.filter(t => classifyState(t.cr) === "FLAT-LINE").length;
    const sessionLabel  = avgCr >= FLATLINE_THRESHOLD ? "familiar" :
                          avgCr <= FRICTION_THRESHOLD  ? "high-novelty" : "expanding";
    meter.set(sid, { avgCr, frictionCount, flatLineCount, sessionLabel });
  }
  return meter;
}

// ── J. Post-Bake Projection ──────────────────────────────────────────────────

function projectPostBake(frictionTurns: TurnRecord[], matureIntents: Set<string>): {
  turnId: string; intent: string; currentCr: number; projectedCr: number;
}[] {
  return frictionTurns
    .filter(t => matureIntents.has(t.intent))
    .map(t => ({
      turnId:      t.turnId,
      intent:      t.intent,
      currentCr:   t.cr,
      projectedCr: POST_BAKE_CR,
    }));
}

// ── Main Demo ─────────────────────────────────────────────────────────────────

function main() {
  console.log("=== Guide 88 — Cognitive Curriculum Engine ===\n");
  console.log("Token Evacuation Strategy: Capstone Module\n");

  // ── A. Telemetry ─────────────────────────────────────────────────────────
  console.log("A. Simulating turn telemetry (20 turns / 3 sessions)…");
  const turns = buildTurnLog();
  console.log(`   Total turns logged: ${turns.length}`);

  // ── B. Gating Matrix ──────────────────────────────────────────────────────
  console.log("\nB. Applying compression gating matrix…");
  const { flatLine, middle, friction } = applyGatingMatrix(turns);
  console.log(`   FLAT-LINE  (C_r ≥ ${FLATLINE_THRESHOLD}): ${flatLine.length} turns  — familiar, execute & discard`);
  console.log(`   MIDDLE     (0.50–0.79):            ${middle.length} turns  — expanding boundary`);
  console.log(`   FRICTION   (C_r ≤ ${FRICTION_THRESHOLD}): ${friction.length} turns  — high-novelty, isolate`);
  console.log("\n   Turn-by-turn reading:");
  for (const t of turns) {
    const state    = classifyState(t.cr);
    const priority = assignPriority(state, t.outcome);
    const icon = state === "FLAT-LINE" ? "⬜" : state === "FRICTION" ? "🔴" : "🟡";
    console.log(
      `   ${icon} ${t.turnId} [${t.sessionId}] C_r=${t.cr.toFixed(3)}  ` +
      `${state.padEnd(10)} ${priority.padEnd(12)} "${t.intent}"`
    );
  }

  // ── C. Anomaly Isolation ──────────────────────────────────────────────────
  console.log("\nC. Isolating curriculum anomalies from friction turns…");
  const { candidates, regressions: frictionRegressions } = isolateAnomalies(friction);
  const regressions = [...frictionRegressions, ...isolateRegressions(flatLine)];
  const repairCount  = candidates.filter(a => a.priority === "REPAIR").length;
  const expandCount  = candidates.filter(a => a.priority === "EXPAND").length;
  console.log(`   Curriculum candidates: ${candidates.length}  (REPAIR: ${repairCount}, EXPAND: ${expandCount})`);

  // ── D. Regression Alerts ──────────────────────────────────────────────────
  console.log(`\nD. Regression alerts: ${regressions.length} turn(s) flagged — NOT queued for bake`);
  for (const r of regressions) {
    console.log(
      `   ⚠️  ${r.turnId} [${r.sessionId}] C_r=${r.compressionRatio.toFixed(3)} ` +
      `"${r.intent}" — familiar pattern returned wrong result → human review`
    );
  }

  // ── E. Intent Clustering ──────────────────────────────────────────────────
  console.log("\nE. Clustering anomalies by improvisation intent…");
  const clusterMap = clusterAnomalies(candidates);
  for (const [intent, members] of clusterMap) {
    const priority = clusterPriority(members);
    const mature   = members.length >= MIN_CLUSTER_SIZE;
    console.log(
      `   ${mature ? "✅" : "⏳"} "${intent}" — ${members.length} anomalies  ` +
      `priority=${priority}  mature=${mature ? `yes (≥ ${MIN_CLUSTER_SIZE})` : `no (< ${MIN_CLUSTER_SIZE})`}`
    );
  }

  // ── F. Maturity Gate ──────────────────────────────────────────────────────
  console.log(`\nF. Maturity gate (MIN_CLUSTER_SIZE = ${MIN_CLUSTER_SIZE})…`);
  const mature   = [...clusterMap.entries()].filter(([,v]) => v.length >= MIN_CLUSTER_SIZE);
  const immature = [...clusterMap.entries()].filter(([,v]) => v.length <  MIN_CLUSTER_SIZE);
  console.log(`   ${mature.length} cluster(s) mature → entering bake queue`);
  if (immature.length)
    console.log(`   ${immature.length} cluster(s) immature → held pending more anomalies (${immature.map(([k]) => `"${k}"`).join(", ")})`);

  // ── G. Curriculum Structuring ─────────────────────────────────────────────
  console.log("\nG. Structuring curriculum (negative + positive training pairs)…");
  const clusters  = structureCurriculum(clusterMap, turns);
  for (const c of clusters) {
    if (!c.mature) continue;
    console.log(`\n   Cluster: "${c.intent}"  priority=${c.priority}  ${c.pairs.length} pairs`);
    for (const p of c.pairs.slice(0, 2)) {   // show first 2 per cluster
      console.log(`     [${p.priority}] ${p.anomalyId}`);
      console.log(`       ─ negative: "${p.negative.response.slice(0, 72).replace(/\n/g, " ")}…"`);
      console.log(`       + positive: "${p.positive.response}"`);
    }
    if (c.pairs.length > 2) console.log(`     … +${c.pairs.length - 2} more pairs`);
  }

  // ── H. Bake Queue ─────────────────────────────────────────────────────────
  console.log("\nH. Bake queue (REPAIR-first, mature clusters only)…");
  const bakeQueue = buildBakeQueue(clusters);
  for (let i = 0; i < bakeQueue.length; i++) {
    const e = bakeQueue[i];
    console.log(
      `   [${i + 1}] "${e.intent}"  priority=${e.priority}  ` +
      `pairs=${e.pairCount} (REPAIR=${e.repairCount} EXPAND=${e.expandCount})`
    );
  }

  // ── I. Novelty Meter ──────────────────────────────────────────────────────
  console.log("\nI. Session novelty meter (C_r averages)…");
  const meter = sessionNoveltyMeter(turns);
  for (const [sid, m] of meter) {
    const bar = "█".repeat(Math.round(m.avgCr * 20)).padEnd(20, "░");
    console.log(
      `   ${sid}: avg C_r=${m.avgCr.toFixed(3)}  [${bar}]  ` +
      `${m.sessionLabel.padEnd(12)} friction=${m.frictionCount}  flat=${m.flatLineCount}`
    );
  }

  // ── J. Post-Bake Projection ────────────────────────────────────────────────
  console.log("\nJ. Post-bake C_r projection (mature clusters only)…");
  const matureIntents = new Set(bakeQueue.map(e => e.intent));
  const projection    = projectPostBake(friction, matureIntents);
  let totalSaved = 0;
  for (const p of projection) {
    const savedEstimate = Math.round(
      (p.projectedCr - p.currentCr) *
      (turns.find(t => t.turnId === p.turnId)!.rawTokens)
    );
    totalSaved += savedEstimate;
    console.log(
      `   ${p.turnId} "${p.intent}"  C_r: ${p.currentCr.toFixed(3)} → ${p.projectedCr.toFixed(3)}` +
      `  (~${savedEstimate} tok/turn saved after bake)`
    );
  }
  console.log(`\n   Projected total savings on friction turns (post-bake): ~${totalSaved} tokens`);
  console.log(`   Novelty meter for mature-intent sessions would spike from ≤0.50 → ≥0.80`);
  console.log(`   Wire clears. Meter resets. Next novel domain becomes the new frontier.\n`);

  // ── Assertions ────────────────────────────────────────────────────────────
  console.log("Assertions…");
  const assert = (label: string, cond: boolean) => {
    console.log(`   ${cond ? "✅" : "❌"} ${label}`);
    if (!cond) throw new Error(`FAIL: ${label}`);
  };

  assert("20 turns telemetered",              turns.length === 20);
  assert(`${friction.length} friction turns (C_r ≤ ${FRICTION_THRESHOLD})`,
                                              friction.length === 13);
  assert(`${flatLine.length} flat-line turns (C_r ≥ ${FLATLINE_THRESHOLD})`,
                                              flatLine.length === 7);
  assert("1 regression alert",                regressions.length === 1);
  assert(`${candidates.length} curriculum candidates`,
                                              candidates.length === 13);
  assert("REPAIR count correct",              repairCount === 8);
  assert("EXPAND count correct",              expandCount === 5);
  assert("3 intent clusters",                 clusterMap.size === 3);
  assert("2 mature clusters",                 mature.length === 2);
  assert("1 immature cluster",                immature.length === 1);
  assert("bake queue has 2 entries",          bakeQueue.length === 2);
  assert("bake queue REPAIR-first ordering",
    bakeQueue[0].priority === "REPAIR" || bakeQueue.every(e => e.priority === "REPAIR"));
  assert("all pairs have negative + positive", clusters
    .filter(c => c.mature)
    .every(c => c.pairs.every(p => p.negative.response.length > 0 && p.positive.response.length > 0)));
  assert("novelty meter computed for all 3 sessions", meter.size === 3);
  assert("post-bake projection covers mature-intent friction turns",
    projection.length === friction.filter(t => matureIntents.has(t.intent)).length);
  assert("post-bake C_r ≥ FLATLINE_THRESHOLD for all projected turns",
    projection.every(p => p.projectedCr >= FLATLINE_THRESHOLD));
  assert("total post-bake savings > 0",       totalSaved > 0);

  console.log("\n=== PASS ===\n");
}

main();
