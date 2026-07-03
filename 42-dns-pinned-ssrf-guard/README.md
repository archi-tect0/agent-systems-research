# DNS-Pinned SSRF Guard for Outbound Webhooks


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A service that lets users register an outbound webhook URL — "POST here when something happens" — is handing an attacker a server-side request primitive. If the validation is naive, the attacker registers a URL that points at infrastructure the *server* can reach but the *outside world* cannot: `http://127.0.0.1:6379`, `http://10.0.0.5/admin`, or the cloud metadata endpoint `http://169.254.169.254/latest/meta-data/iam/...`. This is Server-Side Request Forgery (SSRF), and the metadata-endpoint variant has been the root cause of several large cloud breaches because it can hand out short-lived IAM credentials to anyone who can make the instance fetch a URL.

String-only checks are not enough. Blocking `localhost` and `10.*` in the hostname string does nothing against `http://my-evil-domain.example/` whose DNS A record simply *resolves to* `10.0.0.5`. So the validator has to resolve DNS and inspect the actual IPs.

But resolving DNS introduces a Time-Of-Check-To-Time-Of-Use (TOCTOU) gap. The classic DNS-rebinding attack exploits exactly this: the validator resolves `evil.example` and sees a public IP (passes), then the HTTP client resolves `evil.example` *again* at connection time and now gets `169.254.169.254` (the attacker flipped the record, or returned a short-TTL/multi-record answer). The check and the use saw different IPs.

This guard closes that window. It resolves the host, checks **every** A and AAAA record against the blocked ranges, and then — critically — connects directly to the *already-validated IP*, carrying the original hostname only in the TLS SNI field and the `Host` header. There is no second DNS resolution between check and use, so the IP that was vetted is the exact IP the socket connects to.

## Design decisions

**Why check ALL resolved records, not just the first?**
A hostname can resolve to multiple addresses. A rebinding or split-horizon attacker returns one public IP and one internal IP in the same answer, betting the validator checks index 0 and the HTTP client round-robins to index 1. Rejecting the request if *any* record is private/reserved defeats this — there is no "good" IP to hide behind.

**Why pin the connection to the validated IP instead of just re-checking?**
Re-checking at connect time still races: the resolver can return a different answer microseconds later. The only way to make check and use agree is to remove the second lookup entirely. The HTTP request is made with `hostname` set to the literal validated IP, while `servername` (TLS SNI) and the `Host` header keep the original domain so TLS certificate validation and virtual-host routing still work correctly.

**Why fail closed on unparseable IPs and empty DNS results?**
A value the range-checker cannot parse, or a hostname that resolves to nothing, is treated as private/reserved (rejected). An SSRF guard that defaults to "allow" on anything ambiguous is not a guard. Every uncertain path denies.

**Why require HTTPS and forbid embedded credentials?**
Plain HTTP webhook delivery leaks the payload and offers no server identity. Embedded credentials (`https://user:pass@host/`) are a known parser-confusion vector — different URL parsers disagree on where the host begins, so they are rejected outright rather than reasoned about.

**Why block reserved hostnames and TLDs before touching DNS?**
`localhost`, `*.local`, `*.internal`, `*.localhost`, and `metadata.google.internal` are well-known internal names. Rejecting them by string match first avoids a DNS round-trip and avoids depending on a resolver that might be configured to answer them.

**Why not follow redirects?**
A `302` is a fresh URL that was never validated. The pinned request uses `https.request`, which does not follow redirects, so a server cannot bounce the client from a vetted public IP to an internal one. Following redirects safely would require re-running the full validate-and-pin cycle on each hop.

## Algorithm

