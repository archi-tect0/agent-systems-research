// Primitive 1 — Memory.
//
// A salience-ranked store of text items. Recall blends lexical similarity,
// recency, prior usage, and caller-supplied importance into one score. There
// are no embeddings and no external services: similarity is a built-in token
// overlap so the primitive runs anywhere. Swap in a vector scorer by replacing
// `similarity` — the rest of the mechanism is unchanged.

import type { MemoryItem, MemoryQueryResult } from "./types.ts";

export interface MemoryWeights {
  similarity: number;
  recency: number;
  usage: number;
  importance: number;
}

export interface MemoryOptions {
  recencyHalfLifeMs?: number;
  weights?: Partial<MemoryWeights>;
}

const DEFAULT_WEIGHTS: MemoryWeights = {
  similarity: 0.5,
  recency: 0.2,
  usage: 0.1,
  importance: 0.2,
};

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 1) out.add(t);
  }
  return out;
}

function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export class Memory {
  items: MemoryItem[];
  halfLife: number;
  weights: MemoryWeights;
  private seq: number;

  constructor(opts: MemoryOptions = {}) {
    this.items = [];
    this.halfLife = opts.recencyHalfLifeMs ?? 1000 * 60 * 60 * 24; // 1 day
    this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
    this.seq = 0;
  }

  remember(text: string, kind = "note", weight = 0.5): MemoryItem {
    const item: MemoryItem = {
      id: `m${++this.seq}`,
      text,
      kind,
      createdAt: Date.now(),
      uses: 0,
      weight: Math.max(0, Math.min(1, weight)),
    };
    this.items.push(item);
    return item;
  }

  recall(query: string, k = 3, now = Date.now()): MemoryQueryResult[] {
    const scored = this.items.map((item) => {
      const sim = similarity(query, item.text);
      const ageMs = Math.max(0, now - item.createdAt);
      const recency = Math.pow(0.5, ageMs / this.halfLife);
      const usage = item.uses / (item.uses + 1);
      const w = this.weights;
      const score =
        w.similarity * sim +
        w.recency * recency +
        w.usage * usage +
        w.importance * item.weight;
      return { item, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    for (const r of top) r.item.uses++; // recall reinforces
    return top;
  }

  size(): number {
    return this.items.length;
  }
}
