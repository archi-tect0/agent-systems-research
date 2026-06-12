/**
 * Universal Controller Overlay + Viewport Sync
 *
 * Turns a phone into a controller / touchpad / keyboard for a heavy GPU session
 * on a TV or laptop, with zero-config pairing and header-less stream auth.
 *
 * Three mechanisms:
 *   1. Deterministic channel id  = HMAC(server_secret, wallet)[0:24]
 *      → both devices on the same account compute the same channel, no code.
 *   2. Single-use SSE ticket     = random token, 30 s TTL, consumed on first use
 *      → authenticates a browser EventSource stream without custom headers,
 *        keeping the long-lived bearer out of URLs.
 *   3. Per-wallet viewport store  → the renderer reports its real screen
 *      (size, dpr, safe rect) so the agent sizes UI correctly.
 *
 * Plus an inline agent-approval flow over the same channel: a scoped device
 * asks the full-session phone to approve a sensitive action.
 *
 * Framework-agnostic: a tiny `Subscriber` interface stands in for an HTTP
 * response stream so this runs with Node built-ins only.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionKind = "full" | "scoped";

/** A live event-stream consumer (stands in for an SSE HTTP response). */
export interface Subscriber {
  write: (chunk: string) => void;
}

export interface ControllerEvent {
  t: string;                  // 'j' | 'r' | 'btn' | 'c' | 'sc' | 'k' | 'ksp' | 'cl' | 'p'
  [k: string]: unknown;
}

interface Channel {
  id: string;
  wallet: string;
  clients: Set<Subscriber>;
  lastInputAt: number | null;
  phoneAt: number | null;
}

interface SseTicket {
  wallet: string;
  expiresAt: number;
}

interface AgentRequest {
  reqId: string;
  channelId: string;
  action: string;
  label: string;
  status: "pending" | "approved" | "denied";
  expiresAt: number;
  createdAt: number;
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
  aspect: number;
  orientation: string;
  deviceClass: string;
  safeInsets: { top: number; right: number; bottom: number; left: number };
  safeRect: { x: number; y: number; width: number; height: number };
  updatedAt: number;
}

export class ControllerError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "ControllerError";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const SSE_TICKET_TTL_MS = 30_000;
const AGENT_REQ_TTL_MS = 2 * 60_000;
const MAX_EVENTS_PER_BATCH = 32;

// ── Hub ──────────────────────────────────────────────────────────────────────

export class ControllerHub {
  private channels = new Map<string, Channel>();
  private sseTickets = new Map<string, SseTicket>();
  private agentRequests = new Map<string, AgentRequest>();
  private viewports = new Map<string, Viewport>();

  private serverSecret: string;
  constructor(serverSecret: string) {
    this.serverSecret = serverSecret;
  }

  /** Deterministic channel id — same wallet always yields the same channel. */
  channelId(wallet: string): string {
    return crypto
      .createHmac("sha256", this.serverSecret)
      .update(wallet.toLowerCase())
      .digest("hex")
      .slice(0, 24);
  }

