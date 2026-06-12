/**
 * DB-Backed Autonomous Agent Scheduler
 *
 * A single poll loop that wakes every TICK_MS, atomically claims due rows,
 * executes kind-specific work, delivers results through an outbound queue, and
 * re-arms or retires each row. Per-row failure isolation (allSettled + a
 * consecutive-failure breaker) means one bad job never stalls the sweep.
 *
 * The database is behind the ScheduleStore interface. In production the claim
 * is a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`
 * so two overlapping ticks (or two server instances) never double-fire a row.
 * The in-memory store at the bottom emulates that claim for the --demo block.
 *
 * Dependencies: none (pure TypeScript).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ScheduleKind =
  | "reminder"        // one-shot: deliver text
  | "watch"           // recurring: fire when price crosses a threshold
  | "daily_brief"     // daily anchor: fire at a local HH:MM
  | "recurring"       // recurring: deliver text every intervalSec
  | "agenda";         // recurring: LLM decides act-or-skip on a standing goal

export type ScheduleStatus = "pending" | "processing" | "fired" | "failed";

export interface SchedulePayload {
  text?:              string;
  symbol?:            string;
  op?:                "gt" | "lt";
  threshold?:         number;
  intervalSec?:       number;
  goal?:              string;
  briefHour?:         number;       // 0..23, local
  briefMin?:          number;       // 0..59, local
  timezoneOffsetMin?: number;       // minutes east of UTC (e.g. EDT = -240)
}

export interface ScheduleRow {
  id:           string;
  wallet:       string;
  kind:         ScheduleKind;
  payload:      SchedulePayload;
  fireAt:       Date;
  status:       ScheduleStatus;
  failureCount: number;
  lastFiredAt:  Date | null;
  /**
   * Stamped with `now` each time the row is flipped to 'processing'. Used to
   * reclaim ghost rows: a worker that crashes after claiming a row but before
   * re-arming it would otherwise leave the row stuck in 'processing' forever.
   * Only ever consulted for rows still in 'processing', so a stale value left on
   * a row that has since been re-armed to 'pending' is harmless and ignored.
   */
  claimedAt:    Date | null;
}

export interface OutboundMessage {
  wallet:     string;
  scheduleId: string;
  kind:       string;
  title:      string;
  body:       string;
  cards?:     Array<Record<string, unknown>>;
}
// NOTE: the outbound table the client drains must carry a `created_at` timestamp
// (server default now()) with an index on `(wallet, created_at)`. A batch tick
// can queue several messages in the same instant; the client reconstructs the
// correct chronological order by selecting `ORDER BY created_at, id`, not by
// insertion/PK order. Stamping created_at is the deliver() sink's responsibility,
// not this module's, so it isn't a field on OutboundMessage.

type FireOutcome = "fired" | "skip" | "fail";

// ── Constants ──────────────────────────────────────────────────────────────────

const TICK_MS               = 30 * 1000;
const BATCH_SIZE            = 25;
const MAX_CONSECUTIVE_FAILS = 5;
const DAY_MS                = 86_400_000;

// A row claimed (flipped to 'processing') longer ago than this is presumed
// orphaned by a crashed worker and is re-claimable on the next tick.
const STALE_PROCESSING_MS   = 5 * 60 * 1000;
// Hard ceiling on a single expensive (LLM) evaluation so one slow model turn
// can't stall the whole sweep past the tick window.
const EXPENSIVE_JOB_TIMEOUT_MS = 20 * 1000;

const EXPENSIVE_KINDS: ReadonlySet<ScheduleKind> = new Set(["agenda"]);
const RECURRING_KINDS: ReadonlySet<ScheduleKind> = new Set(["recurring", "agenda"]);

// ── Pure helper: bound a promise so a hung call can't block the tick ──────────
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

// ── Pure helper: next daily fire instant (timezone-aware, drift-free) ─────────

/**
 * Compute the next UTC instant at which the user's local clock reads hour:min,
 * given their timezone offset in minutes east of UTC.
 *
 * Derive Y/M/D in the user's local zone first, build the wall-clock target, then
 * convert back to UTC. Roll forward to tomorrow if today's slot is already past
 * (or within the next 30s) so a re-arm right after firing lands on the next day.
 */
export function computeNextDailyFireAt(hour: number, min: number, tzOffsetMin: number): Date {
  const nowLocal = new Date(Date.now() + tzOffsetMin * 60_000); // read .getUTC*() as local
  const Y = nowLocal.getUTCFullYear();
  const M = nowLocal.getUTCMonth();
  const D = nowLocal.getUTCDate();
  let fireAtMs = Date.UTC(Y, M, D, hour, min) - tzOffsetMin * 60_000;
  if (fireAtMs <= Date.now() + 30_000) fireAtMs += DAY_MS;
  return new Date(fireAtMs);
}

// ── Storage interface ─────────────────────────────────────────────────────────

