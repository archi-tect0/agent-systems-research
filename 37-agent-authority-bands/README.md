# Tiered Authority Bands for Agent Tool Execution

## Problem

An autonomous agent that can call tools has a spectrum of capabilities: some are pure reads (check a balance, look up a price), some prepare an action without committing it, some perform bounded reversible writes, and some are irreversible and high-stakes (send funds, revoke a key, delete a vault). A flat "this tool needs approval / this one doesn't" lookup table does not scale, and worse, it leaks authority in two dangerous ways:

1. **The model can rename its way around the gate.** If the approval check keys on a tool name or on the wording of the request, a sufficiently clever model — or a prompt-injection payload riding in retrieved content — can phrase a sensitive call as something the gate does not recognize.
2. **Unknown tools default to "allowed."** When a new tool is added (or an MCP extension is hot-loaded) and no policy row exists yet, a fail-open lookup silently grants it full autonomous execution.

The authority-band model replaces the ad-hoc lookup with a **server-authoritative, fail-closed** classification. Every tool resolves to exactly one band, 0 through 4, and the band — not the model, not the phrasing — determines whether the call executes automatically, requires a single human approval, requires dual authorization, or can never run autonomously at all.

## Design decisions

**Why five bands instead of a boolean?**
A boolean ("needs approval") cannot express the difference between "show a preview, no approval needed" and "send irreversible funds, always require a fresh human passkey." Five bands map cleanly onto the real risk ladder:

```
Band 0 — read / observe.        auto-exec.       no approval.
Band 1 — recommend / prepare.   auto-exec.       no approval.
Band 2 — safe bounded auto.     auto-exec.       no approval.
Band 3 — dual-authorization.    requires approval + dual-auth.
Band 4 — never autonomous.      requires approval, never auto-executes.
```

Bands 0–2 all auto-execute; the distinction between them is semantic (used by routing, telemetry, and the tool critic, guide 39), not by the approval gate. The hard line is between band 2 and band 3: that is where a human enters the loop.

**Why fail-closed to Band 4?**
An unknown tool name — one the model invented, one renamed to dodge the gate, or one not yet seeded into the policy table — resolves to **Band 4**, the *hardest* band, never Band 0. This is the single most important property of the engine. The model cannot manufacture autonomy by being creative with names.

**Why a registration-gap safety net for platform tools?**
There is one nuance. When a known first-party tool ships before its policy row is seeded, fail-closing it to Band 4 would silently kill a legitimate feature. So the evaluator accepts an explicit `isPlatformTool` flag: a *known* platform tool with no row defaults to **Band 1** (safe display, no approval) instead of Band 4. Truly unknown / model-invented names — where the caller passes `false` or omits the flag — still hit Band 4. The trust comes from the *caller* asserting the name is on the server's own allowlist, not from the model.

**Why a server-side prep signature for Band 3?**
Band 3 is dual-authorization. The two authorizations are:

- **Authorization 1 (machine):** at queue time the server computes an HMAC-SHA256 over the *canonical* action package (wallet, tool, args, expiry, band) and stores it on the pending row.
- **Authorization 2 (human):** at execute time the user produces a WebAuthn passkey assertion over the same package.

Receipts carry both. A forensic auditor can later prove (a) the agent prepared *this exact* package and (b) the human approved *this exact* package — neither could have been substituted. The signature is computed over **canonical JSON** (keys sorted recursively) so two semantically identical packages always serialize to the same bytes regardless of property insertion order. A fresh 128-bit nonce is embedded in the wire form (`nonce.mac`) so every prep attempt is unique even when two requests collide on the same millisecond with identical arguments.

**Why a short in-process cache?**
Band assignments live in a database table so an operator can re-tier a tool without a deploy. Reading that table on every single tool call would add a round-trip to the hot path, so the engine caches it for a few minutes. A forced-flush hook lets the extension-install path re-sync immediately when it adds or changes a band, rather than waiting for the TTL.

## Algorithm

```
evaluatePolicy(wallet, toolName, isPlatformTool):
  table = loadCache()                       // DB-backed, TTL ~5 min
  row   = table.get(toolName)

  if row is missing:
    if isPlatformTool:  return Band 1  (band1_display,     no approval)
    else:               return Band 4  (unknown_fail_closed, approval + neverAuto)

  band = clamp(row.band, 0, 4)              // defensive clamp
  if band <= 2: return { band, requiresApproval:false, requiresDualAuth:false, neverAuto:false }
  if band == 3: return { band, requiresApproval:true,  requiresDualAuth:row.requiresDualAuth, neverAuto:false }
  if band == 4: return { band, requiresApproval:true,  requiresDualAuth:false, neverAuto:row.neverAuto }

computeAgentPrepSig(wallet, tool, args, expiresAt, band):
  nonce     = randomBytes(16)
  canonical = canonicalJSON({ v, wallet:lowercase, tool, args, expiresAt:ISO, band, nonce })
  mac       = HMAC_SHA256(PREP_SECRET, canonical)
  return nonce + "." + mac
```

The band clamp (`max(0, min(4, band))`) means even a corrupted or out-of-range value in the table degrades to a valid band rather than throwing or being interpreted as "no restriction."

## Reference implementation

See [`authority-bands.ts`](./authority-bands.ts) in this directory. It uses an in-memory band table for runnability; the comments mark exactly where a production deployment swaps in a database query plus the short-lived cache.

## Usage

```typescript
import { AuthorityPolicyEngine } from "./authority-bands.js";

const engine = new AuthorityPolicyEngine();
engine.setBand("get_balance", 0);
engine.setBand("send_funds",  4);                 // never autonomous
engine.setBand("rotate_key",  3, { requiresDualAuth: true });

// Hot path — runs on every tool call
const verdict = await engine.evaluate({ wallet, toolName: "send_funds" });
if (verdict.neverAuto) {
  // suppress auto-exec; queue for human passkey approval
}

// Band-3 dual-auth: machine authorization at queue time
const prepSig = engine.computePrepSig({
  wallet, toolName: "rotate_key", args: { newKey }, expiresAt, band: 3,
});
// store prepSig on the pending row; the human passkey assertion is authorization #2

// Unknown / model-invented name → Band 4, fail-closed
const sneaky = await engine.evaluate({ wallet, toolName: "send_funds_v2_bypass" });
// sneaky.band === 4, sneaky.neverAuto === true
```

## Limitations and extensions

- **The band table is the trust root.** The engine is only as good as the band assignments. Seeding it correctly (and never letting a high-risk tool sit at a low band) is an operational responsibility. The tool critic (guide 39) adds a second, independent check that the registered risk class is consistent with the assigned band.
- **HMAC prep-sig is symmetric.** The v0 prep signature uses a shared secret, so it proves *the server* prepared the package, not which server instance. The wire format (`nonce.mac`, a base64url string on the pending row) is deliberately stable so the upgrade path — swapping the HMAC for a post-quantum ML-DSA-65 signature (guide 19) — does not change any storage or receipt schema.
- **Bands gate execution, not retrieval.** A band-4 tool can still appear in the model's tool schema; the band only blocks *autonomous execution*. Pair with intent-based tool selection (guide 09) if you also want to keep high-risk schemas out of the context window until they are relevant.
- **Cache staleness window.** A re-tiering takes effect within the cache TTL unless the flush hook is called. For changes that must be instant (revoking a tool's autonomy during an incident), always call the flush hook explicitly.
