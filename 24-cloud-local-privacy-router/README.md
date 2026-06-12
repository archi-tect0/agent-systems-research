# Cloud / Local Privacy Router

## Problem

A hybrid agent has two places to run a turn: a small **local** model on the user's device (private, but limited) and a powerful **cloud** model (capable, but it sees everything you send it). The naive policies are both wrong:

- "Always cloud" leaks secrets. If the user says *"import my wallet, the seed phrase is `legal winner thank year …`"*, the seed phrase goes straight to a third-party API log.
- "Always local" throws away capability. Most turns — search the web, summarize an inbox, check the calendar — contain nothing sensitive and would be far better served by the cloud model.

What you actually want is a per-turn decision: route to the cloud **when it is safe**, route locally **when it is not**, and when a sensitive turn genuinely has to touch the cloud (because the local model is down), **strip the secret first** so the cloud sees the user's intent but never the secret itself.

The key insight is that *sensitivity is a property of the tools a turn will use, not of the words alone*. A turn that will call `export_private_key` is sensitive even if the user phrased it innocuously; a turn that will call `web_search` is safe even if it contains scary-looking text. So the router classifies by **expected tool set**, and uses text redaction only as a second, defense-in-depth layer on whatever does cross to the cloud.

## Design decisions

**Four privacy classes, attached to tools.**
Every tool carries a `PrivacyClass`:

| Class | Meaning |
|---|---|
| `local_only` | must never leave the device (key export, seed display, recovery shares) |
| `local_preferred` | prefer local; cloud only as a degraded, redacted fallback (signing, vault read) |
| `cloud_safe_summary` | cloud allowed, but summarize first; offload heavy execution to local |
| `cloud_allowed` | safe to send verbatim (web search, weather, public data) |

**Most-restrictive class wins.**
A turn often touches several tools. The router aggregates by taking the *strictest* class present: one `local_only` tool in the set forces the whole turn local. This is fail-safe — you can never accidentally downgrade a sensitive turn by mixing it with innocuous tools.

**Routing is a decision, redaction is a guarantee.**
The class decides *where* the turn runs. But even a `local_preferred` turn can be forced to the cloud when the local model is down — so a separate, always-on redaction pass runs on anything cloud-bound. The two layers are independent: classification can have a bug and the redactor still strips the seed phrase; the redactor can miss a novel format and classification still kept the `local_only` turn off the cloud entirely.

**Redaction replaces, it does not delete.**
A stripped secret becomes a labelled placeholder (`[REDACTED:seed_phrase]`) and a trailing privacy note tells the cloud model *that* fields were removed. This preserves the structure of the request — the cloud model understands "the user gave a seed phrase here" and can act on the intent ("import a wallet") without ever receiving the value, and it won't hallucinate to fill a silent gap.

**`hybrid` for heavy-but-safe turns.**
`cloud_safe_summary` turns that fan out to many tools route to `hybrid`: the cloud model does the reasoning/planning, but tool execution happens locally. This keeps the expensive multi-tool I/O on-device while still using the strong model where it adds value.

**Graceful degradation, logged.**
A `local_only` turn when the local model is down cannot be served as intended. Rather than failing the user outright, the router downgrades to a *redacted* cloud call (`reasonCode: degraded_cloud_redacted`) and records exactly that in the trust log. Every decision — including the degraded ones — lands in a ring buffer that powers a user-facing transparency view ("this turn ran locally; that turn sent a redacted summary to the cloud").

## Algorithm

```
route(ctx):
  if forceCloud: → cloud
  if forceLocal: → local  (or redacted cloud if local is down)

  agg = mostRestrictive( privacyClass(t) for t in ctx.toolsExpected )

  switch agg:
    local_only:
      localReady ? → local : → cloud (degraded, redacted)
    local_preferred:
      localReady ? → local : → cloud (redacted fallback)
    cloud_safe_summary:
      (toolsExpected > 2 and localReady) ? → hybrid : → cloud (summary)
    cloud_allowed:
      → cloud

redactForCloud(text):
  for each (label, pattern) in REDACT_PATTERNS:
    replace matches with [REDACTED:label]; note label
  return cleaned text + removed labels

abstractForCloud(text):
  (cleaned, removed) = redactForCloud(text)
  if removed: append "[PRIVACY NOTE: N field(s) redacted: ...]"
  return cleaned
```

The redaction patterns match by *keyword + bounded lookahead* (e.g. `seed phrase` followed by up to 120 characters) and by *format* (a 64-hex-digit `0x…` private key, an `M of N` share reference). Bounded lookahead matters: it captures the value following the keyword without a catastrophic-backtracking regex.

## Reference implementation

See [`privacy-router.ts`](./privacy-router.ts) in this directory.

## Usage

```typescript
import {
  routeToCloudOrLocal, abstractForCloud,
  recordTrustEntry, getRecentTrustLog,
  type PrivacyClassResolver,
} from "./privacy-router.js";

// Resolve a tool name to its privacy class from your registry.
const resolve: PrivacyClassResolver = name => toolRegistry[name]?.privacyClass ?? "cloud_allowed";

const result = routeToCloudOrLocal(
  { turnId, toolsExpected: plannedTools, localReady: isLocalModelUp() },
  resolve,
);
recordTrustEntry(result.trustLogEntry);

if (result.decision === "cloud") {
  // Defense in depth: strip secrets from anything cloud-bound.
  const safeContext = abstractForCloud(rawContext);
  await cloudModel.chat(safeContext);
} else {
  await localModel.chat(rawContext);
}

// Power a transparency UI.
const recent = getRecentTrustLog(20);
```

## Limitations and extensions

- **Redaction is pattern-based, not semantic.** It catches known secret shapes (seed phrases, hex keys, share references, bearer tokens). A novel secret format the patterns don't anticipate will pass through. Treat redaction as defense-in-depth *behind* tool-class routing, never as the sole control — the `local_only` class is what truly keeps secrets off the cloud.
- **Classification trusts the planner.** The router classifies by the tools the planner *expects* to call. If the model later decides to call a `local_only` tool mid-turn that the planner didn't predict, the turn may already be on the cloud. Re-checking at actual tool-dispatch time (and aborting the cloud turn) is a stronger, more expensive design.
- **`local_ready` is a point-in-time flag.** The caller passes current local-model readiness. A health probe with a short TTL (a few seconds) is the natural source; a stale flag can mis-route.
- **Trust log is in-memory and ephemeral.** The ring buffer survives only for the process lifetime. For a durable, auditable record, persist entries (and consider tamper-evidence — see the Merkle audit-anchoring guide).
- **No content-based class escalation.** The router does not raise a turn's class because its *text* looks sensitive. You could add a pre-pass: if `redactForCloud` would strip anything, escalate the turn to at least `local_preferred`. That couples the two layers but catches the "innocuous tool, sensitive words" case.