export interface ScheduleStore {
  /**
   * Atomically claim up to `limit` due rows, flipping them to 'processing'
   * (stamping claimedAt = now) and returning them. Emulates
   * UPDATE … FOR UPDATE SKIP LOCKED RETURNING *.
   *
   * A row is "due" if it is pending and fireAt<=now, OR it is a ghost: stuck in
   * 'processing' with claimedAt older than STALE_PROCESSING_MS (its worker
   * crashed mid-fire). Reclaiming ghosts is the crash-recovery heartbeat.
   */
  claimDue(now: Date, limit: number): Promise<ScheduleRow[]>;
  update(id: string, patch: Partial<ScheduleRow>): Promise<void>;
  /** Count pending rows of each kind for a wallet (used by the daily brief). */
  countPendingByKind(wallet: string): Promise<Record<string, number>>;
}

// ── Injected capabilities ─────────────────────────────────────────────────────

export interface SchedulerDeps {
  fetchPrice:   (symbol: string) => Promise<number | null>;
  deliver:      (msg: OutboundMessage) => Promise<void>;
  evaluateGoal: (goal: string, wallet: string) => Promise<{ act: boolean; title?: string; message?: string }>;
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private store: ScheduleStore;
  private deps: SchedulerDeps;

  constructor(store: ScheduleStore, deps: SchedulerDeps) {
    this.store = store;
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One sweep: claim due rows, fire each in isolation, re-arm or retire. */
  async tick(): Promise<{ swept: number; fired: number }> {
    const now = new Date();
    const due = await this.store.claimDue(now, BATCH_SIZE);
    if (due.length === 0) return { swept: 0, fired: 0 };

    const results = await Promise.allSettled(due.map(row => this.processRow(row, now)));
    const fired = results.filter(r => r.status === "fulfilled" && r.value === "fired").length;
    return { swept: due.length, fired };
  }

  private async processRow(row: ScheduleRow, now: Date): Promise<FireOutcome> {
    let outcome: FireOutcome;
    try {
      outcome = await this.fireOne(row);
    } catch {
      await this.store.update(row.id, { failureCount: row.failureCount + 1, status: "pending" });
      return "fail";
    }

    if (outcome === "fail") {
      const fails = row.failureCount + 1;
      await this.store.update(row.id, {
        failureCount: fails,
        status: fails >= MAX_CONSECUTIVE_FAILS ? "failed" : "pending",
      });
      return "fail";
    }

    if (outcome === "skip") {
      if (row.kind === "watch") {
        const jitterMs = Math.floor((60 + Math.random() * 30) * 1000);
        await this.store.update(row.id, { fireAt: new Date(now.getTime() + jitterMs), failureCount: 0, status: "pending" });
      } else if (EXPENSIVE_KINDS.has(row.kind)) {
        const backoffSec = Math.max(300, row.payload.intervalSec ?? 3600);
        await this.store.update(row.id, { fireAt: new Date(now.getTime() + backoffSec * 1000), status: "pending" });
      } else {
        await this.store.update(row.id, { status: "pending" });
      }
      return "skip";
    }

    // outcome === "fired" — re-arm or retire.
    if (row.kind === "daily_brief") {
      const hour = row.payload.briefHour ?? 8;
      const min  = row.payload.briefMin ?? 0;
      const tz   = row.payload.timezoneOffsetMin ?? 0;
      await this.store.update(row.id, {
        fireAt: computeNextDailyFireAt(hour, min, tz), lastFiredAt: now, failureCount: 0, status: "pending",
      });
    } else if (RECURRING_KINDS.has(row.kind) && (row.payload.intervalSec ?? 0) > 0) {
      await this.store.update(row.id, {
        fireAt: new Date(now.getTime() + row.payload.intervalSec! * 1000), lastFiredAt: now, failureCount: 0, status: "pending",
      });
    } else {
      await this.store.update(row.id, { status: "fired", lastFiredAt: now });
    }
    return "fired";
  }

  // ── Kind-specific work ──────────────────────────────────────────────────────

  private async fireOne(row: ScheduleRow): Promise<FireOutcome> {
    const p = row.payload;

    if (row.kind === "reminder") {
      const text = (p.text ?? "").trim();
      await this.deps.deliver({
        wallet: row.wallet, scheduleId: row.id, kind: "reminder",
        title: text.length > 10 ? text.slice(0, 52) : "Reminder",
        body: text || "(no text)",
        cards: [{ type: "stat", title: "Reminder", badge: "Now", desc: text.slice(0, 77) || "Reminder", icon: "🔔" }],
      });
      return "fired";
    }

    if (row.kind === "watch") {
      if (!p.symbol || !p.op || typeof p.threshold !== "number") return "fail";
      const price = await this.deps.fetchPrice(p.symbol);
      if (price === null) return "skip";                              // network blip — retry
      const hit = p.op === "gt" ? price > p.threshold : price < p.threshold;
      if (!hit) return "skip";                                        // not crossed — keep watching
      const pct = ((price - p.threshold) / p.threshold) * 100;
      const dir = p.op === "gt" ? "above" : "below";
      await this.deps.deliver({
        wallet: row.wallet, scheduleId: row.id, kind: "watch_hit",
        title: `${p.symbol.toUpperCase()} ${dir} ${p.threshold} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
        body: `${p.symbol.toUpperCase()} crossed your watch — now at ${price}.`,
      });
      return "fired";
    }

    if (row.kind === "recurring") {
      await this.deps.deliver({
        wallet: row.wallet, scheduleId: row.id, kind: "recurring",
        title: "Scheduled update", body: p.text ?? "(no text)",
      });
      return "fired";
    }

    if (row.kind === "daily_brief") {
      try {
        const tz = p.timezoneOffsetMin ?? 0;
        const localHour = new Date(Date.now() + tz * 60_000).getUTCHours();
        const greeting = localHour < 5 ? "Late night, but here you go"
          : localHour < 12 ? "Good morning"
          : localHour < 18 ? "Good afternoon" : "Good evening";
        const counts = await this.store.countPendingByKind(row.wallet);
        const onPlate = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ") || "Nothing scheduled.";
        await this.deps.deliver({
          wallet: row.wallet, scheduleId: row.id, kind: "daily_brief",
          title: `${greeting}, here's your brief`,
          body: `${greeting}.\n\n**On your plate** — ${onPlate}`,
        });
        return "fired";
      } catch {
        return "skip";   // degrade gracefully — try again next day
      }
    }

    if (row.kind === "agenda") {
      const goal = (p.goal ?? "").trim();
      if (!goal) return "fail";
      try {
        const decision = await withTimeout(
          this.deps.evaluateGoal(goal, row.wallet), EXPENSIVE_JOB_TIMEOUT_MS,
        );
        if (decision.act && (decision.message ?? "").trim()) {
          await this.deps.deliver({
            wallet: row.wallet, scheduleId: row.id, kind: "agenda",
            title: (decision.title ?? "Agenda update").slice(0, 80),
            body: decision.message!.trim().slice(0, 500),
          });
        }
        return "fired";   // either way, re-arm
      } catch {
        return "skip";    // flaky model turn — back off, don't burn the breaker
      }
    }

    return "fail";
  }
}

