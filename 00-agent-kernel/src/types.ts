// The Agent <-> Tool <-> State contract.
//
// This file is the kernel's ABI: the small set of types every primitive and
// every consumer agrees on. It is deliberately policy-free. There are no chain
// ids, no spend thresholds, no prompt strings, and no product concepts here —
// only the shapes the mechanism needs. Policy lives in the agent that runs on
// top of the kernel, not in the kernel.

// ---- Memory ----------------------------------------------------------------

export interface MemoryItem {
  id: string;
  text: string;
  kind: string; // caller-defined category; the kernel treats it as opaque
  createdAt: number;
  uses: number;
  weight: number; // caller-supplied importance in [0, 1]
}

export interface MemoryQueryResult {
  item: MemoryItem;
  score: number;
}

// ---- Tool routing ----------------------------------------------------------

export interface ToolInput {
  intent: string;
  args: Record<string, unknown>;
  deps: Record<string, unknown>; // resolved outputs of this tool's dependencies
}

export interface Tool {
  name: string;
  description: string;
  triggers: string[]; // lowercase terms that route an intent to this tool
  capability?: string; // governance capability required to run it, if any
  spend?: boolean; // true if running this tool spends funds (subject to wallet limits)
  dependsOn?: string[]; // names of tools whose output this tool consumes
  run: (input: ToolInput) => Promise<unknown> | unknown;
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

// ---- Governance ------------------------------------------------------------

export interface GovernanceAction {
  type: string;
  capability?: string;
  payload: Record<string, unknown>;
}

export interface AuthorizeResult {
  allowed: boolean;
  reason: string;
}

export interface Invariant {
  name: string;
  // Return null to allow, or a human-readable reason string to deny.
  check: (action: GovernanceAction) => string | null;
}

// ---- Wallet limits ---------------------------------------------------------

export interface WalletConfig {
  limit: number; // max total spend inside the rolling window
  windowMs: number; // size of the rolling window
  approvalThreshold: number; // single-spend amount that forces human approval
}

export interface SpendDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  remaining: number;
}

// ---- World model -----------------------------------------------------------

export interface Entity {
  id: string;
  type: string; // person | goal | project | routine | ... (caller-defined)
  label: string;
  parentId?: string;
  props: Record<string, string>;
}
