/**
 * DNS-Pinned SSRF Guard for Outbound Webhooks
 *
 * Validates a user-supplied outbound URL against private/reserved address
 * ranges and then connects to the *already-validated IP* with TLS SNI + Host
 * header pinned to the original domain. This closes the DNS-rebinding TOCTOU
 * window that string-only or first-IP SSRF checks leave open: the IP that was
 * checked is the exact IP that gets connected to — no second resolution.
 *
 * Pipeline:
 *   1. Parse + scheme/credential checks.
 *   2. Reject well-known private hostnames / reserved TLDs (no DNS needed).
 *   3. IP literal  → check directly against blocked ranges.
 *      Hostname    → resolve ALL A + AAAA records, reject if ANY is private.
 *   4. On success, return the validated IPs so the caller pins the connection.
 *
 * Dependencies: Node.js built-ins only — "dns", "net", "https". IP-range math
 * is implemented here (no ipaddr.js) so the file is fully self-contained.
 */

import dns from "dns";
import net from "net";
import https from "https";

// ── IPv4 range math ───────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return -1;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Cidr(ip: string, base: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt < 0 || baseInt < 0) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918 private
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local (includes 169.254.169.254 metadata)
  ["172.16.0.0", 12],    // RFC1918 private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.168.0.0", 16],   // RFC1918 private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved
];

// ── IPv6 parsing + range math ─────────────────────────────────────────────────

/** Expand an IPv6 string to a 16-byte Buffer, or null if unparseable. */
function ipv6ToBytes(input: string): Buffer | null {
  let str = input;
  // Handle embedded IPv4 suffix (e.g. ::ffff:1.2.3.4 or 64:ff9b::1.2.3.4)
  let v4Tail: number[] | null = null;
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 < 0) return null;
    v4Tail = [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff];
    str = str.slice(0, lastColon + 1) + "0:0";
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups: number[] = [];

  for (const h of head) {
    const n = parseInt(h, 16);
    if (h === "" || Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    groups.push(n);
  }
  const tailGroups: number[] = [];
  for (const h of back) {
    const n = parseInt(h, 16);
    if (h === "" || Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    tailGroups.push(n);
  }

  let full: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    full = [...groups, ...new Array(fill).fill(0), ...tailGroups];
  } else {
    full = groups;
  }
  if (full.length !== 8) return null;

  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (full[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = full[i] & 0xff;
  }
  if (v4Tail) {
    bytes[12] = v4Tail[0]; bytes[13] = v4Tail[1]; bytes[14] = v4Tail[2]; bytes[15] = v4Tail[3];
  }
  return bytes;
}

function inV6Cidr(bytes: Buffer, basePrefix: string): boolean {
  const [base, prefixStr] = basePrefix.split("/");
  const prefix = parseInt(prefixStr, 10);
  const baseBytes = ipv6ToBytes(base);
  if (!baseBytes) return false;
  let bits = prefix;
  for (let i = 0; i < 16 && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (baseBytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

const BLOCKED_V6 = [
  "::1/128",     // loopback
  "::/128",      // unspecified
  "fc00::/7",    // unique local
  "fe80::/10",   // link-local
  "ff00::/8",    // multicast
];

// ── Public predicate ──────────────────────────────────────────────────────────

export function isPrivateOrReservedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return BLOCKED_V4.some(([base, p]) => inV4Cidr(ip, base, p));
  }
  if (kind === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // unparseable → fail closed
    // IPv4-mapped (::ffff:a.b.c.d) → check the embedded v4
    const isMapped =
      bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isMapped) {
      const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return BLOCKED_V4.some(([base, p]) => inV4Cidr(v4, base, p));
    }
    return BLOCKED_V6.some((cidr) => inV6Cidr(bytes, cidr));
  }
  return true; // not a valid IP → fail closed
}

// ── Resolver interface (pluggable for testing / offline demo) ──────────────────

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

export const systemResolver: Resolver = {
  resolve4: (h) => dns.promises.resolve4(h),
  resolve6: (h) => dns.promises.resolve6(h),
};

export type ValidationResult =
  | { ok: true; resolvedIps: string[]; isIpLiteral: boolean }
  | { ok: false; reason: string };

const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * DNS-aware SSRF validation. Returns the resolved IPs on success so the caller
 * can pin the outbound connection to a validated address.
 */
export async function validateOutboundUrl(
  rawUrl: string,
  resolver: Resolver = systemResolver,
): Promise<ValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "URL must use HTTPS." };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URL must not contain embedded credentials." };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_NAMES.has(hostname)) return { ok: false, reason: "Reserved hostname." };
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "Reserved TLD." };
  }

  const isIpLiteral = net.isIP(hostname) !== 0;
  if (isIpLiteral) {
    if (isPrivateOrReservedIp(hostname)) return { ok: false, reason: "Private/reserved IP literal." };
    return { ok: true, resolvedIps: [hostname], isIpLiteral: true };
  }

  const resolvedIps: string[] = [];
  await Promise.allSettled([
    resolver.resolve4(hostname).then((a) => resolvedIps.push(...a)),
    resolver.resolve6(hostname).then((a) => resolvedIps.push(...a)),
  ]);

  if (resolvedIps.length === 0) return { ok: false, reason: "Hostname does not resolve." };

  // Reject if ANY resolved record is private/reserved (defeats split-horizon /
  // multi-record rebinding tricks).
  for (const ip of resolvedIps) {
    if (isPrivateOrReservedIp(ip)) return { ok: false, reason: `Resolves to private/reserved IP ${ip}.` };
  }
  return { ok: true, resolvedIps, isIpLiteral: false };
}

