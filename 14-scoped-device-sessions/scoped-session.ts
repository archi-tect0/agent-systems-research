/**
 * Scoped Device Sessions
 *
 * QR-paired device sessions that default to read-only at the protocol layer,
 * plus out-of-band per-intent elevation permits.
 *
 * Two pieces:
 *   1. makeScopeGuard() — a global middleware. Mount it ONCE before the router.
 *      Reads (GET/HEAD/OPTIONS) always pass. Scoped sessions are rejected on
 *      any other method with 403 SCOPED_SESSION unless the path is on a small
 *      explicit write allow-list. New write routes are protected by default.
 *   2. Elevation flow — a scoped device requests approval for one action; a
 *      full session approves; a one-time, short-lived token is delivered once.
 *
 * The session/ticket persistence is abstracted behind small interfaces so this
 * file stays standalone. Wire `resolveSession` to your real store.
 *
 * Dependencies: Node.js built-in "crypto". (Express types are illustrative —
 * the middleware uses the (req, res, next) shape but no Express import.)
 */

import crypto from "crypto";

export const SCOPED_CLIENT_ID = "scoped-device-v1";

// ── Minimal request/response shapes (Express-compatible) ─────────────────────

interface MinimalReq {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  resolvedBinding?: SessionBinding | null;
  log?: { warn?: (o: unknown, m: string) => void; error?: (o: unknown, m: string) => void };
}
interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): void;
}
type Next = () => void;

export interface SessionBinding {
  wallet: string;
  clientId: string;
}

// ── Write allow-list ─────────────────────────────────────────────────────────
//
// Keep this small. Each entry must answer "no" to: can a stolen paired-device
// token cause user-visible harm via this endpoint? Reads are NOT listed — the
// method check covers them.

const SCOPED_ALLOWED_WRITE_PATHS: RegExp[] = [
  /^\/v1\/auth\/logout$/,                                      // sign self out
  /^\/v1\/notifications(\/|$)/,                                // mark read / delete
  /^\/v1\/launcher\/prefs$/,                                   // icon order, etc.
  /^\/v1\/(behavioral|environmental|biometric|telemetry)(\/|$)/, // background signals
];

export function tokenFromRequest(req: MinimalReq): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || undefined;
  }
  const x = req.headers["x-session-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return undefined;
}

// ── Global scope guard ───────────────────────────────────────────────────────

export function makeScopeGuard(deps: {
  resolveSession: (token: string) => Promise<SessionBinding | null>;
}) {
  return async function scopeGuard(req: MinimalReq, res: MinimalRes, next: Next): Promise<void> {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

    const token = tokenFromRequest(req);
    if (!token) return next();

    try {
      const binding = await deps.resolveSession(token);
      if (!binding) return next(); // route's own auth will reject

      req.resolvedBinding = binding; // cache to avoid a 2nd DB round-trip

      if (binding.clientId === SCOPED_CLIENT_ID) {
        if (SCOPED_ALLOWED_WRITE_PATHS.some((re) => re.test(req.path))) return next();
        req.log?.warn?.({ wallet: binding.wallet, method, path: req.path }, "scoped session blocked from mutation");
        res.status(403).json({
          error:
            "This operation is not available on a paired device session. " +
            "Sign in with your passkey directly on this device for full access.",
          code: "SCOPED_SESSION",
        });
        return;
      }
      return next();
    } catch (err) {
      // Fail open: this is a scoping layer, not the auth layer. The route's own
      // auth still rejects invalid tokens. Failing closed would let a transient
      // DB error take the whole API offline.
      req.log?.error?.({ err }, "scope guard DB lookup failed");
      return next();
    }
  };
}

/** Defense-in-depth helper for routes that bypass the standard bearer header. */
export function blockScopedSession(
  binding: { clientId: string } | null | undefined,
  res: MinimalRes,
): boolean {
  if (binding?.clientId === SCOPED_CLIENT_ID) {
    res.status(403).json({
      error:
        "This operation is not available on a paired device session. " +
        "Sign in with your passkey directly on this device for full access.",
      code: "SCOPED_SESSION",
    });
    return true;
  }
  return false;
}

// ── Pairing ticket store (illustrative) ──────────────────────────────────────

export interface PairTicket {
  id: string;
  code: string;          // 6-digit, shown in QR for visual confirmation
  claimSecret: string;   // returned at init ONLY, never in the QR
  status: "pending" | "approved" | "claimed";
  wallet?: string;
  scopedToken?: string;
  expiresAt: number;
}

const PAIR_TTL_MS = 5 * 60 * 1000;
const SCOPED_TTL_MS = 8 * 60 * 60 * 1000;

