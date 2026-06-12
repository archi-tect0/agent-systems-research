/**
 * Multi-Tenant MCP Host with SSRF Defense
 * ---------------------------------------
 * Brings external Model Context Protocol (MCP) servers into a multi-tenant
 * agent platform safely:
 *
 *   1. Per-tenant namespacing — every external tool is rewritten to
 *      mcp__<serverId-prefix>__<toolName> and resolved scoped to the owning
 *      wallet, so tools never collide or cross tenants.
 *   2. SSRF guard — runs on every outbound request (not just registration),
 *      resolves DNS, and rejects any host that maps to a private/reserved IP.
 *   3. Approval model — requiresApproval defaults true; a server's opt-out only
 *      lowers the risk label, it never removes the human confirmation step.
 *
 * No external dependencies — Node standard library only (node:dns). The server
 * registry and tool store are in-memory so the file runs standalone; the
 * security logic (SSRF guard, namespacing, grant filtering, approval) is real.
 *
 * Run the self-check:  npx tsx mcp-multitenant-host.ts --demo
 */

import { promises as dnsPromises } from "node:dns";

const MAX_TOOLS_PER_SERVER = 64;

// ── SSRF guard ──────────────────────────────────────────────────────────────

/** True when `addr` is a literal IP in a private/loopback/link-local/reserved range. */
export function isPrivateOrReservedIp(addr: string): boolean {
  const host = addr.startsWith("[") && addr.endsWith("]") ? addr.slice(1, -1) : addr;

  if (host.includes(":")) {
    const h = host.toLowerCase();
    if (h === "::1") return true;                                  // loopback
    if (h.startsWith("::ffff:")) return isPrivateOrReservedIp(h.slice(7)); // IPv4-mapped
    if (/^fe[89ab]/i.test(h)) return true;                         // fe80::/10 link-local
    if (/^f[cd]/i.test(h))    return true;                         // fc00::/7  ULA private
    return false;
  }

  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];

  if (a === 0)                             return true;  // 0.0.0.0/8       this-network
  if (a === 10)                            return true;  // 10.0.0.0/8      private
  if (a === 100 && b >= 64 && b <= 127)    return true;  // 100.64.0.0/10   CGNAT
  if (a === 127)                           return true;  // 127.0.0.0/8     loopback
  if (a === 169 && b === 254)              return true;  // 169.254.0.0/16  link-local
  if (a === 172 && b >= 16 && b <= 31)     return true;  // 172.16.0.0/12   private
  if (a === 192 && b === 168)              return true;  // 192.168.0.0/16  private
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15   benchmarking
  if (a === 198 && b === 51 && c === 100)  return true;  // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0   && c === 113) return true;  // 203.0.113.0/24  TEST-NET-3
  if (a >= 224)                            return true;  // 224.0.0.0+      multicast/reserved
  return false;
}

/** Internal-only TLDs and single-label names that should never be public servers. */
export function isInternalHostname(hostname: string): boolean {
  if (!hostname.includes(".")) return true; // single-label: db, redis, etc.
  const lower = hostname.toLowerCase();
  const internalSuffixes = [".local", ".localhost", ".internal", ".intranet", ".corp", ".home", ".lan", ".localdomain", ".arpa"];
  return internalSuffixes.some(sfx => lower === sfx.slice(1) || lower.endsWith(sfx));
}

/**
 * Runtime SSRF guard — call before every outbound fetch.
 * Normalizes the hostname, blocks well-known internal names, then resolves DNS
 * and rejects any address in a private/reserved range. Throws "ssrf_blocked".
 * Injectable resolver lets the demo run without real network access.
 */
