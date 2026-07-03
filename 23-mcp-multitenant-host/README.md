# Multi-Tenant MCP Host with SSRF Defense


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

The Model Context Protocol (MCP) lets a third party expose a catalog of tools that an agent can discover and call. Bringing external MCP servers into a multi-tenant agent platform raises three hard problems at once:

1. **Tenant isolation.** Many users each register their own MCP servers. Tool A belonging to one user's server must never collide with, shadow, or be callable by another user, and must never collide with the platform's own native tools.
2. **Server-Side Request Forgery (SSRF).** An MCP server is just a URL the backend will `POST` to. A malicious or careless user could register a URL that points at internal infrastructure — `http://localhost:6379`, the cloud metadata endpoint `169.254.169.254`, a private `10.x` database — turning the backend into a confused deputy that fetches internal resources on the attacker's behalf.
3. **Action safety.** An MCP tool can have side effects. The server itself decides whether a tool "requires approval," but a remote server's self-assessment cannot be trusted to gate destructive actions on the platform.

This guide describes a host that solves all three: per-tenant tool namespacing, a DNS-aware SSRF guard that runs on *every* outbound request (not just at registration), and an approval model where the server's `requiresApproval` flag can only *raise* friction, never remove the human-in-the-loop step.

## Design decisions

**Why namespace every tool as `mcp__<prefix>__<tool>`?**
The agent sees a flat list of tool names. To prevent collisions, every external tool is rewritten to `mcp__<serverId-prefix>__<toolName>`. The `mcp__` prefix separates external tools from native platform tools; the server-id prefix separates one server from another even if two servers expose a tool with the same name. The qualified name is also what's resolved back to a `(server, tool)` pair at call time, scoped to the calling wallet — so a user can only invoke tools on servers they own.

**Why filter tools by capability grant, per turn?**
A tool may declare a `requiredGrant`. It is only visible to a wallet that holds an active (non-revoked) grant for that capability against the server's owning app. Grants are loaded fresh and the visible tool set is recomputed per turn rather than cached, so revoking a grant takes effect on the very next turn — there is no stale cached capability the model can still reach.

**Why default `requiresApproval` to true?**
Tool rows persist with `requiresApproval = (server flag !== false)`. In other words, approval is required *unless the server explicitly opts out*, and even when it opts out the platform's own passkey/confirm step still runs — the flag only downgrades the risk label on the confirmation card, it never bypasses the human step. A remote server cannot grant itself the right to act without the user.

**Why run the SSRF guard at request time, not just registration?**
Checking the URL only when it's registered is insufficient for two reasons:
- *Pre-existing rows*: servers registered before the check existed must still be protected.
- *DNS rebinding*: a hostname that resolved to a public IP at registration can later be repointed by its owner to resolve to an internal IP. The TOCTOU (time-of-check to time-of-use) window between "validate" and "connect" is exactly where rebinding attacks live.

So the guard runs before *every* outbound fetch. The strongest version goes further and *pins* the connection to the already-validated IP (see below).

**How the SSRF guard decides:**
1. Normalize the hostname — strip a trailing dot, lowercase, remove IPv6 brackets.
2. Reject obvious internal names without touching DNS: `localhost`, single-label names (`db`, `redis`), and internal suffixes (`.local`, `.internal`, `.lan`, `.corp`, `.arpa`, …).
3. If the host is an IP literal, check it directly against the blocked ranges.
4. Otherwise resolve A/AAAA records and reject if **any** resolved address falls in a private/reserved range — loopback, `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`, link-local `169.254/16` and IPv6 `fe80::/10`, ULA `fc00::/7`, multicast, and the documentation/benchmark TEST-NET ranges.

The blocked-range list is the security boundary; it is deliberately broad and fails toward rejection.

**Why pin the connection to the validated IP?**
Validating a hostname and then handing the hostname to `fetch` re-resolves DNS a second time — and an attacker can answer the second lookup differently (rebinding). The hardened delivery path validates the hostname, captures the resolved IP, and then opens the TCP connection *directly to that pinned IP* while sending the original hostname as the TLS SNI and `Host` header. No second resolution occurs, so the check and the connection see the same address. Redirects are not followed, closing the bounce-to-internal escape.

