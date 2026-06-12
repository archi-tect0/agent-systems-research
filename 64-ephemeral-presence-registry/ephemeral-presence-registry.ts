/**
 * Ephemeral Presence Registry with Privacy Blackout
 *
 * Paired devices emit lightweight ambient signals (active / idle / motion /
 * focus / voice). The registry keeps a bounded ring buffer of recent signals
 * per principal — purely in memory, never persisted — and reduces them to a
 * short human-readable presence summary suitable for injection into agent
 * context.
 *
 * A two-layer privacy kill switch sits on top:
 *   HARD — all sensors dark, NO signals tracked at all; an overriding blackout
 *          directive is injected into context instead of a presence summary.
 *   SOFT — self-regulation: outward sensors are off, but presence is still
 *          summarized internally so the agent retains situational awareness.
 *
 * Pure built-ins. Data resets on process exit (presence is ephemeral).
 */

// ── Signal kinds (no enum: 'as const' object + union type) ──────────────────

export const SIGNAL_KIND = {
  active: "active",
  idle: "idle",
  away: "away",
  motion: "motion",
  focus: "focus",
  background: "background",
  voice_start: "voice_start",
  voice_end: "voice_end",
  custom: "custom",
} as const;

export type SignalKind = (typeof SIGNAL_KIND)[keyof typeof SIGNAL_KIND];

/** Signals that count as "the user is actively present right now". */
const ACTIVE_KINDS: ReadonlyArray<SignalKind> = [
  SIGNAL_KIND.active,
  SIGNAL_KIND.focus,
  SIGNAL_KIND.voice_start,
];

export interface PresenceSignal {
  kind: SignalKind;
  deviceId?: string;
  platform?: string;
  intensity?: number; // 0..1, optional (e.g. motion magnitude)
  note?: string;
  ts: number; // epoch ms
}

export interface PresenceState {
  principal: string;
  lastActive: number | null;
  lastSignal: number | null;
  lastKind: SignalKind | null;
  signals: PresenceSignal[]; // ring buffer, newest first
  devicesSeen: Set<string>;
}

// ── Privacy modes (no enum) ─────────────────────────────────────────────────

export const PRIVACY_MODE = {
  off: "off",
  soft: "soft",
  hard: "hard",
} as const;

export type PrivacyMode = (typeof PRIVACY_MODE)[keyof typeof PRIVACY_MODE];

export interface PrivacyState {
  mode: PrivacyMode;
  reason: string;
  activatedAt: number;
  activatedBy: "user" | "agent";
}

const MAX_SIGNALS = 50;

