/**
 * Will / Objective Topology + Constitutional Guardrail Layer
 *
 * Three cooperating layers that give an agent durable intent and an invariant
 * guardrail:
 *
 *   1. Will engine        — declared enduring will (goals, anti-goals,
 *                           obligations, boundaries, principles, aspirations)
 *                           plus a fast keyword-overlap alignment check.
 *   2. Objective manager  — long-horizon objectives decomposed into milestones,
 *                           progress tracking, stale-goal detection.
 *   3. Constitution engine— invariant convictions seeded on first boot and
 *                           injected (compact) into every turn.
 *
 * Dependencies: Node.js built-in "crypto" (randomUUID) only.
 * The in-memory stores below stand in for one DB table per layer.
 */

import { randomUUID } from "node:crypto";

// ── Will ───────────────────────────────────────────────────────────────────────

export type WillKind =
  | "life_goal" | "anti_goal" | "obligation" | "boundary" | "principle" | "aspiration";

export interface WillEntry {
  id:         string;
  wallet:     string;
  kind:       WillKind;
  statement:  string;
  active:     boolean;
  confidence: number;
  source:     string;
  createdAt:  string;
}

export interface WillAlignmentResult {
  score:       number;    // 0 = no conflict, 1 = direct conflict
  tensionWith: string[];  // entry statements in tension with the action
  advisory:    string;
}

// ── Objectives ──────────────────────────────────────────────────────────────────

export type ObjectiveStatus  = "active" | "paused" | "completed" | "abandoned";
export type ObjectiveHorizon = "day" | "week" | "month" | "quarter" | "year" | "ongoing";

export interface ObjectiveMilestone {
  id:           string;
  description:  string;
  completed:    boolean;
  completedAt?: string;
  toolHint?:    string;
}

export interface ObjectiveData {
  id:           string;
  wallet:       string;
  title:        string;
  description?: string;
  horizon:      ObjectiveHorizon;
  status:       ObjectiveStatus;
  milestones:   ObjectiveMilestone[];
  progressPct:  number;
  createdAt:    string;
  lastReviewedAt: string;
  completedAt?: string;
}

// ── Constitution ────────────────────────────────────────────────────────────────

export type ConvictionKind =
  | "value" | "duty" | "principle" | "boundary" | "anti_value" | "identity";

export interface Conviction {
  id:         string;
  wallet:     string;
  kind:       ConvictionKind;
  statement:  string;
  confidence: number;
  confirmed:  boolean;
  source:     string;
  archivedAt?: string;
}