**Why `redirect: "error"` on the plain-fetch path too?**
Even with a correct pre-flight check, an attacker-controlled *public* server could answer with a 302 to an internal target. Following redirects would let that bypass the guard. Disabling redirect-following forces every hop to be one the guard has vetted.

**Why never echo the upstream error body?**
A failed fetch reports only `HTTP <status>`, never the response body. An error body could contain internal service content, giving SSRF a *read* channel even when the request "failed." Suppressing it removes that side channel.

## Algorithm

```
REGISTER(url): assertSsrfSafe(url.hostname); store server row

REFRESH(server):
  assertSsrfSafe → POST {url}/tools/list
  for each tool (capped at MAX_TOOLS_PER_SERVER):
    persist { name (sanitized), inputSchema,
              requiresApproval = (flag !== false),   // default true
              requiredGrant }

LOAD_TOOLS(wallet):                                   // recomputed per turn
  servers = enabled servers owned by wallet
  grants  = active (non-revoked) grants for wallet
  for each tool of those servers:
    if tool.requiredGrant and grant not held: skip
    emit qualifiedName = mcp__<serverId[:8]>__<tool.name>

INVOKE(wallet, qualifiedName, args):
  (server, tool) = resolve(qualifiedName) scoped to wallet   // null → reject
  if tool.requiresApproval: require human confirmation       // server cannot waive
  assertSsrfSafe(server.hostname)                            // runtime, every call
  POST {url}/tools/call { name, arguments }  (redirect: error, no body on error)

assertSsrfSafe(host):
  normalize(host)
  reject localhost / internal suffixes / single-label
  if IP literal: reject if private-or-reserved
  else: resolve A/AAAA; reject if ANY address private-or-reserved
```

## Reference implementation

See [`mcp-multitenant-host.ts`](./mcp-multitenant-host.ts) in this directory. It implements the SSRF guard (with no external dependencies — pure parsing of IPv4/IPv6 ranges plus the Node DNS resolver), the per-tenant namespacing and grant filtering, and the approval policy. The server registry and tool store are kept in-memory so the file runs standalone; the security logic is the real logic.

## Usage

```typescript
import { McpHost, InMemoryRegistry } from "./mcp-multitenant-host.js";

const host = new McpHost(new InMemoryRegistry());

// Registration runs the SSRF guard; an internal URL is rejected.
await host.registerServer(wallet, { name: "weather", endpointUrl: "https://mcp.example.com" });

// Tools are namespaced and grant-filtered, recomputed each turn.
const tools = await host.loadToolsForWallet(wallet);
// → [{ qualifiedName: "mcp__a1b2c3d4__get_forecast", requiresApproval: true, ... }]

// Invocation re-checks SSRF at call time and enforces approval.
const result = await host.invoke(wallet, "mcp__a1b2c3d4__get_forecast", { city: "NYC" }, { approved: true });
```

## Limitations and extensions

- **Pin-to-IP needs raw HTTP for full protection.** Plain `fetch` re-resolves DNS; the bundled guard demonstrates pre-resolution + `redirect:"error"`, and the README describes the pinned-IP `https.request` form that fully closes the rebinding window. Use the pinned form for untrusted endpoints.
- **The blocked-range list must be maintained.** New reserved ranges and cloud-metadata addresses appear over time. Treat the range table as security-critical configuration.
- **DNS failure policy is a tradeoff.** This implementation lets an unresolvable host fall through to a fetch that will fail on its own; a stricter policy rejects on DNS failure. Choose based on whether availability or paranoia matters more for your threat model.
- **Approval is binary here.** Real deployments add risk tiers (read vs. write vs. spend) and step-up authentication. The invariant to preserve: the *server* can never reduce the required friction below the platform's floor.
- **Tool-output trust.** A remote tool's response is fed back to the model; treat it as untrusted input and apply the same prompt-injection defenses you use for any external content.