function ago(nowMs: number, then: number): string {
  const ms = nowMs - then;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

/**
 * PresenceRegistry — in-memory ambient signal store with a two-layer privacy
 * blackout. Nothing here is written to disk or a database.
 */
export class PresenceRegistry {
  private presence: Map<string, PresenceState>;
  private privacy: Map<string, PrivacyState>;
  private now: () => number;

  constructor(nowFn?: () => number) {
    this.presence = new Map();
    this.privacy = new Map();
    this.now = nowFn ?? Date.now;
  }

  private getOrCreate(principal: string): PresenceState {
    let p = this.presence.get(principal);
    if (!p) {
      p = {
        principal,
        lastActive: null,
        lastSignal: null,
        lastKind: null,
        signals: [],
        devicesSeen: new Set(),
      };
      this.presence.set(principal, p);
    }
    return p;
  }

  /**
   * Record an ambient signal. Under HARD blackout the signal is DROPPED
   * entirely — no tracking occurs. Returns true if recorded, false if dropped.
   */
  recordSignal(
    principal: string,
    signal: Omit<PresenceSignal, "ts"> & { ts?: number },
  ): boolean {
    const priv = this.privacy.get(principal);
    if (priv && priv.mode === PRIVACY_MODE.hard) {
      return false; // sensors dark — nothing is stored
    }

    const p = this.getOrCreate(principal);
    const full: PresenceSignal = { ...signal, ts: signal.ts ?? this.now() };

    p.signals.unshift(full);
    if (p.signals.length > MAX_SIGNALS) p.signals.length = MAX_SIGNALS;

    p.lastSignal = full.ts;
    p.lastKind = full.kind;
    if (ACTIVE_KINDS.includes(full.kind)) p.lastActive = full.ts;
    if (full.deviceId) p.devicesSeen.add(full.deviceId);
    return true;
  }

  getPresence(principal: string): PresenceState | null {
    return this.presence.get(principal) ?? null;
  }

  /**
   * Human-readable presence summary for context injection.
   * Returns null if there is nothing to say. Under SOFT mode the summary is
   * still produced (internal awareness); under HARD mode see getContextLine.
   */
  getPresenceSummary(principal: string): string | null {
    const p = this.presence.get(principal);
    if (!p || p.lastSignal === null) return null;

    const now = this.now();
    const parts: string[] = [];
    if (p.lastActive !== null) parts.push(`active ${ago(now, p.lastActive)}`);
    if (p.lastSignal !== null && p.lastKind) {
      const differs = p.lastActive === null || p.lastSignal !== p.lastActive;
      if (differs) parts.push(`last signal: ${p.lastKind} ${ago(now, p.lastSignal)}`);
    }
    if (p.devicesSeen.size > 1) parts.push(`${p.devicesSeen.size} devices`);
    return parts.length ? parts.join(" · ") : null;
  }

  // ── Privacy kill switch ─────────────────────────────────────────────────

  setPrivacyMode(
    principal: string,
    mode: "hard" | "soft",
    opts: { reason?: string; activatedBy?: "user" | "agent" } = {},
  ): void {
    this.privacy.set(principal, {
      mode,
      reason: opts.reason ?? (mode === "hard" ? "user_request" : "agent_self_regulate"),
      activatedAt: this.now(),
      activatedBy: opts.activatedBy ?? "user",
    });
  }

  clearPrivacyMode(principal: string): void {
    this.privacy.delete(principal);
  }

  getPrivacyState(principal: string): PrivacyState | null {
    return this.privacy.get(principal) ?? null;
  }

  isPrivacyActive(principal: string): boolean {
    return this.privacy.has(principal);
  }

  /**
   * The single line the agent should inject into its context for this
   * principal. Resolution order:
   *   HARD → an overriding blackout directive (no presence info leaks)
   *   SOFT → the normal presence summary (internal awareness retained)
   *   off  → the normal presence summary, or null if nothing to report
   */
  getContextLine(principal: string): string | null {
    const priv = this.privacy.get(principal);
    if (priv && priv.mode === PRIVACY_MODE.hard) {
      const when = ago(this.now(), priv.activatedAt);
      return (
        `PRIVACY_BLACKOUT: all sensors dark. Activated ${when} by ${priv.activatedBy}. ` +
        `Reason: ${priv.reason}. Do NOT listen, watch, or infer presence. ` +
        `Respect this until blackout is cleared.`
      );
    }
    return this.getPresenceSummary(principal);
  }

  /** Forget everything about a principal (e.g. on logout). */
  clear(principal: string): void {
    this.presence.delete(principal);
    this.privacy.delete(principal);
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  // Deterministic clock so the demo output is stable.
  let clock = 1_000_000;
  const reg = new PresenceRegistry(() => clock);
  const who = "principal-1";

  const advance = (ms: number) => {
    clock += ms;
  };

  console.log("=== Recording ambient signals ===");
  reg.recordSignal(who, { kind: SIGNAL_KIND.focus, deviceId: "phone", platform: "mobile" });
  advance(15_000);
  reg.recordSignal(who, { kind: SIGNAL_KIND.motion, deviceId: "phone", intensity: 0.4 });
  advance(20_000);
  reg.recordSignal(who, { kind: SIGNAL_KIND.active, deviceId: "laptop", platform: "desktop" });
  advance(10_000);
  reg.recordSignal(who, { kind: SIGNAL_KIND.idle, deviceId: "laptop" });
  advance(5_000);
  console.log("context line:", reg.getContextLine(who));

  console.log("\n=== Enabling HARD blackout ===");
  reg.setPrivacyMode(who, "hard", { reason: "user pressed privacy button", activatedBy: "user" });
  advance(3_000);
  console.log("context line:", reg.getContextLine(who));

  console.log("\n--- new signals while blacked out are DROPPED ---");
  const stored = reg.recordSignal(who, { kind: SIGNAL_KIND.voice_start, deviceId: "phone" });
  console.log("recordSignal returned:", stored, "(false = dropped, not tracked)");
  console.log("buffered signal count unchanged:", reg.getPresence(who)?.signals.length);

  console.log("\n=== Clearing blackout — tracking resumes ===");
  reg.clearPrivacyMode(who);
  advance(2_000);
  reg.recordSignal(who, { kind: SIGNAL_KIND.active, deviceId: "laptop" });
  console.log("context line:", reg.getContextLine(who));

  console.log("\n=== SOFT mode: sensors off outwardly, presence still summarized ===");
  reg.setPrivacyMode(who, "soft", { reason: "agent self-regulating during sensitive task", activatedBy: "agent" });
  advance(4_000);
  reg.recordSignal(who, { kind: SIGNAL_KIND.focus, deviceId: "laptop" });
  console.log("privacy active:", reg.isPrivacyActive(who), "mode:", reg.getPrivacyState(who)?.mode);
  console.log("context line:", reg.getContextLine(who));
}