// ── In-memory store (emulates the atomic claim) ───────────────────────────────

export class InMemoryScheduleStore implements ScheduleStore {
  private rows: ScheduleRow[] = [];

  seed(rows: ScheduleRow[]): void { this.rows.push(...rows.map(r => ({ ...r }))); }

  async claimDue(now: Date, limit: number): Promise<ScheduleRow[]> {
    const staleBefore = now.getTime() - STALE_PROCESSING_MS;
    const due = this.rows
      .filter(r =>
        (r.status === "pending" && r.fireAt.getTime() <= now.getTime()) ||
        // Ghost reclaim: a 'processing' row whose worker crashed before re-arming.
        // claimedAt must be non-null (mirrors SQL `claimed_at < ...`, where NULL
        // never matches) so a freshly-claimed row is never reclaimed instantly.
        (r.status === "processing" && r.claimedAt != null && r.claimedAt.getTime() <= staleBefore))
      .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
      .slice(0, limit);
    for (const r of due) { r.status = "processing"; r.claimedAt = now; }   // atomic flip
    return due.map(r => ({ ...r }));
  }

  async update(id: string, patch: Partial<ScheduleRow>): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) Object.assign(r, patch);
  }

  async countPendingByKind(wallet: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows) {
      if (r.wallet === wallet && r.status === "pending") out[r.kind] = (out[r.kind] ?? 0) + 1;
    }
    return out;
  }
}

// ── Demo ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  (async () => {
    const store = new InMemoryScheduleStore();
    const past = new Date(Date.now() - 1000);
    store.seed([
      { id: "r1", wallet: "w", kind: "reminder", payload: { text: "Call the dentist" },
        fireAt: past, status: "pending", failureCount: 0, lastFiredAt: null, claimedAt: null },
      { id: "wt1", wallet: "w", kind: "watch", payload: { symbol: "bitcoin", op: "gt", threshold: 50000 },
        fireAt: past, status: "pending", failureCount: 0, lastFiredAt: null, claimedAt: null },
      { id: "db1", wallet: "w", kind: "daily_brief", payload: { briefHour: 7, briefMin: 0, timezoneOffsetMin: -240 },
        fireAt: past, status: "pending", failureCount: 0, lastFiredAt: null, claimedAt: null },
      // A ghost: claimed 10 min ago by a worker that crashed before re-arming.
      { id: "gh1", wallet: "w", kind: "reminder", payload: { text: "Orphaned reminder" },
        fireAt: past, status: "processing", failureCount: 0, lastFiredAt: null,
        claimedAt: new Date(Date.now() - 10 * 60 * 1000) },
    ]);

    const delivered: OutboundMessage[] = [];
    const scheduler = new Scheduler(store, {
      fetchPrice: async () => 51234,                       // price is above the watch threshold
      deliver:    async (m) => { delivered.push(m); },
      evaluateGoal: async () => ({ act: false }),
    });

    const result = await scheduler.tick();
    console.log("Tick result:", result);
    console.log("\nDelivered outbound messages:");
    for (const m of delivered) console.log(`  [${m.kind}] ${m.title}`);

    console.log("\nNext daily-brief fire (7:00 local, UTC-4):",
      computeNextDailyFireAt(7, 0, -240).toISOString());
  })();
}
