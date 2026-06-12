/**
 * Cloud / Local Privacy Router
 *
 * Decides, per agent turn, whether to run on a local model or a cloud model,
 * driven by the privacy sensitivity of the tools the turn is expected to use.
 * Before any cloud call, secret-bearing text (seed phrases, private keys,
 * session tokens, recovery shares) is redacted and replaced with a labelled
 * placeholder, so the cloud sees the user's INTENT, never the secret.
 *
 * Privacy classes (most-restrictive wins when a turn touches several tools):
 *   local_only          — must never leave the device
 *   local_preferred     — prefer local; cloud only as a degraded, redacted fallback
 *   cloud_safe_summary  — cloud allowed, but summarize first; local for heavy exec
 *   cloud_allowed       — safe to send verbatim
 *
 * Routing outcomes:
 *   "local"  — run locally; do not call the cloud
 *   "cloud"  — call the cloud; redact secrets first
 *   "hybrid" — cloud for reasoning, local for tool execution
 *
 * Every decision is recorded in a small ring buffer for a user-facing trust /
 * transparency view.
 *
 * Dependencies: none (pure TypeScript). The tool-metadata lookup is an
 * interface — wire your own tool registry behind getPrivacyClass().
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrivacyClass =
  | "local_only"
  | "local_preferred"
  | "cloud_safe_summary"
  | "cloud_allowed";

export type RouteDecision = "local" | "cloud" | "hybrid";

export interface RouteResult {
  decision:       RouteDecision;
  reason:         string;
  reasonCode:     string;
  redactedFields?: string[];
  trustLogEntry:  TrustLogEntry;
}

export interface TrustLogEntry {
  turn:          string;
  decision:      RouteDecision;
  toolsInvolved: string[];
  localOnly:     string[];   // tool / field names kept local
  cloudSent:     string[];   // what was allowed to the cloud
  timestamp:     string;
}

/** Resolve a tool name to its privacy class. Wire your registry here. */
export type PrivacyClassResolver = (toolName: string) => PrivacyClass;

// ── Secret redaction ───────────────────────────────────────────────────────────
// Always strip these from any cloud-bound payload, regardless of routing class.

const REDACT_PATTERNS: Array<{ label: string; re: RegExp; replacement: string }> = [
  { label: "seed_phrase",      re: /\b(seed phrase|mnemonic|recovery phrase)\b[\s\S]{0,120}/gi, replacement: "[REDACTED:seed_phrase]" },
  { label: "private_key",      re: /\b(private key|secret key)\b[\s\S]{0,80}/gi,                replacement: "[REDACTED:private_key]" },
  { label: "hex_private_key",  re: /0x[0-9a-f]{64}/gi,                                          replacement: "[REDACTED:hex_key]" },
  { label: "passkey_material", re: /\bpasskey\s*(attestation|credential|assertion)\b[\s\S]{0,60}/gi, replacement: "[REDACTED:passkey]" },
  { label: "secret_share",     re: /\b(shard|share)\s*\d+\s*of\s*\d+\b[\s\S]{0,80}/gi,         replacement: "[REDACTED:secret_share]" },
  { label: "session_token",    re: /\b(sessionToken|session_token|bearer)\s*[:=]\s*[\w\-.]+/gi, replacement: "[REDACTED:session_token]" },
];

/** Redact secrets from text. Returns the cleaned text + the labels removed. */
export function redactForCloud(text: string): { redacted: string; removedLabels: string[] } {
  let out = text;
  const removed: string[] = [];
  for (const { label, re, replacement } of REDACT_PATTERNS) {
    const prev = out;
    out = out.replace(re, replacement);
    if (out !== prev) removed.push(label);
  }
  return { redacted: out, removedLabels: removed };
}

/**
 * Redact + annotate context being handed to the cloud. If anything was
 * stripped, a privacy note is appended so the cloud model knows fields were
 * removed (and does not hallucinate around the gap).
 */
export function abstractForCloud(context: string): string {
  const { redacted, removedLabels } = redactForCloud(context);
  if (removedLabels.length === 0) return context;
  return redacted +
    `\n\n[PRIVACY NOTE: ${removedLabels.length} sensitive field(s) redacted before cloud routing: ${removedLabels.join(", ")}]`;
}

// ── Privacy aggregation — most restrictive class wins ───────────────────────────

function aggregatePrivacy(toolNames: string[], resolve: PrivacyClassResolver): PrivacyClass {
  const classes = toolNames.map(resolve);
  if (classes.includes("local_only"))         return "local_only";
  if (classes.includes("local_preferred"))    return "local_preferred";
  if (classes.includes("cloud_safe_summary")) return "cloud_safe_summary";
  return "cloud_allowed";
}

// ── Router ─────────────────────────────────────────────────────────────────────