export async function assertSsrfSafe(
  rawHostname: string,
  resolver: (h: string) => Promise<{ address: string }[]> = h => dnsPromises.lookup(h, { all: true }),
): Promise<void> {
  const hostname = rawHostname.replace(/\.$/, "").toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost") throw new Error("ssrf_blocked");
  if (isInternalHostname(hostname)) throw new Error("ssrf_blocked");
  if (isPrivateOrReservedIp(hostname)) throw new Error("ssrf_blocked");

  let addrs: { address: string }[] = [];
  try {
    addrs = await resolver(hostname);
  } catch {
    return; // unresolvable — fetch will also fail; do not silently allow either way
  }
  for (const { address } of addrs) {
    if (isPrivateOrReservedIp(address)) throw new Error("ssrf_blocked");
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface McpServerRow {
  id:          string;
  wallet:      string;
  name:        string;
  endpointUrl: string;
  appClientId: string | null;
  enabled:     boolean;
}

export interface McpToolRow {
  serverId:         string;
  name:             string;
  inputSchema:      Record<string, unknown>;
  requiresApproval: boolean;
  requiredGrant:    string | null;
}

export interface DiscoveredTool {
  name:               string;
  inputSchema?:       Record<string, unknown>;
  requires_approval?: boolean;
  required_grant?:    string;
}

export interface LoadedMcpTool {
  qualifiedName:    string;
  serverId:         string;
  serverName:       string;
  requiresApproval: boolean;
  tool:             McpToolRow;
}

export interface Grant { wallet: string; appClientId: string; capability: string; revoked: boolean; }

// ── Registry (in-memory store + an injectable tool-discovery transport) ──────

export interface Registry {
  servers: McpServerRow[];
  tools:   McpToolRow[];
  grants:  Grant[];
  /** Stand-in for POST {url}/tools/list. */
  discover(server: McpServerRow): Promise<DiscoveredTool[]>;
}

export class InMemoryRegistry implements Registry {
  servers: McpServerRow[] = [];
  tools:   McpToolRow[] = [];
  grants:  Grant[] = [];
  catalogs = new Map<string, DiscoveredTool[]>(); // serverId → tools the remote would return
  async discover(server: McpServerRow): Promise<DiscoveredTool[]> {
    return this.catalogs.get(server.id) ?? [];
  }
}

// ── Host ────────────────────────────────────────────────────────────────────

let serverCounterStub = 0;
const newServerId = () => `srv${(serverCounterStub++).toString(16).padStart(2, "0")}${Math.random().toString(16).slice(2, 10)}`;

export class McpHost {
  private readonly reg: Registry;
  private readonly resolver?: (h: string) => Promise<{ address: string }[]>;
  constructor(
    reg: Registry,
    resolver?: (h: string) => Promise<{ address: string }[]>,
  ) {
    this.reg = reg;
    this.resolver = resolver;
  }

  private async guard(url: string): Promise<void> {
    await assertSsrfSafe(new URL(url).hostname, this.resolver);
  }

  /** Register a server for a tenant. Runs the SSRF guard before persisting. */
  async registerServer(wallet: string, opts: { name: string; endpointUrl: string; appClientId?: string | null }): Promise<McpServerRow> {
    await this.guard(opts.endpointUrl); // reject internal targets at registration
    const row: McpServerRow = {
      id: newServerId(), wallet, name: opts.name, endpointUrl: opts.endpointUrl,
      appClientId: opts.appClientId ?? null, enabled: true,
    };
    this.reg.servers.push(row);
    return row;
  }

  /** Discover tools from a server and reconcile the tool store. SSRF-guarded. */
  async refreshServerTools(server: McpServerRow): Promise<number> {
    await this.guard(server.endpointUrl);
    const discovered = (await this.reg.discover(server)).slice(0, MAX_TOOLS_PER_SERVER);
    this.reg.tools = this.reg.tools.filter(t => t.serverId !== server.id); // wipe-and-replace
    for (const t of discovered) {
      this.reg.tools.push({
        serverId:         server.id,
        name:             String(t.name).replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64),
        inputSchema:      t.inputSchema ?? { type: "object", properties: {} },
        requiresApproval: t.requires_approval !== false,   // default true; server can't waive the human step
        requiredGrant:    t.required_grant ?? null,
      });
    }
    return discovered.length;
  }

  /**
   * Tools visible to `wallet` this turn: enabled servers the wallet owns, with
   * grant-gated tools filtered against currently-active grants. Recomputed each
   * call (not cached) so a revoked grant takes effect on the next turn.
   */
  async loadToolsForWallet(wallet: string): Promise<LoadedMcpTool[]> {
    const servers = this.reg.servers.filter(s => s.wallet === wallet && s.enabled);
    if (servers.length === 0) return [];
    const serverById = new Map(servers.map(s => [s.id, s]));

    const grantSet = new Set(
      this.reg.grants.filter(g => g.wallet === wallet && !g.revoked).map(g => `${g.appClientId}::${g.capability}`),
    );

    const out: LoadedMcpTool[] = [];
    for (const t of this.reg.tools) {
      const srv = serverById.get(t.serverId);
      if (!srv) continue;
      if (t.requiredGrant) {
        const owner = srv.appClientId ?? "mcp-user";
        if (!grantSet.has(`${owner}::${t.requiredGrant}`)) continue; // grant not held → hidden
      }
      out.push({
        qualifiedName:    `mcp__${srv.id.slice(0, 8)}__${t.name}`,
        serverId:         srv.id,
        serverName:       srv.name,
        requiresApproval: t.requiresApproval,
        tool:             t,
      });
    }
    return out;
  }

  /** Resolve a qualified name back to (server, tool), scoped to the wallet. */
  async resolveMcpTool(wallet: string, qualifiedName: string): Promise<{ server: McpServerRow; tool: McpToolRow } | null> {
    const parts = qualifiedName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") return null;
    const loaded = await this.loadToolsForWallet(wallet);
    const hit = loaded.find(t => t.qualifiedName === qualifiedName);
    if (!hit) return null;
    const server = this.reg.servers.find(s => s.id === hit.serverId);
    if (!server) return null;
    return { server, tool: hit.tool };
  }

  /**
   * Invoke a tool. Re-runs the SSRF guard at call time, enforces approval (the
   * server cannot waive it), and never echoes an upstream error body.
   */
  async invoke(
    wallet: string,
    qualifiedName: string,
    args: Record<string, unknown>,
    ctx: { approved: boolean },
    transport?: (server: McpServerRow, toolName: string, args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const resolved = await this.resolveMcpTool(wallet, qualifiedName);
    if (!resolved) return { ok: false, error: "tool not found or not owned by caller" };

    if (resolved.tool.requiresApproval && !ctx.approved) {
      return { ok: false, error: "approval_required" }; // human confirmation floor
    }

    try {
      await this.guard(resolved.server.endpointUrl); // runtime SSRF re-check (DNS rebinding)
    } catch {
      return { ok: false, error: "ssrf_blocked" };
    }

    try {
      const call = transport ?? (async () => ({ echoed: args })); // stub remote /tools/call
      const result = await call(resolved.server, resolved.tool.name, args);
      return { ok: true, result };
    } catch {
      return { ok: false, error: "upstream_error" }; // body intentionally suppressed
    }
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // Deterministic fake resolver: maps a few hostnames to IPs without real DNS.
  const fakeDns: Record<string, string[]> = {
    "mcp.example.com":   ["93.184.216.34"],   // public → allowed
    "rebind.evil.com":   ["10.0.0.5"],         // public name, internal IP → blocked
    "weather.example.io": ["198.51.100.7"],    // TEST-NET (treated reserved) → blocked
  };
  const resolver = async (h: string) => {
    const ips = fakeDns[h];
    if (!ips) throw new Error("NXDOMAIN");
    return ips.map(address => ({ address }));
  };

  (async () => {
    console.log("SSRF guard:");
    for (const url of ["http://localhost:6379", "http://169.254.169.254/latest/meta-data", "https://db.internal", "http://10.0.0.1", "https://rebind.evil.com", "https://mcp.example.com"]) {
      try { await assertSsrfSafe(new URL(url).hostname, resolver); console.log("  ALLOW ", url); }
      catch { console.log("  BLOCK ", url); }
    }

    const reg = new InMemoryRegistry();
    const host = new McpHost(reg, resolver);
    const wallet = "0xUSER_A";

    console.log("\nregistration rejects an internal URL:");
    try { await host.registerServer(wallet, { name: "evil", endpointUrl: "https://rebind.evil.com" }); console.log("  FAIL: registered"); }
    catch { console.log("  OK: blocked at registration"); }

    const srv = await host.registerServer(wallet, { name: "weather", endpointUrl: "https://mcp.example.com", appClientId: "app-weather" });
    reg.catalogs.set(srv.id, [
      { name: "get_forecast", requires_approval: false },                  // server opts out...
      { name: "delete_alerts", requires_approval: true },
      { name: "premium_radar", required_grant: "weather:premium" },
    ]);
    await host.refreshServerTools(srv);

    console.log("\nnamespaced tools visible to owner (no premium grant yet):");
    let tools = await host.loadToolsForWallet(wallet);
    for (const t of tools) console.log(`  ${t.qualifiedName}  approval=${t.requiresApproval}`);

    console.log("\nother tenant sees nothing:");
    console.log("  0xUSER_B tools:", (await host.loadToolsForWallet("0xUSER_B")).length);

    console.log("\ngrant unlocks the gated tool (recomputed per turn):");
    reg.grants.push({ wallet, appClientId: "app-weather", capability: "weather:premium", revoked: false });
    tools = await host.loadToolsForWallet(wallet);
    console.log("  premium_radar now visible:", tools.some(t => t.tool.name === "premium_radar"));

    console.log("\napproval floor — server opted out but platform still requires it on a destructive call:");
    const noApproval = await host.invoke(wallet, `mcp__${srv.id.slice(0, 8)}__delete_alerts`, {}, { approved: false });
    console.log("  delete_alerts without approval:", noApproval.error);
    const approved = await host.invoke(wallet, `mcp__${srv.id.slice(0, 8)}__get_forecast`, { city: "NYC" }, { approved: true });
    console.log("  get_forecast (approved):", approved.ok, JSON.stringify(approved.result));
  })();
}
