/**
 * Tiered Authority Bands for Agent Tool Execution
 *
 * Every tool an autonomous agent can call resolves to exactly one authority
 * band, 0 through 4.  The band — decided server-side from a policy table, not
 * by the model or by the phrasing of the request — determines whether the call
 * auto-executes, needs a single human approval, needs dual authorization, or
 * can never run autonomously.
 *
 *   Band 0 — read / observe.        auto-exec,  no approval
 *   Band 1 — recommend / prepare.   auto-exec,  no approval
 *   Band 2 — safe bounded auto.     auto-exec,  no approval
 *   Band 3 — dual-authorization.    approval + dual-auth
 *   Band 4 — never autonomous.      approval, never auto-executes
 *
 * Fail-closed: an unknown tool resolves to Band 4 (hardest), never Band 0.
 * The model cannot manufacture autonomy by inventing or renaming a tool.
 *
 * Dependencies: Node.js built-in "crypto" module only.
 * In production the in-memory table below is a database query plus a short
 * in-process cache; the swap points are marked inline.
 */

import crypto from "node:crypto";

export type AuthorityBand = 0 | 1 | 2 | 3 | 4;

export type ReasonCode =
  | "band0_read"
  | "band1_display"
  | "band2_auto"
  | "band3_dual_auth"
  | "band4_human_required"
  | "unknown_fail_closed";

export interface PolicyEvaluation {
  toolName:         string;
  band:             AuthorityBand;
  requiresApproval: boolean;
  requiresDualAuth: boolean;
  neverAuto:        boolean;
  allowed:          boolean;
  reasonCode:       ReasonCode;
  reason?:          string;
}

interface BandRow {
  toolName:         string;
  band:             AuthorityBand;
  requiresDualAuth: boolean;
  neverAuto:        boolean;
  reason?:          string;
}

const PREP_SIG_SECRET = process.env["SESSION_SECRET"] ?? "dev-prep-sig-secret-change-me";
const CACHE_TTL_MS    = 5 * 60 * 1000;

// ── Canonical JSON ─────────────────────────────────────────────────────────────

