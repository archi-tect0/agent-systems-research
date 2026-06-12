/**
 * Intent-Based Tool Schema Selection
 *
 * Cuts per-turn tool tokens from ~17K (every schema, every turn) to ~4-8K by
 * splitting "knowing a tool exists" from "knowing how to call it":
 *
 *   - A name-only TOOL_INDEX line (one drawer-grouped catalog, ~250 tokens)
 *     tells the model the whole surface.
 *   - Full schemas are loaded only for an always-on core + intent-matched
 *     drawers + keyword-probe hits + (non-conversation) dynamic tools.
 *
 * Dependencies: none (pure TypeScript).
 */

// ── Tool shape ─────────────────────────────────────────────────────────────────
// A tool definition in chat-completions form. Only `name` and an estimated
// schema size matter to the selector; the rest is opaque.

export interface ToolDef {
  name:        string;
  description?: string;
  parameters?: Record<string, unknown>;
  /** Estimated token cost of this tool's full schema (for budgeting/demo). */
  schemaTokens?: number;
}

// ── Drawers (the library-card index) ──────────────────────────────────────────
// Tools grouped into named drawers, each sized ≤12 so one drawer's schemas are
// ≤~960 tokens. TOOL_INDEX is built from these; INTENT_DRAWER_MAP references them.

export const TOOL_DRAWERS: Readonly<Record<string, readonly string[]>> = {
  ADMIN:  ["get_system_health", "read_agent_state", "get_karma_status", "list_threat_events"],
  WEB:    ["web_search", "web_fetch", "fetch_site_data", "site_audit", "get_weather", "show_map", "web_preview"],
  VIS:    ["generate_image", "generate_meme", "generate_video", "generate_diagram", "build_slides", "show_chart", "show_progress", "show_countdown", "show_code"],
  SCENE:  ["set_scene", "set_background", "show_html_template", "gravity_card", "embed_app", "embed_url", "save_scene", "load_scene", "create_widget", "remove_widget"],
  MEM:    ["remember", "recall_memory", "record_correction", "project_log", "project_status"],
  SCHED:  ["create_reminder", "create_watch_price", "cancel_schedule", "list_schedules", "create_agenda", "enable_daily_brief"],
  WALLET: ["get_token_price", "agent_spend", "agent_send", "token_swap", "explain_contract"],
  PLAN:   ["spawn_task", "delegate_subtask", "create_plan", "record_intent", "list_intents", "cancel_intent", "dispatch"],
  SELF:   ["express_self", "tone_down", "grow_personality", "set_mood", "set_name", "explain_policy"],
  CODE:   ["run_code", "analyze_code", "audit_package", "lookup_cve", "search_cve"],
  COMMS:  ["get_notifications", "lookup_contact", "start_note", "open_tab", "navigate_to"],
} as const;

/**
 * Compact name-only catalog injected once into the system prompt.
 * Format: "TOOL_INDEX: [WEB:web_search,…] [VIS:…] …" — ~250 tokens, no schemas.
 */
export function buildToolCatalog(): string {
  return "TOOL_INDEX: " +
    Object.entries(TOOL_DRAWERS)
      .map(([drawer, names]) => `[${drawer}:${(names as readonly string[]).join(",")}]`)
      .join(" ");
}

/** Union of tool names across the given drawer keys. */
export function getToolNamesForDrawers(drawers: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const d of drawers) for (const t of TOOL_DRAWERS[d] ?? []) names.add(t);
  return names;
}

// ── Stage 1 — always-on core ──────────────────────────────────────────────────
// Tools used across almost every turn regardless of topic. Schemas loaded
// unconditionally (~1K tokens) to avoid a wasted round-trip on the common case.

export const CORE_NAMES = new Set<string>([
  "remember", "recall_memory",
  "navigate_to", "web_search",
  "express_self", "grow_personality",
  "tone_down", "record_correction",
  "get_notifications",
  "open_tab",
  "create_plan", "spawn_task",
]);

// ── Stage 1.5 — intent → drawer map ───────────────────────────────────────────

export const INTENT_DRAWER_MAP: Record<string, readonly string[]> = {
  conversation:    ["MEM", "SELF"],
  memory_store:    ["MEM"],
  memory_recall:   ["MEM"],
  web_search:      ["WEB"],
  image_gen:       ["VIS"],
  screen_display:  ["VIS", "SCENE"],
  board_pin:       ["VIS", "SCENE"],
  code:            ["CODE", "VIS"],
  repo_diagnostic: ["CODE"],
  wallet:          ["WALLET"],
  reminder:        ["SCHED"],
  agent_ops:       ["PLAN", "SELF"],
  navigation:      ["WEB", "COMMS"],
  creative:        ["VIS", "SCENE", "SELF"],
  personality:     ["SELF"],
};

// ── Stage 2 — keyword safety net ──────────────────────────────────────────────
// Cheap regex probes that add specific tools when sub-intent trigger words
// appear, catching what the drawer map missed.

