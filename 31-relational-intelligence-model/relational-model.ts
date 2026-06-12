/**
 * Relational Intelligence Model
 *
 * Maintains a longitudinal model of one user's relationship with the agent.
 * Signals update automatically from each conversation turn (message length,
 * cadence, word patterns) and explicitly from an observation tool.
 *
 * The model calibrates how the agent responds:
 *   - response density   (minimal ↔ expansive)
 *   - intervention style (reactive ↔ proactive)
 *   - tone               (direct ↔ warm ↔ collaborative)
 *
 * Two principles keep the signals stable:
 *   1. All continuous signals use exponential moving averages, so one unusual
 *      message nudges the model rather than redefining it.
 *   2. Trust grows slowly and is gated through a discrete relationship-phase
 *      ladder (new → familiar → trusted → deep) used to pick response posture.
 *
 * The reference uses an in-memory store; in production back it with a row per
 * user keyed by an account/wallet identifier.
 *
 * Dependencies: none (pure TypeScript).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RelationshipPhase = "new" | "familiar" | "trusted" | "deep";

export interface RelationalState {
  user:               string;
  trustLevel:         number;   // 0..1, grows slowly
  stressSignal:       number;   // 0..1, inferred from message shape
  energySignal:       number;   // 0..1, explicit observation only
  focusSignal:        number;   // 0..1, explicit observation only
  moodValence:        number;   // -1..1, explicit observation only
  sessionCount:       number;
  avgMsgLength:       number;   // EMA of incoming message length
  interventionStyle:  string;
  relationshipPhase:  RelationshipPhase;
  notes:              string[]; // most-recent-first free-text observations
  lastObservationAt:  string;
}

export interface ObservationInput {
  user:               string;
  mood?:              number;   // -1..1
  stress?:            number;   // 0..1
  energy?:            number;   // 0..1
  focus?:             number;   // 0..1
  interventionStyle?: string;
  note?:              string;
}

// ── Tunables ───────────────────────────────────────────────────────────────────

const MSG_LEN_EMA_ALPHA = 0.15;   // weight of the new message in the length EMA
const STRESS_EMA_ALPHA  = 0.30;   // weight of the new stress hint
const TRUST_PER_TURN     = 0.002; // trust gained per interaction
const DEFAULT_MSG_LEN    = 80;
const DEFAULT_STRESS     = 0.3;
const DEFAULT_TRUST      = 0.3;

// Phase ladder thresholds on trustLevel.
const PHASE_DEEP     = 0.85;
const PHASE_TRUSTED  = 0.65;
const PHASE_FAMILIAR = 0.40;

// ── Store (in-memory; swap for a DB row per user) ───────────────────────────────

const _store = new Map<string, RelationalState>();

function blankState(user: string): RelationalState {
  return {
    user,
    trustLevel:        DEFAULT_TRUST,
    stressSignal:      DEFAULT_STRESS,
    energySignal:      0.5,
    focusSignal:       0.5,
    moodValence:       0,
    sessionCount:      0,
    avgMsgLength:      DEFAULT_MSG_LEN,
    interventionStyle: "reactive",
    relationshipPhase: "new",
    notes:             [],
    lastObservationAt: new Date().toISOString(),
  };
}

export function getRelationalState(user: string): RelationalState | null {
  return _store.get(user) ?? null;
}

function upsert(user: string, patch: Partial<RelationalState>): RelationalState {
  const cur = _store.get(user) ?? blankState(user);
  const next: RelationalState = { ...cur, ...patch, lastObservationAt: new Date().toISOString() };
  _store.set(user, next);
  return next;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function phaseForTrust(trust: number): RelationshipPhase {
  if (trust > PHASE_DEEP)     return "deep";
  if (trust > PHASE_TRUSTED)  return "trusted";
  if (trust > PHASE_FAMILIAR) return "familiar";
  return "new";
}

// ── Passive update from message cadence ─────────────────────────────────────────
// Call at the start of every agent turn with the incoming user message.

export function updateFromMessage(user: string, messageText: string): RelationalState {
  const existing = _store.get(user);

  // 1. Average message length (EMA) — captures conversational register over time.
  const currentAvg = existing?.avgMsgLength ?? DEFAULT_MSG_LEN;
  const newAvg = currentAvg * (1 - MSG_LEN_EMA_ALPHA) + messageText.length * MSG_LEN_EMA_ALPHA;

  // 2. Stress inference from message shape: a high proportion of very short
  //    words OR shouted ALL-CAPS words hints at stress. EMA-smoothed.
  const words      = messageText.split(/\s+/).filter(Boolean);
  const wordCount  = Math.max(words.length, 1);
  const shortWords = words.filter(w => w.length <= 3).length;
  const hasAllCaps = (messageText.match(/\b[A-Z]{3,}\b/g) ?? []).length > 0;
  const stressHint = (shortWords / wordCount > 0.6 || hasAllCaps) ? 0.6 : 0.3;
  const currentStress = existing?.stressSignal ?? DEFAULT_STRESS;
  const newStress = currentStress * (1 - STRESS_EMA_ALPHA) + stressHint * STRESS_EMA_ALPHA;

  // 3. Trust grows slowly with each interaction (and is capped at 1).
  const currentTrust = existing?.trustLevel ?? DEFAULT_TRUST;
  const newTrust = Math.min(currentTrust + TRUST_PER_TURN, 1.0);

  // 4. Interaction counter + discrete phase ladder.
  const sessionCount = (existing?.sessionCount ?? 0) + 1;
  const relationshipPhase = phaseForTrust(newTrust);

  return upsert(user, {
    avgMsgLength:  newAvg,
    stressSignal:  newStress,
    trustLevel:    newTrust,
    sessionCount,
    relationshipPhase,
  });
}

// ── Explicit observation (from a tool) ──────────────────────────────────────────

export function observeUser(input: ObservationInput): RelationalState {
  const patch: Partial<RelationalState> = {};
  if (input.mood   !== undefined) patch.moodValence  = clamp(input.mood, -1, 1);
  if (input.stress !== undefined) patch.stressSignal = clamp(input.stress, 0, 1);
  if (input.energy !== undefined) patch.energySignal = clamp(input.energy, 0, 1);
  if (input.focus  !== undefined) patch.focusSignal  = clamp(input.focus, 0, 1);
  if (input.interventionStyle)    patch.interventionStyle = input.interventionStyle;

  if (input.note) {
    const existing = _store.get(input.user);
    const notes = [`${new Date().toISOString().slice(0, 16)}Z: ${input.note}`, ...(existing?.notes ?? [])];
    patch.notes = notes.slice(0, 20);
  }

  return upsert(input.user, patch);
}

// ── Context injection ───────────────────────────────────────────────────────────
// Compact, label-bucketed summary to prepend to the agent's system prompt.

export function getRelationalContext(user: string): string {
  const s = _store.get(user);
  if (!s) return "";

  const bucket3 = (v: number, hi = 0.7, mid = 0.4) => (v > hi ? "high" : v > mid ? "moderate" : "low");
  const moodLabel  = s.moodValence > 0.3 ? "positive" : s.moodValence < -0.3 ? "tense" : "neutral";
  const trustLabel = s.trustLevel  > 0.65 ? "high" : s.trustLevel > 0.4 ? "building" : "early";

  return [
    "",
    "RELATIONAL:",
    `Phase:${s.relationshipPhase} Trust:${trustLabel} Stress:${bucket3(s.stressSignal)} ` +
      `Energy:${bucket3(s.energySignal)} Focus:${bucket3(s.focusSignal)} Mood:${moodLabel}`,
    `Style:${s.interventionStyle} Sessions:${s.sessionCount}`,
    "",
  ].join("\n");
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const user = "user-001";

  // Calm, longer messages over many turns → trust climbs, low stress.
  for (let i = 0; i < 60; i++) {
    updateFromMessage(user, "Could you walk me through how the scheduler decides when to fire a job?");
  }
  console.log("After 60 calm turns:");
  console.log(getRelationalContext(user));

  // A burst of short, shouted messages → stress signal rises.
  updateFromMessage(user, "STOP");
  updateFromMessage(user, "NO not that");
  updateFromMessage(user, "WHY did it do that");
  console.log("After a stressed burst:");
  console.log(getRelationalContext(user));

  // Explicit observation from a tool.
  observeUser({ user, energy: 0.8, focus: 0.9, mood: 0.5, interventionStyle: "proactive", note: "shipping a release today" });
  console.log("After explicit observation:");
  console.log(getRelationalContext(user));
  console.log("Notes:", getRelationalState(user)?.notes);
}