/** Laptop calls this (no auth). Returns claimSecret which is NOT in the QR. */
export function initPairTicket(store: Map<string, PairTicket>): {
  id: string; code: string; claimSecret: string; expiresAt: number;
} {
  const id = crypto.randomBytes(16).toString("hex");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const claimSecret = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + PAIR_TTL_MS;
  store.set(id, { id, code, claimSecret, status: "pending", expiresAt });
  return { id, code, claimSecret, expiresAt };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Phone (full session) approves. Creates a scoped 8h binding. Rejects callers
 * who are themselves scoped — a scoped session must never mint another.
 */
export function approvePairTicket(
  store: Map<string, PairTicket>,
  id: string,
  code: string,
  approver: SessionBinding,
  persistScopedBinding: (b: SessionBinding & { sessionToken: string; expiresAt: number }) => void,
): { ok: true } | { ok: false; status: number; error: string; codeTag?: string } {
  if (approver.clientId === SCOPED_CLIENT_ID) {
    return { ok: false, status: 403, error: "A paired-device session cannot approve new device pairings.", codeTag: "SCOPED_SESSION" };
  }
  const t = store.get(id);
  if (!t || t.expiresAt < Date.now()) return { ok: false, status: 404, error: "Ticket not found or expired" };
  if (t.status !== "pending") return { ok: false, status: 409, error: "Ticket already used" };
  if (!timingSafeEqual(code, t.code)) return { ok: false, status: 401, error: "Invalid pairing code" };

  const scopedToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SCOPED_TTL_MS;
  persistScopedBinding({ wallet: approver.wallet, clientId: SCOPED_CLIENT_ID, sessionToken: scopedToken, expiresAt });

  t.status = "approved";
  t.wallet = approver.wallet;
  t.scopedToken = scopedToken;
  return { ok: true };
}

/** Laptop polls with the claimSecret. Token delivered once, then status=claimed. */
export function claimPairTicket(
  store: Map<string, PairTicket>,
  id: string,
  claimSecret: string,
): { status: string; sessionToken?: string; wallet?: string } {
  const t = store.get(id);
  if (!t) return { status: "not_found" };
  if (!timingSafeEqual(claimSecret, t.claimSecret)) return { status: "invalid_claim_secret" };
  if (t.status === "pending" && t.expiresAt < Date.now()) return { status: "expired" };
  if (t.status === "pending") return { status: "pending" };
  if (t.status === "claimed") return { status: "claimed" };
  if (t.status === "approved" && t.scopedToken && t.wallet) {
    t.status = "claimed"; // one-time retrieval
    return { status: "approved", sessionToken: t.scopedToken, wallet: t.wallet };
  }
  return { status: t.status };
}

// ── Per-intent elevation ─────────────────────────────────────────────────────

export interface ElevationRequest {
  id: string;
  wallet: string;
  scopedSessionToken: string;
  action: string;
  label: string;
  status: "pending" | "approved" | "denied";
  approvalToken: string | null;
  expiresAt: number;
}

const ELEVATION_TTL_MS = 2 * 60 * 1000;

/** Scoped device requests elevation for ONE action. */
export function requestElevation(
  store: Map<string, ElevationRequest>,
  scoped: SessionBinding,
  scopedToken: string,
  action: string,
  label: string,
): { id: string; expiresAt: number } | { error: string } {
  if (scoped.clientId !== SCOPED_CLIENT_ID) return { error: "Only scoped sessions may create auth requests" };
  if (action.length > 64 || label.length > 140) return { error: "action/label too long" };
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + ELEVATION_TTL_MS;
  store.set(id, { id, wallet: scoped.wallet, scopedSessionToken: scopedToken, action, label, status: "pending", approvalToken: null, expiresAt });
  return { id, expiresAt };
}

/** Full session approves; mints a one-time token. */
export function approveElevation(
  store: Map<string, ElevationRequest>,
  approver: SessionBinding,
  id: string,
): { ok: true; approvalToken: string } | { ok: false; status: number; error: string } {
  if (approver.clientId === SCOPED_CLIENT_ID) return { ok: false, status: 401, error: "Unauthorized" };
  const r = store.get(id);
  if (!r) return { ok: false, status: 404, error: "Not found or expired" };
  if (r.wallet !== approver.wallet) return { ok: false, status: 403, error: "Forbidden" };
  if (r.status !== "pending") return { ok: false, status: 409, error: "Already resolved" };
  r.status = "approved";
  r.approvalToken = crypto.randomBytes(32).toString("hex");
  return { ok: true, approvalToken: r.approvalToken };
}

/** Scoped device polls; the approval token is delivered exactly once. */
export function pollElevation(
  store: Map<string, ElevationRequest>,
  id: string,
  scopedToken: string,
): { status: string; approvalToken?: string } {
  const r = store.get(id);
  if (!r || r.scopedSessionToken !== scopedToken) return { status: "not_found" };
  if (r.status === "pending" && r.expiresAt < Date.now()) { store.delete(id); return { status: "expired" }; }
  if (r.status === "approved" && r.approvalToken) {
    const tok = r.approvalToken;
    store.delete(id); // one-time delivery
    return { status: "approved", approvalToken: tok };
  }
  if (r.status === "denied") { store.delete(id); return { status: "denied" }; }
  return { status: r.status };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const pairStore = new Map<string, PairTicket>();
  const bindings = new Map<string, SessionBinding>();

  const init = initPairTicket(pairStore);
  console.log("init (claimSecret stays private):", { id: init.id, code: init.code });

  const phone: SessionBinding = { wallet: "0xabc", clientId: "full-v1" };
  const approve = approvePairTicket(pairStore, init.id, init.code, phone, (b) => {
    bindings.set(b.sessionToken, { wallet: b.wallet, clientId: b.clientId });
  });
  console.log("approve:", approve);

  console.log("claim (correct secret):", claimPairTicket(pairStore, init.id, init.claimSecret).status);
  console.log("claim (replay):", claimPairTicket(pairStore, init.id, init.claimSecret).status);

  const elevStore = new Map<string, ElevationRequest>();
  const scoped: SessionBinding = { wallet: "0xabc", clientId: SCOPED_CLIENT_ID };
  const reqd = requestElevation(elevStore, scoped, "scoped-token", "export-key", "Export ETH key") as { id: string };
  console.log("elevation requested:", reqd.id);
  const appr = approveElevation(elevStore, phone, reqd.id);
  console.log("elevation approved:", appr);
  console.log("scoped polls:", pollElevation(elevStore, reqd.id, "scoped-token").status);
}