const KEYWORD_PROBES: ReadonlyArray<{ re: RegExp; tools: readonly string[] }> = [
  { re: /search|find|look.?up|browse|fetch.?site|news/i, tools: ["web_fetch", "web_preview", "fetch_site_data", "site_audit"] },
  { re: /\bmap\b|location|where.?is|near.?me/i,           tools: ["show_map"] },
  { re: /\bchart\b|graph|data.*visual|plot/i,             tools: ["show_chart", "show_progress"] },
  { re: /\bcode\b|\brun\b|execute|script|program/i,       tools: ["run_code", "show_code", "analyze_code"] },
  { re: /diagram|slide|flowchart|presentation/i,          tools: ["generate_diagram", "build_slides"] },
  { re: /remind|schedule|alarm|agenda|calendar/i,         tools: ["create_reminder", "list_schedules", "cancel_schedule", "create_agenda", "enable_daily_brief"] },
  { re: /watch.*price|price.*alert/i,                     tools: ["create_watch_price"] },
  { re: /swap|send.*crypto|transfer\s+\w/i,               tools: ["token_swap", "agent_send", "agent_spend"] },
  { re: /countdown|timer/i,                               tools: ["show_countdown"] },
  { re: /contact|phone.*call|reach.*out/i,                tools: ["lookup_contact"] },
  { re: /cve|vulnerab|audit.*package|security.*scan/i,    tools: ["lookup_cve", "search_cve", "audit_package"] },
  { re: /project|log|status|ship|milestone|tracker/i,     tools: ["project_log", "project_status"] },
  { re: /intent|goal|objective|mission/i,                 tools: ["record_intent", "list_intents", "cancel_intent"] },
  { re: /widget|dashboard|add.*board/i,                   tools: ["create_widget", "remove_widget"] },
  { re: /policy|explain.*rule|governance/i,               tools: ["explain_policy"] },
];

// ── Dynamic tool sets (computed per-session) ──────────────────────────────────

export interface DynamicTools {
  platform: ToolDef[];   // platform control
  mcp:      ToolDef[];   // installed MCP servers
  threat:   ToolDef[];   // threat-response
  app:      ToolDef[];   // per-user app tools (the big blob)
}

// ── The staged selector ───────────────────────────────────────────────────────

export interface SelectOptions {
  turnText:   string;
  intentKind: string;
  allTools:   ToolDef[];          // full schemas for the static surface
  dynamic:    DynamicTools;
  limit?:     number;             // provider tool cap
  onCapped?:  (info: { total: number; limit: number; dropped: number }) => void;
}

export function selectTools(opts: SelectOptions): ToolDef[] {
  const limit = opts.limit ?? 128;
  const byName = new Map(opts.allTools.map(t => [t.name, t]));

  const seen = new Set<string>();
  const out: ToolDef[] = [];
  const add = (...tools: (ToolDef | undefined)[]) => {
    for (const t of tools) {
      if (!t || seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
  };
  const addByName = (names: Iterable<string>) => {
    for (const n of names) add(byName.get(n));
  };

  // Stage 1 — always-on core.
  addByName(CORE_NAMES);

  // Stage 1.5 — intent → drawer expansion.
  const drawers = INTENT_DRAWER_MAP[opts.intentKind] ?? [];
  if (drawers.length > 0) addByName(getToolNamesForDrawers(drawers));

  // Stage 2 — keyword safety net.
  for (const probe of KEYWORD_PROBES) {
    if (probe.re.test(opts.turnText)) addByName(probe.tools);
  }

  // Stage 3 — dynamic tools (conversation turns skip the app blob).
  if (opts.intentKind === "conversation") {
    add(...opts.dynamic.platform.slice(0, 8), ...opts.dynamic.mcp, ...opts.dynamic.threat);
  } else {
    add(...opts.dynamic.platform, ...opts.dynamic.mcp, ...opts.dynamic.threat, ...opts.dynamic.app);
  }

  // Hard cap: drop the lowest-priority tail (added last).
  if (out.length > limit) {
    opts.onCapped?.({ total: out.length, limit, dropped: out.length - limit });
    return out.slice(0, limit);
  }
  return out;
}

/** Sum of estimated schema tokens for a selected tool list. */
export function estimateSchemaTokens(tools: ToolDef[]): number {
  return tools.reduce((sum, t) => sum + (t.schemaTokens ?? 200), 0);
}

// ── Demo ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // Build a full static surface from the drawers (200 tok schema each).
  const allTools: ToolDef[] = [];
  for (const names of Object.values(TOOL_DRAWERS)) {
    for (const n of names) allTools.push({ name: n, schemaTokens: 200 });
  }
  // A handful of app/platform tools (the dynamic blob).
  const mk = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `${prefix}_${i}`, schemaTokens: 200 }));
  const dynamic: DynamicTools = { platform: mk("platform", 10), mcp: mk("mcp", 4), threat: mk("threat", 3), app: mk("app", 30) };

  const fullSurface = allTools.length + dynamic.platform.length + dynamic.mcp.length + dynamic.threat.length + dynamic.app.length;
  const naiveTokens = (fullSurface * 200) + 0;

  console.log(buildToolCatalog());
  console.log(`\nFull surface: ${fullSurface} tools ≈ ${naiveTokens} schema tokens if sent every turn.\n`);

  const turns = [
    { intentKind: "conversation", turnText: "hey, how's it going?" },
    { intentKind: "wallet",       turnText: "send 0.1 ETH to alice and show me the token price" },
    { intentKind: "image_gen",    turnText: "make me a chart of last week's revenue" },
  ];

  for (const t of turns) {
    const selected = selectTools({ ...t, allTools, dynamic, limit: 128 });
    const tokens = estimateSchemaTokens(selected) + 250 /* catalog */;
    console.log(`intent=${t.intentKind.padEnd(13)} → ${String(selected.length).padStart(3)} tools, ~${tokens} tokens (saved ~${naiveTokens - tokens})`);
  }
}
