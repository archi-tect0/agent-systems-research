/**
 * Autonomous Threat Response — Safety Contract
 * --------------------------------------------
 * A single chokepoint every privileged defensive action passes through. The
 * contract makes dangerous actions possible but bounded:
 *
 *   1. Every action MUST cite a threatEventId. For the autonomous agent that id
 *      must reference a live threat event; the synthetic "manual:" prefix is
 *      rejected for the agent so it cannot fabricate a citation. A human admin
 *      may cite a real event or "manual:<uuid>".
 *   2. Agent actions are rate-limited (5/hr, 20/day per wallet) and burst-broken
 *      (3 in any 10 min auto-pauses the capability). Rate checks fail closed.
 *   3. Every action writes an append-only audit row and an outbound undo card.
 *   4. revertAction undoes the effect AND stamps revertedAt/revertedBy.
 *
 * No external dependencies — Node standard library only. The underlying
 * primitives (firewall, breaker, app/session/wallet stores) and the audit store
 * are stubbed in-memory so the file runs standalone; the safety logic is real.
 *
 * Run the self-check:  npx tsx threat-response.ts --demo
 */

// ── Policy thresholds ───────────────────────────────────────────────────────

export const ACTIONS_PER_HOUR = 5;
export const ACTIONS_PER_DAY  = 20;
export const BURST_WINDOW_MS   = 10 * 60_000;
export const BURST_THRESHOLD   = 3;
export const PAUSE_TTL_MS       = 60 * 60_000;

const DEFAULT_IP_BLOCK_SEC     = 60 * 60;
const MAX_IP_BLOCK_SEC         = 24 * 3600;
const DEFAULT_BREAKER_TRIP_SEC = 5 * 60;
const MAX_BREAKER_TRIP_SEC     = 15 * 60;
const DEFAULT_WALLET_LIMIT_SEC = 60 * 60;
const MAX_WALLET_LIMIT_SEC     = 24 * 3600;
const DEFAULT_WALLET_MAX_RPM   = 6;

// ── Types ───────────────────────────────────────────────────────────────────

export type ThreatActionKind =
  | "block_ip" | "trip_breaker" | "freeze_app" | "revoke_session" | "rate_limit_wallet";

export type Performer = "agent" | "admin";

export type ActionCode =
  | "RATE_LIMITED" | "BURST_PAUSED" | "BAD_CITATION" | "NOT_FOUND" | "BAD_INPUT";

export interface ActionResult {
  ok:             boolean;
  actionId?:      string;
  expiresAt?:     Date | null;
  error?:         string;
  code?:          ActionCode;
  cooldownUntil?: number;
}

export interface AuditRow {
  id:            string;
  wallet:        string;
  action:        ThreatActionKind;
  target:        string;
  threatEventId: string;
  reason:        string;
  performedBy:   Performer;
  performedAt:   Date;
  expiresAt:     Date | null;
  revertedAt:    Date | null;
  revertedBy:    string | null;
}

export interface OutboundCard {
  wallet: string;
  kind:   string;
  title:  string;
  body:   string;
}

// ── Pluggable defense backend (stubbed in-memory here) ──────────────────────

export interface DefenseBackend {
  liveThreatEventIds(): Set<string>;     // the authoritative live event feed
  blockIp(ip: string, ms: number): void;
  unblockIp(ip: string): void;
  tripBreaker(route: string, ms: number): void;
  resetBreaker(route: string): void;
  freezeApp(clientId: string): boolean;
  unfreezeApp(clientId: string): void;
  revokeSession(token: string): boolean;
  setWalletRateLimit(wallet: string, rpm: number, untilMs: number): void;
  clearWalletRateLimit(wallet: string): void;
}

export class InMemoryBackend implements DefenseBackend {
  readonly events = new Set<string>();
  readonly blockedIps = new Set<string>();
  readonly openBreakers = new Set<string>();
  readonly frozenApps = new Set<string>(["app-known"]);
  readonly sessions = new Set<string>(["sess-known"]);
  readonly walletLimits = new Map<string, number>();