  private getOrCreate(wallet: string): Channel {
    const id = this.channelId(wallet);
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { id, wallet: wallet.toLowerCase(), clients: new Set(), lastInputAt: null, phoneAt: null };
      this.channels.set(id, ch);
    }
    return ch;
  }

  // ── Pair: both devices call this; same wallet → same channel ────────────────
  pair(wallet: string, kind: SessionKind): { controllerId: string; subscribers: number } {
    const ch = this.getOrCreate(wallet);
    if (kind === "full") ch.phoneAt = Date.now();
    return { controllerId: ch.id, subscribers: ch.clients.size };
  }

  // ── SSE ticket: mint a short-lived, single-use stream credential ────────────
  issueSseTicket(wallet: string): string {
    const ticket = crypto.randomBytes(32).toString("hex");
    this.sseTickets.set(ticket, { wallet: wallet.toLowerCase(), expiresAt: Date.now() + SSE_TICKET_TTL_MS });
    return ticket;
  }

  // ── Subscribe (big-screen side) using only the ticket ───────────────────────
  subscribe(channelId: string, ticket: string, sub: Subscriber): void {
    const entry = this.sseTickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new ControllerError(401, "invalid_or_expired_ticket");
    }
    this.sseTickets.delete(ticket); // single-use
    if (this.channelId(entry.wallet) !== channelId) {
      throw new ControllerError(403, "forbidden");
    }
    const ch = this.getOrCreate(entry.wallet);
    ch.clients.add(sub);
    sub.write(`event: connected\ndata: {"id":"${channelId}","subscribers":${ch.clients.size}}\n\n`);
  }

  unsubscribe(channelId: string, sub: Subscriber): void {
    this.channels.get(channelId)?.clients.delete(sub);
  }

  // ── Input (phone side): fan out compact event packets to subscribers ────────
  input(wallet: string, channelId: string, events: ControllerEvent[]): { delivered: number } {
    if (this.channelId(wallet) !== channelId) throw new ControllerError(403, "forbidden");
    const ch = this.channels.get(channelId);
    if (!ch) return { delivered: 0 };
    ch.lastInputAt = Date.now();

    let delivered = 0;
    for (const ev of events.slice(0, MAX_EVENTS_PER_BATCH)) {
      const line = `event: ctrl\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const c of ch.clients) {
        try { c.write(line); delivered++; } catch { ch.clients.delete(c); }
      }
    }
    return { delivered };
  }

  // ── Heartbeat + GC: keep streams warm, reap idle channels ───────────────────
  tick(now = Date.now()): void {
    for (const [id, ch] of this.channels) {
      for (const c of ch.clients) {
        try { c.write(": hb\n\n"); } catch { ch.clients.delete(c); }
      }
      if (ch.clients.size === 0 && (!ch.lastInputAt || now - ch.lastInputAt > 120_000)) {
        this.channels.delete(id);
      }
    }
    for (const [t, v] of this.sseTickets) if (v.expiresAt < now) this.sseTickets.delete(t);
    for (const [id, r] of this.agentRequests) if (r.expiresAt < now) this.agentRequests.delete(id);
  }

  // ── Inline agent-approval flow (role-enforced) ──────────────────────────────

  /** Scoped device asks the full-session phone to approve an action. */
  createAgentRequest(wallet: string, channelId: string, kind: SessionKind, action: string, label: string): { reqId: string; expiresAt: number } {
    if (this.channelId(wallet) !== channelId) throw new ControllerError(403, "forbidden");
    if (kind !== "scoped") throw new ControllerError(403, "only_scoped_may_create");
    if (action.length > 64 || label.length > 140) throw new ControllerError(400, "action_or_label_too_long");

    const reqId = crypto.randomUUID();
    const expiresAt = Date.now() + AGENT_REQ_TTL_MS;
    this.agentRequests.set(reqId, { reqId, channelId, action, label, status: "pending", expiresAt, createdAt: Date.now() });
    return { reqId, expiresAt };
  }

  /** Full-session phone lists pending requests on its channel. */
  listAgentRequests(wallet: string, channelId: string, kind: SessionKind): AgentRequest[] {
    if (this.channelId(wallet) !== channelId) throw new ControllerError(403, "forbidden");
    if (kind === "scoped") throw new ControllerError(403, "scoped_cannot_view");
    const now = Date.now();
    return [...this.agentRequests.values()].filter(
      (r) => r.channelId === channelId && r.status === "pending" && r.expiresAt > now,
    );
  }

  /** Full-session phone approves or denies. */
  respondAgentRequest(wallet: string, channelId: string, kind: SessionKind, reqId: string, status: "approved" | "denied"): void {
    if (this.channelId(wallet) !== channelId) throw new ControllerError(403, "forbidden");
    if (kind === "scoped") throw new ControllerError(403, "scoped_cannot_respond");
    const r = this.agentRequests.get(reqId);
    if (!r || r.channelId !== channelId) throw new ControllerError(404, "not_found");
    if (r.status !== "pending") throw new ControllerError(409, "already_resolved");
    r.status = status;
  }

  /** Scoped device polls for the outcome (one-shot: consumed once resolved). */
  pollAgentRequest(channelId: string, reqId: string): { status: AgentRequest["status"] | "expired" } {
    const r = this.agentRequests.get(reqId);
    if (!r || r.channelId !== channelId) throw new ControllerError(404, "not_found");
    if (r.status === "pending" && r.expiresAt < Date.now()) {
      this.agentRequests.delete(reqId);
      return { status: "expired" };
    }
    if (r.status !== "pending") {
      const st = r.status;
      this.agentRequests.delete(reqId);
      return { status: st };
    }
    return { status: "pending" };
  }

  // ── Viewport sync ───────────────────────────────────────────────────────────

  reportViewport(wallet: string, vp: Partial<Viewport> & { width: number; height: number }): void {
    const width = vp.width;
    const height = vp.height;
    this.viewports.set(wallet.toLowerCase(), {
      width,
      height,
      dpr: vp.dpr ?? 1,
      aspect: vp.aspect ?? Number((width / height).toFixed(4)),
      orientation: vp.orientation ?? "landscape",
      deviceClass: vp.deviceClass ?? "desktop",
      safeInsets: vp.safeInsets ?? { top: 48, right: 0, bottom: 0, left: 0 },
      safeRect: vp.safeRect ?? { x: 0, y: 48, width: width - 104, height: height - 48 },
      updatedAt: Date.now(),
    });
  }

  getViewport(wallet: string): Viewport | null {
    return this.viewports.get(wallet.toLowerCase()) ?? null;
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const hub = new ControllerHub("server-secret-v1");

  const phone = hub.pair("0xWALLET", "full");
  const tv = hub.pair("0xWALLET", "scoped");
  console.log("auto-paired same channel:", phone.controllerId === tv.controllerId);

  // TV subscribes with a single-use ticket
  const received: string[] = [];
  const ticket = hub.issueSseTicket("0xWALLET");
  hub.subscribe(tv.controllerId, ticket, { write: (l) => received.push(l) });

  // Re-using the ticket fails (single-use)
  try { hub.subscribe(tv.controllerId, ticket, { write: () => {} }); }
  catch (e) { console.log("ticket reuse rejected:", (e as ControllerError).code); }

  // Phone sends batched input
  const r = hub.input("0xWALLET", phone.controllerId, [
    { t: "j", x: 0.5, y: -0.2 },
    { t: "btn", b: "A", p: 1 },
  ]);
  console.log("delivered:", r.delivered, "lines seen by TV:", received.filter((l) => l.startsWith("event: ctrl")).length);

  // Inline agent approval: scoped asks, phone approves, scoped polls outcome
  const ar = hub.createAgentRequest("0xWALLET", tv.controllerId, "scoped", "wallet.send", "Send 0.1 ETH to Alice");
  console.log("pending for phone:", hub.listAgentRequests("0xWALLET", phone.controllerId, "full").length);
  hub.respondAgentRequest("0xWALLET", phone.controllerId, "full", ar.reqId, "approved");
  console.log("scoped poll:", hub.pollAgentRequest(tv.controllerId, ar.reqId));

  // Viewport report read per-turn by the agent
  hub.reportViewport("0xWALLET", { width: 1920, height: 1080, dpr: 1, deviceClass: "tv" });
  console.log("viewport:", hub.getViewport("0xWALLET"));
}