/**
 * Canonical-JSON stringifier — keys sorted recursively so two equivalent
 * action packages always serialize to the same bytes regardless of property
 * insertion order.  The prep signature is computed over this form.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys
    .map(k => JSON.stringify(k) + ":" + canonicalJSON((value as Record<string, unknown>)[k]))
    .join(",") + "}";
}

// ── Policy engine ──────────────────────────────────────────────────────────────

export class AuthorityPolicyEngine {
  // In a production deployment this Map is replaced by an `agent_tool_bands`
  // table.  loadCache() below reads the table once per TTL window.
  private table = new Map<string, BandRow>();
  private cache: Map<string, BandRow> | null = null;
  private cacheAt = 0;

  /** Register or re-tier a tool. */
  setBand(
    toolName: string,
    band: AuthorityBand,
    opts: { requiresDualAuth?: boolean; neverAuto?: boolean; reason?: string } = {},
  ): void {
    this.table.set(toolName, {
      toolName,
      band,
      requiresDualAuth: opts.requiresDualAuth ?? false,
      neverAuto:        opts.neverAuto ?? (band === 4),
      reason:           opts.reason,
    });
    this.flushCache();
  }

  /** Force the next evaluate() to re-read the backing store immediately. */
  flushCache(): void {
    this.cache = null;
    this.cacheAt = 0;
  }

  private async loadCache(): Promise<Map<string, BandRow>> {
    if (this.cache && Date.now() - this.cacheAt < CACHE_TTL_MS) return this.cache;
    // Production: `const rows = await db.select().from(agentToolBandsTable);`
    this.cache = new Map(this.table);
    this.cacheAt = Date.now();
    return this.cache;
  }

  /**
   * Evaluate the authority band + approval requirements for a tool call.
   *
   * Server-authoritative: the model cannot influence the outcome by phrasing
   * the call differently.  An unknown tool name resolves to Band 4 unless the
   * caller asserts (via isPlatformTool) that it is a known first-party tool.
   */
  async evaluate(input: {
    wallet?:        string;
    toolName:       string;
    isPlatformTool?: boolean;
  }): Promise<PolicyEvaluation> {
    const m   = await this.loadCache();
    const row = m.get(input.toolName);

    if (!row) {
      // Known platform tool, not yet seeded → safe Band 1 default.
      if (input.isPlatformTool) {
        return {
          toolName:         input.toolName,
          band:             1,
          requiresApproval: false,
          requiresDualAuth: false,
          neverAuto:        false,
          allowed:          true,
          reasonCode:       "band1_display",
          reason:           "Platform tool not yet seeded; defaulting to Band 1 (safe display). Add a row to lock the band.",
        };
      }
      // Truly unknown / model-invented → Band 4, fail-closed.
      return {
        toolName:         input.toolName,
        band:             4,
        requiresApproval: true,
        requiresDualAuth: false,
        neverAuto:        true,
        allowed:          true,
        reasonCode:       "unknown_fail_closed",
        reason:           "Tool not registered; defaulting to Band 4 (always-human-approval).",
      };
    }

    // Defensive clamp — an out-of-range value degrades to a valid band.
    const band = Math.max(0, Math.min(4, row.band)) as AuthorityBand;

    if (band <= 2) {
      return {
        toolName:         input.toolName,
        band,
        requiresApproval: false,
        requiresDualAuth: false,
        neverAuto:        false,
        allowed:          true,
        reasonCode:       band === 0 ? "band0_read" : band === 1 ? "band1_display" : "band2_auto",
        reason:           row.reason,
      };
    }
    if (band === 3) {
      return {
        toolName:         input.toolName,
        band,
        requiresApproval: true,
        requiresDualAuth: row.requiresDualAuth,
        neverAuto:        false,
        allowed:          true,
        reasonCode:       "band3_dual_auth",
        reason:           row.reason,
      };
    }
    // band === 4
    return {
      toolName:         input.toolName,
      band:             4,
      requiresApproval: true,
      requiresDualAuth: false,
      neverAuto:        row.neverAuto,
      allowed:          true,
      reasonCode:       "band4_human_required",
      reason:           row.reason,
    };
  }

  /** List all registered tools, ordered by band then name. */
  async list(): Promise<BandRow[]> {
    const m = await this.loadCache();
    return Array.from(m.values()).sort(
      (a, b) => a.band - b.band || a.toolName.localeCompare(b.toolName),
    );
  }

  /**
   * Agent Prep Signature (Authorization 1 of the Band-3 dual-auth flow).
   *
   * HMAC-SHA256 over the canonical action package.  A fresh 128-bit nonce makes
   * every prep-sig unique per attempt; it is embedded in the wire form
   * (nonce.mac) so a later verifier can recompute without out-of-band state.
   *
   * Upgrade path: swap the HMAC for an ML-DSA-65 signature — the wire format
   * (a base64url string) stays the same.
   */
  computePrepSig(input: {
    wallet:          string;
    toolName:        string;
    args:            Record<string, unknown>;
    expiresAt:       Date;
    band:            AuthorityBand;
    conversationId?: string;
  }): string {
    const nonce = crypto.randomBytes(16).toString("base64url");
    const canonical = canonicalJSON({
      v:         "prep-v0",
      wallet:    input.wallet.toLowerCase(),
      tool:      input.toolName,
      args:      input.args,
      expiresAt: input.expiresAt.toISOString(),
      band:      input.band,
      conv:      input.conversationId ?? null,
      nonce,
    });
    const mac = crypto.createHmac("sha256", PREP_SIG_SECRET).update(canonical).digest("base64url");
    return `${nonce}.${mac}`;
  }

  /** Verify a prep-sig against the same action package. */
  verifyPrepSig(
    sig: string,
    input: {
      wallet:          string;
      toolName:        string;
      args:            Record<string, unknown>;
      expiresAt:       Date;
      band:            AuthorityBand;
      conversationId?: string;
    },
  ): boolean {
    const [nonce, mac] = sig.split(".");
    if (!nonce || !mac) return false;
    const canonical = canonicalJSON({
      v:         "prep-v0",
      wallet:    input.wallet.toLowerCase(),
      tool:      input.toolName,
      args:      input.args,
      expiresAt: input.expiresAt.toISOString(),
      band:      input.band,
      conv:      input.conversationId ?? null,
      nonce,
    });
    const expected = crypto.createHmac("sha256", PREP_SIG_SECRET).update(canonical).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

// ── Example usage ──────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  (async () => {
    const engine = new AuthorityPolicyEngine();
    engine.setBand("get_balance", 0, { reason: "pure read" });
    engine.setBand("draft_message", 1);
    engine.setBand("create_reminder", 2, { reason: "bounded reversible write" });
    engine.setBand("rotate_key", 3, { requiresDualAuth: true });
    engine.setBand("send_funds", 4, { reason: "irreversible" });

    const wallet = "0xAbC0000000000000000000000000000000000001";

    for (const tool of ["get_balance", "create_reminder", "rotate_key", "send_funds"]) {
      const v = await engine.evaluate({ wallet, toolName: tool });
      console.log(
        `${tool.padEnd(16)} band=${v.band} approval=${v.requiresApproval} dual=${v.requiresDualAuth} neverAuto=${v.neverAuto}`,
      );
    }

    // Unknown / model-invented name → Band 4, fail-closed
    const sneaky = await engine.evaluate({ wallet, toolName: "send_funds_bypass" });
    console.log(`\nfail-closed: send_funds_bypass → band ${sneaky.band} (neverAuto=${sneaky.neverAuto})`);

    // Known platform tool, not seeded → Band 1 safety net
    const platform = await engine.evaluate({ wallet, toolName: "new_platform_tool", isPlatformTool: true });
    console.log(`platform safety net: new_platform_tool → band ${platform.band}`);

    // Band-3 dual-auth prep signature
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const args = { newKey: "0xdeadbeef" };
    const sig = engine.computePrepSig({ wallet, toolName: "rotate_key", args, expiresAt, band: 3 });
    console.log(`\nprep-sig: ${sig.slice(0, 40)}…`);
    console.log("verifies:", engine.verifyPrepSig(sig, { wallet, toolName: "rotate_key", args, expiresAt, band: 3 }));
    console.log("tamper detected:", !engine.verifyPrepSig(sig, { wallet, toolName: "rotate_key", args: { newKey: "0xevil" }, expiresAt, band: 3 }));
  })();
}