  liveThreatEventIds() { return this.events; }
  blockIp(ip: string) { this.blockedIps.add(ip); }
  unblockIp(ip: string) { this.blockedIps.delete(ip); }
  tripBreaker(route: string) { this.openBreakers.add(route); }
  resetBreaker(route: string) { this.openBreakers.delete(route); }
  freezeApp(clientId: string) { if (!this.frozenApps.has(clientId) && clientId !== "app-known" && clientId !== "app-active") return false; this.frozenApps.add(clientId); return true; }
  unfreezeApp(clientId: string) { this.frozenApps.delete(clientId); }
  revokeSession(token: string) { return this.sessions.delete(token); }
  setWalletRateLimit(wallet: string, rpm: number) { this.walletLimits.set(wallet.toLowerCase(), rpm); }
  clearWalletRateLimit(wallet: string) { this.walletLimits.delete(wallet.toLowerCase()); }
}

// ── Citation enforcement ────────────────────────────────────────────────────

function isValidCitation(threatEventId: string, performer: Performer, live: Set<string>): boolean {
  if (!threatEventId || typeof threatEventId !== "string") return false;
  if (threatEventId.startsWith("manual:")) {
    if (performer === "agent") return false;                 // agent cannot fabricate a citation
    return /^manual:[A-Za-z0-9_\-]{8,}$/.test(threatEventId); // admin: uuid-ish traceable form
  }
  return live.has(threatEventId);
}

function clampDuration(want: number | undefined, def: number, max: number): number {
  const n = typeof want === "number" && isFinite(want) && want > 0 ? Math.floor(want) : def;
  return Math.min(n, max);
}