/**
 * POST to a PRE-VALIDATED, pinned IP using https.request so no second DNS
 * resolution happens between validation and connection — closing the rebinding
 * TOCTOU window. SNI (`servername`) + Host header carry the original domain so
 * TLS and virtual hosting still work. Redirects are NOT followed.
 */
export function postToPinnedIp(
  originalUrl: string,
  pinnedIp: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(originalUrl);
    const req = https.request(
      {
        hostname: pinnedIp,
        port: parsed.port ? Number(parsed.port) : 443,
        path: (parsed.pathname || "/") + parsed.search,
        method: "POST",
        headers: { ...headers, host: parsed.hostname },
        servername: parsed.hostname, // TLS SNI pinned to original domain
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Demo (offline — uses a stub resolver, no real outbound calls) ──────────────

if (process.argv.includes("--demo")) {
  const fakeDns: Record<string, { v4: string[]; v6: string[] }> = {
    "public.example": { v4: ["93.184.216.34"], v6: [] },
    "rebind.example": { v4: ["93.184.216.34", "169.254.169.254"], v6: [] }, // multi-record rebind attempt
    "internal.example": { v4: ["10.1.2.3"], v6: [] },
    "ipv6.example": { v4: [], v6: ["2606:2800:220:1:248:1893:25c8:1946"] },
    "v6local.example": { v4: [], v6: ["fd00::1"] },
  };
  const stub: Resolver = {
    resolve4: async (h) => fakeDns[h]?.v4 ?? [],
    resolve6: async (h) => fakeDns[h]?.v6 ?? [],
  };

  const cases = [
    "https://public.example/webhook",
    "https://rebind.example/webhook",   // one good + one metadata IP → deny
    "https://internal.example/hook",    // RFC1918 → deny
    "https://ipv6.example/hook",         // global v6 → allow
    "https://v6local.example/hook",      // unique-local v6 → deny
    "https://169.254.169.254/latest",    // metadata IP literal → deny
    "https://93.184.216.34/ok",          // public IP literal → allow
    "http://public.example/insecure",    // not https → deny
    "https://user:pass@public.example/", // embedded creds → deny
  ];

  console.log("=== SSRF validation decisions ===");
  Promise.all(
    cases.map(async (u) => {
      const r = await validateOutboundUrl(u, stub);
      console.log(r.ok ? "ALLOW" : "DENY ", u, "→", r.ok ? r.resolvedIps.join(",") : r.reason);
    }),
  ).then(() => {
    console.log("\n=== Direct IP predicate spot-check ===");
    for (const ip of ["8.8.8.8", "10.0.0.5", "127.0.0.1", "::1", "2606:2800::1", "::ffff:10.0.0.1"]) {
      console.log(`${ip.padEnd(24)} private/reserved=${isPrivateOrReservedIp(ip)}`);
    }
  });
}