```
validateOutboundUrl(rawUrl):
  parsed = parse(rawUrl)                         // reject if not a URL
  if parsed.scheme != "https"            -> DENY "must use HTTPS"
  if parsed.username or parsed.password  -> DENY "embedded credentials"

  host = lowercase(strip brackets(parsed.hostname))
  if host in {localhost, metadata.google.internal} -> DENY "reserved hostname"
  if host ends with .local/.internal/.localhost    -> DENY "reserved TLD"

  if host is an IP literal:
    if isPrivateOrReservedIp(host) -> DENY
    return ALLOW { resolvedIps:[host], isIpLiteral:true }

  ips = resolve4(host) ++ resolve6(host)        // allSettled: gather both
  if ips is empty -> DENY "does not resolve"     // fail closed
  for ip in ips:
    if isPrivateOrReservedIp(ip) -> DENY         // ANY private record = reject
  return ALLOW { resolvedIps: ips, isIpLiteral:false }

isPrivateOrReservedIp(ip):
  kind = ipKind(ip)                              // 4, 6, or invalid
  if invalid -> return true                      // fail closed
  if IPv4: return ip in any BLOCKED_V4 CIDR
  if IPv6:
    if IPv4-mapped (::ffff:a.b.c.d): check embedded v4 against BLOCKED_V4
    return ip in any BLOCKED_V6 CIDR

postToPinnedIp(originalUrl, pinnedIp, headers, body, timeoutMs):
  parsed = parse(originalUrl)
  https.request({
    hostname:   pinnedIp,                        // connect to VALIDATED ip
    port:       parsed.port or 443,
    path:       parsed.pathname + parsed.search,
    headers:    { ...headers, host: parsed.hostname },
    servername: parsed.hostname,                 // TLS SNI = original domain
  })                                             // NO redirect following
```

Blocked IPv4 ranges include `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local, contains the metadata IP), `172.16/12`, `192.168/16`, the IETF/TEST-NET/benchmark blocks, multicast `224/4`, and reserved `240/4`. Blocked IPv6 ranges include `::1/128`, `::/128`, `fc00::/7` (ULA), `fe80::/10` (link-local), and `ff00::/8` (multicast).

## Reference implementation

See [`dns-pinned-ssrf-guard.ts`](./dns-pinned-ssrf-guard.ts) in this directory.

It runs on Node.js built-ins only (`dns`, `net`, `https`); the IPv4/IPv6 CIDR math is implemented inline so the file is self-contained. The DNS resolver is injected through a small `Resolver` interface, which keeps the validator unit-testable offline. The production source (`ssrfGuard.ts`) performs the same logic using the `ipaddr.js` library for range math; that dependency is the only difference and is hidden behind the same `isPrivateOrReservedIp` boundary.

## Usage

```typescript
import {
  validateOutboundUrl,
  postToPinnedIp,
  isPrivateOrReservedIp,
  systemResolver,
} from "./dns-pinned-ssrf-guard.js";

// 1. Validate before ever opening a socket.
const result = await validateOutboundUrl("https://hooks.example.com/notify");

if (!result.ok) {
  throw new Error(`Webhook rejected: ${result.reason}`);
}

// 2. Deliver to a pinned, already-validated IP. No second DNS lookup happens
//    between the check above and the connection below.
const pinnedIp = result.resolvedIps[0];
const { ok, status } = await postToPinnedIp(
  "https://hooks.example.com/notify",
  pinnedIp,
  { "content-type": "application/json" },
  JSON.stringify({ event: "ping" }),
  5_000, // timeout in ms
);

// Direct predicate, e.g. for an allow/deny audit log.
isPrivateOrReservedIp("169.254.169.254"); // true  (cloud metadata)
isPrivateOrReservedIp("8.8.8.8");          // false

// A custom resolver can be injected for tests:
await validateOutboundUrl("https://host.example/x", systemResolver);
```

## Limitations and extensions

- **Single-snapshot DNS.** Validation resolves once and pins that result. A record with a sub-second TTL could in principle differ between two separate `validateOutboundUrl` calls — but because delivery pins the IP from the *same* result object, the check-to-use window is closed within one request. Re-validate per delivery, not once at registration.
- **No redirect following by design.** If a webhook endpoint legitimately needs to redirect, the caller must re-run `validateOutboundUrl` + `postToPinnedIp` for the new location. Blindly following redirects reopens the SSRF hole.
- **IPv6 happy-eyeballs.** When a host has both A and AAAA records, this implementation pins one address; a production client that wants happy-eyeballs failover must pin and validate each candidate it might connect to.
- **Range list is policy, not law.** The blocked-CIDR tables encode a specific deployment's notion of "internal." Environments with additional private supernets (e.g. a corporate `100.x` overlay) must extend the lists.
- **DNS-level pinning only.** This does not defend against a fully compromised resolver that lies about a public IP. Pair with an egress firewall / NAT policy for defense in depth.
```