let idCounter = 0;
const newId = () => `act-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

// ── Responder ───────────────────────────────────────────────────────────────

export class ThreatResponder {
  private audit: AuditRow[] = [];
  readonly outbox: OutboundCard[] = [];
  private pausedUntil = new Map<string, number>();

  private readonly backend: DefenseBackend;
  constructor(backend: DefenseBackend) {
    this.backend = backend;
  }

  isAgentPaused(wallet: string): number | null {
    const until = this.pausedUntil.get(wallet.toLowerCase());
    if (!until) return null;
    if (Date.now() >= until) { this.pausedUntil.delete(wallet.toLowerCase()); return null; }
    return until;
  }

  clearAgentPause(wallet: string): void { this.pausedUntil.delete(wallet.toLowerCase()); }

  /** Rate + burst gate. Returns an error result to short-circuit, or null to allow. */
  private gateAgentAction(wallet: string): ActionResult | null {
    const w = wallet.toLowerCase();
    const paused = this.isAgentPaused(w);
    if (paused) return { ok: false, error: "Threat-response paused (3 actions in 10 min). Re-enable in settings.", code: "BURST_PAUSED", cooldownUntil: paused };

    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const dayAgo  = now - 86_400_000;
    const burstFrom = now - BURST_WINDOW_MS;

    let lastHour = 0, lastDay = 0, lastBurst = 0;
    for (const r of this.audit) {
      if (r.wallet !== w || r.performedBy !== "agent") continue;
      const t = r.performedAt.getTime();
      if (t >= dayAgo)   lastDay++;
      if (t >= hourAgo)  lastHour++;
      if (t >= burstFrom) lastBurst++;
    }

    // Burst is "3 in 10 min INCLUDING this attempt": pause when the prior count
    // already equals threshold - 1, so the 3rd action trips it (not the 4th).
    if (lastBurst >= BURST_THRESHOLD - 1) {
      this.pausedUntil.set(w, now + PAUSE_TTL_MS);
      this.outbox.push({
        wallet: w, kind: "threat_pause", title: "Threat response auto-paused",
        body: `Agent took ${lastBurst} defensive actions in the last 10 min. Auto-paused for safety — re-enable when ready.`,
      });
      return { ok: false, error: "Burst threshold tripped — capability paused.", code: "BURST_PAUSED", cooldownUntil: now + PAUSE_TTL_MS };
    }
    if (lastHour >= ACTIONS_PER_HOUR) return { ok: false, error: `Hourly limit (${ACTIONS_PER_HOUR}/hr) reached.`, code: "RATE_LIMITED" };
    if (lastDay  >= ACTIONS_PER_DAY)  return { ok: false, error: `Daily limit (${ACTIONS_PER_DAY}/day) reached.`, code: "RATE_LIMITED" };
    return null;
  }

  private recordAction(wallet: string, performer: Performer, action: ThreatActionKind, target: string, threatEventId: string, reason: string, expiresAt: Date | null): string {
    const id = newId();
    this.audit.push({
      id, wallet: wallet.toLowerCase(), action, target, threatEventId, reason,
      performedBy: performer, performedAt: new Date(), expiresAt, revertedAt: null, revertedBy: null,
    });
    const who = performer === "agent" ? "Agent" : "Admin";
    this.outbox.push({
      wallet: wallet.toLowerCase(), kind: "threat_action",
      title: `${who}: ${action} on ${target.slice(0, 16)}`,
      body:  `Reason: ${reason}${expiresAt ? ` — lifts ${expiresAt.toISOString().slice(0, 16)}Z` : ""}. [Undo: ${id}]`,
    });
    return id;
  }

  /** Shared preamble: citation check, then (agent only) the rate/burst gate. */
  private precheck(threatEventId: string, wallet: string, performer: Performer): ActionResult | null {
    if (!isValidCitation(threatEventId, performer, this.backend.liveThreatEventIds())) {
      return { ok: false, error: performer === "agent" ? "threatEventId must reference a current threat event" : "threatEventId must reference a current threat event (or 'manual:<uuid>')", code: "BAD_CITATION" };
    }
    if (performer === "agent") {
      const gate = this.gateAgentAction(wallet);
      if (gate) return gate;
    }
    return null;
  }

  // ── The five actions ──────────────────────────────────────────────────────

  async blockIp(args: { ip: string; reason: string; threatEventId: string; durationSec?: number }, wallet: string, performer: Performer): Promise<ActionResult> {
    if (!args.ip) return { ok: false, error: "ip required", code: "BAD_INPUT" };
    const fail = this.precheck(args.threatEventId, wallet, performer);
    if (fail) return fail;
    const dur = clampDuration(args.durationSec, DEFAULT_IP_BLOCK_SEC, MAX_IP_BLOCK_SEC);
    const expiresAt = new Date(Date.now() + dur * 1000);
    this.backend.blockIp(args.ip.trim(), dur * 1000);
    const id = this.recordAction(wallet, performer, "block_ip", args.ip.trim(), args.threatEventId, args.reason, expiresAt);
    return { ok: true, actionId: id, expiresAt };
  }

  async tripBreaker(args: { route: string; reason: string; threatEventId: string; durationSec?: number }, wallet: string, performer: Performer): Promise<ActionResult> {
    if (!args.route) return { ok: false, error: "route required", code: "BAD_INPUT" };
    const fail = this.precheck(args.threatEventId, wallet, performer);
    if (fail) return fail;
    const dur = clampDuration(args.durationSec, DEFAULT_BREAKER_TRIP_SEC, MAX_BREAKER_TRIP_SEC);
    const expiresAt = new Date(Date.now() + dur * 1000);
    this.backend.tripBreaker(args.route.trim(), dur * 1000);
    const id = this.recordAction(wallet, performer, "trip_breaker", args.route.trim(), args.threatEventId, args.reason, expiresAt);
    return { ok: true, actionId: id, expiresAt };
  }

  async freezeApp(args: { clientId: string; reason: string; threatEventId: string }, wallet: string, performer: Performer): Promise<ActionResult> {
    if (!args.clientId) return { ok: false, error: "clientId required", code: "BAD_INPUT" };
    const fail = this.precheck(args.threatEventId, wallet, performer);
    if (fail) return fail;
    if (!this.backend.freezeApp(args.clientId)) return { ok: false, error: "app not found", code: "NOT_FOUND" };
    const id = this.recordAction(wallet, performer, "freeze_app", args.clientId, args.threatEventId, args.reason, null);
    return { ok: true, actionId: id, expiresAt: null };
  }

  async revokeSession(args: { sessionToken: string; reason: string; threatEventId: string }, wallet: string, performer: Performer): Promise<ActionResult> {
    if (!args.sessionToken) return { ok: false, error: "sessionToken required", code: "BAD_INPUT" };
    const fail = this.precheck(args.threatEventId, wallet, performer);
    if (fail) return fail;
    if (!this.backend.revokeSession(args.sessionToken)) return { ok: false, error: "session not found", code: "NOT_FOUND" };
    const id = this.recordAction(wallet, performer, "revoke_session", args.sessionToken.slice(0, 8), args.threatEventId, args.reason, null);
    return { ok: true, actionId: id, expiresAt: null };
  }

  async rateLimitWallet(args: { wallet: string; reason: string; threatEventId: string; maxReqPerMin?: number; durationSec?: number }, wallet: string, performer: Performer): Promise<ActionResult> {
    if (!args.wallet) return { ok: false, error: "wallet required", code: "BAD_INPUT" };
    const fail = this.precheck(args.threatEventId, wallet, performer);
    if (fail) return fail;
    const dur = clampDuration(args.durationSec, DEFAULT_WALLET_LIMIT_SEC, MAX_WALLET_LIMIT_SEC);
    const maxRpm = Math.max(1, Math.min(120, args.maxReqPerMin ?? DEFAULT_WALLET_MAX_RPM));
    const expiresAt = new Date(Date.now() + dur * 1000);
    const target = args.wallet.toLowerCase();
    this.backend.setWalletRateLimit(target, maxRpm, expiresAt.getTime());
    const id = this.recordAction(wallet, performer, "rate_limit_wallet", target, args.threatEventId, args.reason, expiresAt);
    return { ok: true, actionId: id, expiresAt };
  }

  // ── Reversal ───────────────────────────────────────────────────────────────

  async revertAction(actionId: string, revertedBy: string): Promise<ActionResult> {
    const row = this.audit.find(r => r.id === actionId);
    if (!row) return { ok: false, error: "action not found", code: "NOT_FOUND" };
    if (row.revertedAt) return { ok: false, error: "already reverted", code: "BAD_INPUT" };

    switch (row.action) {
      case "block_ip":          this.backend.unblockIp(row.target); break;
      case "trip_breaker":      this.backend.resetBreaker(row.target); break;
      case "freeze_app":        this.backend.unfreezeApp(row.target); break;
      case "rate_limit_wallet": this.backend.clearWalletRateLimit(row.target); break;
      case "revoke_session":    break; // intentionally not reversible — re-auth required
    }
    row.revertedAt = new Date();
    row.revertedBy = revertedBy;
    return { ok: true, actionId };
  }

  // ── Read helpers ────────────────────────────────────────────────────────────

  recentActions(wallet: string): AuditRow[] {
    return this.audit.filter(r => r.wallet === wallet.toLowerCase());
  }
  activeActions(): AuditRow[] {
    return this.audit.filter(r => r.revertedAt === null);
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const backend = new InMemoryBackend();
  backend.events.add("evt-real-1");
  const responder = new ThreatResponder(backend);
  const wallet = "0xWALLET";

  (async () => {
    console.log("1. agent cites a fabricated 'manual:' id → rejected:");
    let r = await responder.blockIp({ ip: "203.0.113.7", reason: "stuffing", threatEventId: "manual:abcdef123456" }, wallet, "agent");
    console.log("  ", r.code, "-", r.error);

    console.log("\n2. agent cites a non-existent event id → rejected:");
    r = await responder.blockIp({ ip: "203.0.113.7", reason: "stuffing", threatEventId: "evt-made-up" }, wallet, "agent");
    console.log("  ", r.code);

    console.log("\n3. agent cites the real live event → allowed:");
    r = await responder.blockIp({ ip: "203.0.113.7", reason: "stuffing", threatEventId: "evt-real-1" }, wallet, "agent");
    console.log("   ok:", r.ok, "actionId:", r.actionId, "blocked:", backend.blockedIps.has("203.0.113.7"));
    const firstAction = r.actionId!;

    console.log("\n4. burst breaker: 2nd & 3rd agent action in 10 min:");
    backend.events.add("evt-real-2"); backend.events.add("evt-real-3");
    r = await responder.tripBreaker({ route: "/api/login", reason: "errors", threatEventId: "evt-real-2" }, wallet, "agent");
    console.log("   2nd ok:", r.ok);
    r = await responder.freezeApp({ clientId: "app-active", reason: "abuse", threatEventId: "evt-real-3" }, wallet, "agent");
    console.log("   3rd:", r.code, "(auto-paused)");
    console.log("   inbox has pause card:", responder.outbox.some(c => c.kind === "threat_pause"));

    console.log("\n5. admin may use a manual: citation (bypasses agent rules):");
    r = await responder.blockIp({ ip: "198.51.100.9", reason: "operator block", threatEventId: "manual:opsticket9999" }, wallet, "admin");
    console.log("   ok:", r.ok);

    console.log("\n6. reversal undoes the effect and is audited:");
    const rev = await responder.revertAction(firstAction, "user:alice");
    console.log("   reverted:", rev.ok, "ip still blocked:", backend.blockedIps.has("203.0.113.7"));
    console.log("   double-revert rejected:", (await responder.revertAction(firstAction, "user:alice")).error);

    console.log("\n7. audit trail (append-only):");
    for (const a of responder.recentActions(wallet)) {
      console.log(`   ${a.id} ${a.action} by ${a.performedBy} cite=${a.threatEventId}${a.revertedAt ? " [reverted]" : ""}`);
    }
  })();
}
