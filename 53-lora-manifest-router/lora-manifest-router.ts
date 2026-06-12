/**
 * Manifest-Driven LoRA Expert Router
 *
 * A local inference stack can host many small fine-tuned adapters ("experts"),
 * each teaching one narrow, stable capability — tool formatting, transaction
 * review, world-model synthesis, and so on. This router decides WHICH adapter(s)
 * to activate for a given turn, from a declarative manifest, before the base
 * model runs.
 *
 * Each adapter advertises:
 *   - the intent kinds it serves,
 *   - a trigger-term regex matched against the user text,
 *   - a deployment status (only "deployed" adapters are ever activated),
 *   - a list of capabilities (for documentation / introspection).
 *
 * Selection scores every deployed adapter by intent-kind match + trigger-term
 * match, returns the top matches in priority order, and falls through to the
 * unaugmented base model when nothing matches or nothing is deployed.
 *
 * This is distinct from a prefix-weight compiler (which fuses weights ahead of
 * time): here the manifest is the routing table and adapters stay modular, each
 * with an explicit capability boundary.
 *
 * Dependencies: none (Node built-ins only).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AdapterStatus = "not_trained" | "training" | "ready" | "deployed";

export interface AdapterManifest {
  id:           string;          // unique slug
  name:         string;          // display name
  capabilities: string[];        // what this adapter teaches
  triggerKinds: string[];        // intent kinds that activate this adapter
  triggerTerms: RegExp;          // text-match trigger
  status:       AdapterStatus;
  modelFile?:   string;          // adapter weight tag when deployed
}

export interface AdapterSelection {
  adapters: AdapterManifest[];   // selected (may be empty → base model)
  primary:  AdapterManifest | null;
  reason:   string;
}

// ── Example manifest library ──────────────────────────────────────────────────
// Neutral, generic experts. A real deployment would mark a subset "deployed".

export const ADAPTER_LIBRARY: AdapterManifest[] = [
  {
    id:           "tool_formatter",
    name:         "Tool Invocation Formatter",
    capabilities: ["tool selection", "argument normalization", "multi-step chaining"],
    triggerKinds: ["tool_use", "dispatch"],
    triggerTerms: /\b(run|execute|call|invoke|use|send|create|fetch|open|schedule|search)\b/i,
    status:       "deployed",
  },
  {
    id:           "transaction_guard",
    name:         "Transaction Security Guard",
    capabilities: ["phishing detection", "approval risk classification", "escalation triggers"],
    triggerKinds: ["wallet", "security"],
    triggerTerms: /\b(approve|sign|permit|unlimited|infinite|suspicious|scam|drain|risk|unsafe)\b/i,
    status:       "deployed",
  },
  {
    id:           "worldmodel_synth",
    name:         "World Model Synthesizer",
    capabilities: ["entity extraction", "goal synthesis", "obligation tracking"],
    triggerKinds: ["memory_store", "conversation"],
    triggerTerms: /\b(goal|objective|project|routine|obligation|working on|trying to)\b/i,
    status:       "deployed",
  },
  {
    id:           "memory_operator",
    name:         "Memory Operator",
    capabilities: ["write/skip decision", "deduplication", "privacy-aware storage"],
    triggerKinds: ["memory_store", "memory_recall"],
    triggerTerms: /\b(remember|recall|forget|note|i (prefer|always|never))\b/i,
    status:       "ready",   // trained but NOT deployed → never activated yet
  },
];

// ── Router ────────────────────────────────────────────────────────────────────

const KIND_WEIGHT = 10;  // intent-kind match is the strongest signal
const TERM_WEIGHT = 8;   // trigger-term match
const CLOSE_BAND  = 3;   // also return runners-up within this many points

/**
 * Select adapter(s) for a turn.
 *
 * Only adapters with status "deployed" are eligible — anything else falls
 * through to the unaugmented base model. Returns up to two adapters when their
 * scores are close, so a turn that legitimately spans two experts can load both.
 */
export function selectAdapters(
  intentKind: string,
  userText:   string,
  library:    AdapterManifest[] = ADAPTER_LIBRARY,
): AdapterSelection {
  const text = userText.slice(0, 800);

  const scored = library
    .filter(m => m.status === "deployed")
    .map(m => {
      let score = 0;
      if (m.triggerKinds.includes(intentKind)) score += KIND_WEIGHT;
      if (m.triggerTerms.test(text))           score += TERM_WEIGHT;
      return { m, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { adapters: [], primary: null, reason: "no_match: base model runs unaugmented" };
  }

  const top = scored[0]!;
  const selected = scored
    .filter(x => top.score - x.score <= CLOSE_BAND)
    .slice(0, 2)
    .map(x => x.m);

  return {
    adapters: selected,
    primary:  selected[0]!,
    reason:   `matched intent="${intentKind}" top=${top.m.id} score=${top.score}`,
  };
}

/** Mark an adapter deployed (e.g. when its weight file is found at boot). */
export function markDeployed(
  library: AdapterManifest[],
  id:      string,
  modelFile: string,
): boolean {
  const m = library.find(x => x.id === id);
  if (!m) return false;
  m.status = "deployed";
  m.modelFile = modelFile;
  return true;
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const turns: Array<{ kind: string; text: string }> = [
    { kind: "tool_use",     text: "run a web search for flight prices and open the cheapest" },
    { kind: "wallet",       text: "should I approve this unlimited token allowance?" },
    { kind: "memory_store", text: "my goal this quarter is to ship the new project" },
    { kind: "memory_store", text: "remember that I prefer dark mode" }, // adapter is "ready", not deployed
    { kind: "smalltalk",    text: "good morning, how are you?" },        // no match → base model
  ];

  for (const t of turns) {
    const sel = selectAdapters(t.kind, t.text);
    const ids = sel.adapters.map(a => a.id).join(", ") || "(base model)";
    console.log(`[${t.kind}] "${t.text}"`);
    console.log(`   → ${ids}   :: ${sel.reason}\n`);
  }

  console.log("Deploying memory_operator, re-routing the memory turn:");
  markDeployed(ADAPTER_LIBRARY, "memory_operator", "memory_operator:v1");
  const sel = selectAdapters("memory_store", "remember that I prefer dark mode");
  console.log(`   → ${sel.adapters.map(a => a.id).join(", ")}   :: ${sel.reason}`);
}
