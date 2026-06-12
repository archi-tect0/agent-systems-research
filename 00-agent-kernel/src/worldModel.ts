// Primitive 5 — World model.
//
// A typed entity store with parent/child links. The hierarchy is reconstructed
// at read time and rendered as a compact, indented text block suitable for
// injection into a prompt. Entity types (person, goal, project, routine, ...)
// are caller-defined; the kernel only knows about ids, labels, and parent
// links.

import type { Entity } from "./types.ts";

export class WorldModel {
  entities: Map<string, Entity>;

  constructor() {
    this.entities = new Map();
  }

  upsert(entity: Entity): void {
    const existing = this.entities.get(entity.id);
    this.entities.set(entity.id, { ...existing, ...entity });
  }

  link(childId: string, parentId: string): void {
    const child = this.entities.get(childId);
    if (child) child.parentId = parentId;
  }

  children(id: string): Entity[] {
    return [...this.entities.values()].filter((e) => e.parentId === id);
  }

  roots(): Entity[] {
    return [...this.entities.values()].filter(
      (e) => !e.parentId || !this.entities.has(e.parentId),
    );
  }

  render(): string {
    const lines: string[] = [];
    const walk = (e: Entity, depth: number): void => {
      const indent = "  ".repeat(depth);
      const props = Object.entries(e.props)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`${indent}- [${e.type}] ${e.label}${props ? ` (${props})` : ""}`);
      for (const child of this.children(e.id)) walk(child, depth + 1);
    };
    for (const root of this.roots()) walk(root, 0);
    return lines.length ? lines.join("\n") : "(empty)";
  }

  size(): number {
    return this.entities.size;
  }
}
