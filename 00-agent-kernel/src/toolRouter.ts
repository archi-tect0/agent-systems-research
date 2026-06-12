// Primitive 2 — Tool routing.
//
// A registry that maps an intent to a tool by trigger-term match, plus a
// dependency-aware dispatcher. Independent tools in a plan run concurrently;
// dependent tools wait for and receive their inputs. The transitive dependency
// closure is resolved automatically, and cycles fail closed instead of
// deadlocking.

import type { Tool, ToolResult } from "./types.ts";

export interface RouteMatch {
  tool: Tool;
  score: number;
}

export class ToolRouter {
  tools: Map<string, Tool>;

  constructor() {
    this.tools = new Map();
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  route(intent: string): RouteMatch | null {
    const lower = intent.toLowerCase();
    let best: RouteMatch | null = null;
    for (const tool of this.tools.values()) {
      let score = 0;
      for (const term of tool.triggers) {
        if (lower.includes(term.toLowerCase())) score++;
      }
      if (score > 0 && (best === null || score > best.score)) {
        best = { tool, score };
      }
    }
    return best;
  }

  async dispatch(
    rootNames: string[],
    intent: string,
    args: Record<string, unknown> = {},
  ): Promise<Map<string, ToolResult>> {
    // Resolve the transitive dependency closure of the requested tools.
    const needed = new Map<string, Tool>();
    const visit = (name: string): void => {
      if (needed.has(name)) return;
      const t = this.tools.get(name);
      if (!t) return; // unknown tool: skip, dependents see undefined for it
      needed.set(name, t);
      for (const d of t.dependsOn ?? []) visit(d);
    };
    for (const n of rootNames) visit(n);

    const results = new Map<string, ToolResult>();
    const done = new Set<string>();
    const indeg = new Map<string, number>();
    for (const [name, t] of needed) {
      const deps = (t.dependsOn ?? []).filter((d) => needed.has(d));
      indeg.set(name, deps.length);
    }

    let remaining = needed.size;
    while (remaining > 0) {
      const wave = [...needed.keys()].filter(
        (n) => !done.has(n) && indeg.get(n) === 0,
      );
      if (wave.length === 0) {
        for (const n of needed.keys()) {
          if (!done.has(n)) results.set(n, { ok: false, error: "dependency cycle" });
        }
        break;
      }
      const settled = await Promise.allSettled(
        wave.map(async (name) => {
          const t = needed.get(name) as Tool;
          const deps: Record<string, unknown> = {};
          for (const d of t.dependsOn ?? []) {
            // Strict resolution: an unresolved dependency fails the dependent
            // closed rather than silently passing it `undefined`.
            if (!this.tools.has(d)) throw new Error(`missing dependency: ${d}`);
            const dr = results.get(d);
            if (!dr || !dr.ok) throw new Error(`dependency failed: ${d}`);
            deps[d] = dr.value;
          }
          const value = await t.run({ intent, args, deps });
          return { name, value };
        }),
      );
      for (let i = 0; i < wave.length; i++) {
        const name = wave[i];
        const s = settled[i];
        if (s.status === "fulfilled") {
          results.set(name, { ok: true, value: s.value.value });
        } else {
          results.set(name, { ok: false, error: String(s.reason) });
        }
        done.add(name);
        remaining--;
        for (const [m, t] of needed) {
          if ((t.dependsOn ?? []).includes(name)) {
            indeg.set(m, (indeg.get(m) ?? 1) - 1);
          }
        }
      }
    }
    return results;
  }
}