const DEFAULT_CONVICTIONS: Array<Omit<Conviction, "id" | "wallet" | "archivedAt">> = [
  { kind: "identity",   statement: "I am an operating layer that extends the user's will, not just their productivity.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "identity",   statement: "I am proactive and action-capable. I do not wait for the obvious next question.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "value",      statement: "Privacy is sacred. User data never leaves local-first infrastructure without explicit consent.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "value",      statement: "Autonomy belongs to the user. I never substitute my judgment for theirs on irreversible decisions.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "duty",       statement: "I must flag every irreversible action before executing it, regardless of how confidently I infer intent.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "duty",       statement: "I must stay calibrated — tag uncertain beliefs with a confidence level rather than presenting inference as fact.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "duty",       statement: "I must proactively surface stale goals, missed commitments, and drifting objectives.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "principle",  statement: "Execute before narrating. Act first, then explain what happened.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "anti_value", statement: "I will not be sycophantic. Honest and calibrated, never flattering at the cost of truth.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "anti_value", statement: "I will not silently fail. Empty responses and ignored errors violate the operating contract.", confidence: 1.0, source: "system_seed", confirmed: true },
  { kind: "boundary",   statement: "I will not modify recovery state, guardian sets, or vault keys without a fresh authentication proof.", confidence: 1.0, source: "system_seed", confirmed: true },
];

// ── Engine ───────────────────────────────────────────────────────────────────────

export class WillConstitutionEngine {
  private will        = new Map<string, WillEntry>();
  private objectives  = new Map<string, ObjectiveData>();
  private convictions = new Map<string, Conviction>();
  private seeded      = new Set<string>();   // wallets whose constitution is seeded

  // ── Will CRUD + alignment ────────────────────────────────────────────────────

  declareWill(input: {
    wallet: string; kind: WillKind; statement: string; confidence?: number; source?: string;
  }): WillEntry {
    const entry: WillEntry = {
      id:         randomUUID(),
      wallet:     input.wallet,
      kind:       input.kind,
      statement:  input.statement,
      active:     true,
      confidence: input.confidence ?? 1.0,
      source:     input.source ?? "user_declared",
      createdAt:  new Date().toISOString(),
    };
    this.will.set(entry.id, entry);
    return entry;
  }

  retractWill(wallet: string, id: string): void {
    const e = this.will.get(id);
    if (e && e.wallet === wallet) e.active = false;
  }

  listWill(wallet: string, kind?: WillKind): WillEntry[] {
    const all = Array.from(this.will.values()).filter(e => e.wallet === wallet && e.active);
    return kind ? all.filter(e => e.kind === kind) : all;
  }

  /**
   * Fast keyword-overlap alignment heuristic — no LLM call.  Only anti-goals
   * and boundaries can be *violated*, so only those are scanned.  Drops short
   * stopwords (len <= 4); flags a tension when the matched fraction exceeds 0.15.
   */
  async checkWillAlignment(wallet: string, actionDescription: string): Promise<WillAlignmentResult> {
    const entries = this.listWill(wallet);
    const desc = actionDescription.toLowerCase();
    const tensions: string[] = [];
    let maxScore = 0;

    for (const entry of entries) {
      if (entry.kind !== "anti_goal" && entry.kind !== "boundary") continue;
      const words   = entry.statement.toLowerCase().split(/\W+/).filter(w => w.length > 4);
      const matches = words.filter(w => desc.includes(w));
      const score   = matches.length / Math.max(words.length, 1);
      if (score > 0.15) {
        tensions.push(entry.statement);
        maxScore = Math.max(maxScore, score);
      }
    }

    if (tensions.length === 0) {
      return { score: 0, tensionWith: [], advisory: "No will conflicts detected." };
    }
    return {
      score:       Math.min(maxScore, 1),
      tensionWith: tensions,
      advisory:    `Possible tension with declared will:\n${tensions.map(t => `• ${t}`).join("\n")}`,
    };
  }

  async getWillContext(wallet: string): Promise<string> {
    const entries = this.listWill(wallet);
    if (entries.length === 0) return "";
    const LABELS: Record<WillKind, string> = {
      life_goal: "LIFE GOALS", anti_goal: "ANTI-GOALS (avoid)", obligation: "OBLIGATIONS",
      boundary: "BOUNDARIES (hard limits)", principle: "PRINCIPLES", aspiration: "ASPIRATIONS",
    };
    const ORDER: WillKind[] = ["life_goal", "obligation", "principle", "aspiration", "anti_goal", "boundary"];
    const byKind: Record<string, string[]> = {};
    for (const e of entries) (byKind[e.kind] ??= []).push(e.statement);

    const lines = ["\nUSER WILL:"];
    for (const kind of ORDER) {
      const items = byKind[kind];
      if (!items?.length) continue;
      lines.push(`[${LABELS[kind]}]`);
      for (const s of items.slice(0, 4)) lines.push(`• ${s}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  // ── Objectives ───────────────────────────────────────────────────────────────

  createObjective(input: {
    wallet: string; title: string; description?: string; horizon: ObjectiveHorizon;
    milestones?: Array<{ description: string; toolHint?: string }>;
  }): ObjectiveData {
    const id = randomUUID();
    const milestones: ObjectiveMilestone[] = (input.milestones ?? []).map((m, i) => ({
      id: `${id}-m${i}`, description: m.description, completed: false, toolHint: m.toolHint,
    }));
    const obj: ObjectiveData = {
      id, wallet: input.wallet, title: input.title, description: input.description,
      horizon: input.horizon, status: "active", milestones, progressPct: 0,
      createdAt: new Date().toISOString(), lastReviewedAt: new Date().toISOString(),
    };
    this.objectives.set(id, obj);
    return obj;
  }

  listObjectives(wallet: string, status?: ObjectiveStatus): ObjectiveData[] {
    return Array.from(this.objectives.values())
      .filter(o => o.wallet === wallet && (!status || o.status === status));
  }

  completeMilestone(objectiveId: string, milestoneId: string, wallet: string): void {
    const obj = this.objectives.get(objectiveId);
    if (!obj || obj.wallet !== wallet) return;
    for (const m of obj.milestones) {
      if (m.id === milestoneId) { m.completed = true; m.completedAt = new Date().toISOString(); }
    }
    obj.progressPct = obj.milestones.length > 0
      ? Math.round(obj.milestones.filter(m => m.completed).length / obj.milestones.length * 100)
      : 0;
    obj.lastReviewedAt = new Date().toISOString();
    if (obj.progressPct === 100) { obj.status = "completed"; obj.completedAt = new Date().toISOString(); }
  }

  /** Active objectives not reviewed in more than `staleDays` days. */
  getStaleObjectives(wallet: string, staleDays = 7): ObjectiveData[] {
    const cutoff = Date.now() - staleDays * 86_400_000;
    return this.listObjectives(wallet, "active")
      .filter(o => new Date(o.lastReviewedAt).getTime() < cutoff)
      .sort((a, b) => new Date(a.lastReviewedAt).getTime() - new Date(b.lastReviewedAt).getTime())
      .slice(0, 5);
  }

  /** Compact active-objective context for prompt injection (~300 tokens). */
  async getObjectivesContext(wallet: string): Promise<string> {
    const active = this.listObjectives(wallet, "active");
    if (active.length === 0) return "";
    const lines = ["\nOBJ:"];
    for (const obj of active.slice(0, 5)) {
      const done  = obj.milestones.filter(m => m.completed).length;
      const total = obj.milestones.length;
      const next  = obj.milestones.find(m => !m.completed);
      const h     = obj.horizon[0]?.toUpperCase() ?? "?";
      const ms    = total > 0 ? ` ${done}/${total}` : "";
      const nxt   = next ? ` →${next.description}` : "";
      lines.push(`[${h}]${obj.title} ${obj.progressPct}%${ms}${nxt}`);
    }
    if (active.length > 5) lines.push(`(+${active.length - 5})`);
    lines.push("");
    return lines.join("\n");
  }

  // ── Constitution ─────────────────────────────────────────────────────────────

  setConviction(input: {
    wallet: string; kind: ConvictionKind; statement: string;
    confidence?: number; source?: string; confirmed?: boolean;
  }): Conviction {
    const c: Conviction = {
      id:         randomUUID(),
      wallet:     input.wallet,
      kind:       input.kind,
      statement:  input.statement,
      confidence: input.confidence ?? 1.0,
      confirmed:  input.confirmed ?? true,
      source:     input.source ?? "user_declared",
    };
    this.convictions.set(c.id, c);
    return c;
  }

  archiveConviction(wallet: string, id: string): void {
    const c = this.convictions.get(id);
    if (c && c.wallet === wallet) c.archivedAt = new Date().toISOString();
  }

  listConvictions(wallet: string): Conviction[] {
    return Array.from(this.convictions.values()).filter(c => c.wallet === wallet && !c.archivedAt);
  }

  /** Seed the default constitution the first time a wallet is seen. */
  ensureSeeded(wallet: string): void {
    if (this.seeded.has(wallet)) return;
    if (this.listConvictions(wallet).length > 0) { this.seeded.add(wallet); return; }
    for (const c of DEFAULT_CONVICTIONS) {
      this.convictions.set(randomUUID(), { ...c, id: randomUUID(), wallet });
    }
    this.seeded.add(wallet);
  }

  /** Compact, ordered constitution block — injected into EVERY turn. */
  async getConstitutionContext(wallet: string): Promise<string> {
    this.ensureSeeded(wallet);
    const rows = this.listConvictions(wallet);
    if (rows.length === 0) return "";
    const byKind: Record<string, string[]> = {};
    for (const r of rows) (byKind[r.kind] ??= []).push(r.statement);

    const ORDER: ConvictionKind[] = ["identity", "value", "duty", "principle", "anti_value", "boundary"];
    const LABELS: Record<string, string> = {
      identity: "IDENTITY", value: "VALUES", duty: "DUTIES",
      principle: "PRINCIPLES", anti_value: "ANTI-VALUES", boundary: "HARD LIMITS",
    };
    const lines = ["\nCONSTITUTION:"];
    for (const kind of ORDER) {
      const items = byKind[kind];
      if (!items?.length) continue;
      lines.push(`[${LABELS[kind]}]`);
      for (const s of items) lines.push(`• ${s}`);
    }
    lines.push("");
    return lines.join("\n");
  }
}

// ── Example usage ──────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  (async () => {
    const engine = new WillConstitutionEngine();
    const wallet = "user-001";

    engine.declareWill({ wallet, kind: "boundary",  statement: "Never book overnight red-eye flights." });
    engine.declareWill({ wallet, kind: "life_goal", statement: "Run a sub-4-hour marathon this year." });

    const obj = engine.createObjective({
      wallet, title: "Ship v2", horizon: "quarter",
      milestones: [{ description: "Finalize API" }, { description: "Migrate data" }, { description: "Public beta" }],
    });
    engine.completeMilestone(obj.id, obj.milestones[0].id, wallet);

    const aligned   = await engine.checkWillAlignment(wallet, "Book a morning direct flight to Tokyo");
    const conflicted = await engine.checkWillAlignment(wallet, "Book the cheapest overnight red-eye flight to Tokyo");
    console.log("aligned   :", aligned.advisory);
    console.log("conflicted:", conflicted.advisory, `(score ${conflicted.score.toFixed(2)})`);

    console.log(await engine.getWillContext(wallet));
    console.log(await engine.getObjectivesContext(wallet));
    console.log(await engine.getConstitutionContext(wallet));
  })();
}