export interface RouterContext {
  turnId:        string;
  toolsExpected: string[];   // tools the planner expects the turn to call
  localReady:    boolean;    // is the local model currently available?
  forceCloud?:   boolean;    // admin override
  forceLocal?:   boolean;    // admin override
}

export function routeToCloudOrLocal(
  ctx: RouterContext,
  resolve: PrivacyClassResolver,
): RouteResult {
  const { turnId, toolsExpected, localReady, forceCloud, forceLocal } = ctx;

  // Admin overrides first.
  if (forceCloud) {
    return makeResult("cloud", "admin_force_cloud", "admin_override", [], toolsExpected, turnId);
  }
  if (forceLocal) {
    if (!localReady) {
      return makeResult("cloud", "local_forced_but_unavailable", "degraded_cloud_redacted", [], toolsExpected, turnId);
    }
    return makeResult("local", "admin_force_local", "admin_override", toolsExpected, [], turnId);
  }

  const agg = aggregatePrivacy(toolsExpected, resolve);

  // local_only — never route to cloud verbatim. If local is down the best we
  // can do is a redacted, degraded cloud call.
  if (agg === "local_only") {
    if (!localReady) {
      return makeResult("cloud", "local_only_but_local_down", "degraded_cloud_redacted", toolsExpected, [], turnId);
    }
    return makeResult("local", "local_only_tools", "privacy_enforced", toolsExpected, [], turnId);
  }

  // local_preferred — prefer local; cloud (redacted) only if local is down.
  if (agg === "local_preferred") {
    if (localReady) {
      return makeResult("local", "local_preferred_and_available", "privacy_preferred", toolsExpected, [], turnId);
    }
    return makeResult("cloud", "local_preferred_local_down", "cloud_fallback_with_redaction", [], toolsExpected, turnId);
  }

  // cloud_safe_summary — cloud is fine, but offload heavy multi-tool execution
  // to local when available.
  if (agg === "cloud_safe_summary") {
    if (toolsExpected.length > 2 && localReady) {
      return makeResult("hybrid", "multi_tool_with_summary", "hybrid_local_exec", toolsExpected, [], turnId);
    }
    return makeResult("cloud", "cloud_safe_summary", "cloud_allowed_with_summary", [], toolsExpected, turnId);
  }

  // cloud_allowed — full cloud routing.
  return makeResult("cloud", "cloud_allowed_tools", "cloud_optimal", [], toolsExpected, turnId);
}

function makeResult(
  decision: RouteDecision,
  reason: string,
  reasonCode: string,
  localOnly: string[],
  cloudSent: string[],
  turn: string,
): RouteResult {
  return {
    decision,
    reason,
    reasonCode,
    redactedFields: localOnly.length > 0 ? localOnly : undefined,
    trustLogEntry: {
      turn,
      decision,
      toolsInvolved: [...localOnly, ...cloudSent],
      localOnly,
      cloudSent,
      timestamp: new Date().toISOString(),
    },
  };
}

// ── Trust log (in-memory ring buffer) ──────────────────────────────────────────

const TRUST_LOG_SIZE = 100;
const _trustLog: TrustLogEntry[] = [];

export function recordTrustEntry(entry: TrustLogEntry): void {
  _trustLog.push(entry);
  if (_trustLog.length > TRUST_LOG_SIZE) _trustLog.shift();
}

export function getRecentTrustLog(limit = 20): TrustLogEntry[] {
  return _trustLog.slice(-limit).reverse();
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // A tiny tool registry for the demo.
  const registry: Record<string, PrivacyClass> = {
    export_private_key: "local_only",
    sign_transaction:   "local_preferred",
    summarize_inbox:    "cloud_safe_summary",
    web_search:         "cloud_allowed",
    fetch_calendar:     "cloud_allowed",
  };
  const resolve: PrivacyClassResolver = name => registry[name] ?? "cloud_allowed";

  const cases: RouterContext[] = [
    { turnId: "t1", toolsExpected: ["export_private_key"],            localReady: true  },
    { turnId: "t2", toolsExpected: ["export_private_key"],            localReady: false },
    { turnId: "t3", toolsExpected: ["sign_transaction"],             localReady: false },
    { turnId: "t4", toolsExpected: ["summarize_inbox", "web_search", "fetch_calendar"], localReady: true },
    { turnId: "t5", toolsExpected: ["web_search"],                    localReady: true  },
  ];

  for (const c of cases) {
    const r = routeToCloudOrLocal(c, resolve);
    recordTrustEntry(r.trustLogEntry);
    console.log(`${c.turnId}: ${r.decision.padEnd(7)} ${r.reasonCode}`);
  }

  console.log("\n--- redaction ---");
  const secret = "Here is my seed phrase: legal winner thank year wave sausage worth useful. Also key 0x" + "a".repeat(64);
  console.log(abstractForCloud(secret));

  console.log("\n--- trust log ---");
  console.log(getRecentTrustLog(3).map(e => `${e.turn} → ${e.decision}`).join("\n"));
}
