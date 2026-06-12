// The kernel — a thin assembly layer that composes the five primitives.
//
// The kernel owns no policy. It exposes the five primitives directly (so an
// agent can drive them however it likes) and provides one reference
// composition, `runIntent`, that threads them in the order a careful agent
// would: route -> govern -> spend-check -> dispatch -> remember. Replace or
// reorder that composition freely; the primitives do not depend on it.

import { Memory } from "./memory.ts";
import type { MemoryOptions } from "./memory.ts";
import { ToolRouter } from "./toolRouter.ts";
import { Governance } from "./governance.ts";
import { WalletLimits } from "./walletLimits.ts";
import { WorldModel } from "./worldModel.ts";
import type { WalletConfig } from "./types.ts";

export interface KernelConfig {
  wallet: WalletConfig;
  memory?: MemoryOptions;
}

export interface IntentResult {
  ok: boolean;
  output?: unknown;
  denied?: string;
  requiresApproval?: boolean;
}

export class Kernel {
  memory: Memory;
  tools: ToolRouter;
  governance: Governance;
  wallet: WalletLimits;
  world: WorldModel;

  constructor(config: KernelConfig) {
    this.memory = new Memory(config.memory);
    this.tools = new ToolRouter();
    this.governance = new Governance();
    this.wallet = new WalletLimits(config.wallet);
    this.world = new WorldModel();
  }

  async runIntent(
    intent: string,
    opts: { amount?: number; args?: Record<string, unknown> } = {},
  ): Promise<IntentResult> {
    const match = this.tools.route(intent);
    if (!match) return { ok: false, denied: "no tool matched intent" };
    const tool = match.tool;

    // Governance: capability + invariants. Amount is exposed to invariants.
    const auth = this.governance.authorize({
      type: "tool",
      capability: tool.capability,
      payload: { intent, amount: opts.amount },
    });
    if (!auth.allowed) return { ok: false, denied: auth.reason };

    // Wallet limits: only for tools that declare themselves as spending funds.
    // Check (but do not charge) before execution; charge only on success.
    const isSpend = tool.spend === true;
    if (isSpend) {
      if (typeof opts.amount !== "number") {
        return { ok: false, denied: "spend amount required" };
      }
      const decision = this.wallet.attempt(opts.amount);
      if (!decision.allowed) return { ok: false, denied: decision.reason };
      if (decision.requiresApproval) {
        return { ok: false, requiresApproval: true, denied: decision.reason };
      }
    }

    // Dispatch (resolves the tool's dependency closure).
    const results = await this.tools.dispatch([tool.name], intent, opts.args ?? {});
    const r = results.get(tool.name);
    const succeeded = Boolean(r && r.ok);

    // Charge the wallet only after the spending action actually succeeded.
    if (isSpend && succeeded && typeof opts.amount === "number") {
      this.wallet.record(opts.amount);
    }

    // Memory: record what happened so future turns can recall it.
    this.memory.remember(`intent="${intent}" -> ${tool.name}`, "action", 0.6);

    if (succeeded) return { ok: true, output: r?.value };
    return { ok: false, denied: r?.error ?? "tool failed" };
  }

  // The context block an agent would prepend to a prompt: world model + the
  // memory most relevant to the query.
  context(query: string): string {
    const mems = this.memory.recall(query, 3);
    const memLines = mems.map(
      (m) => `- (${m.score.toFixed(2)}) ${m.item.text}`,
    );
    return [
      "## World model",
      this.world.render(),
      "",
      "## Relevant memory",
      memLines.length ? memLines.join("\n") : "(none yet)",
    ].join("\n");
  }
}
