/**
 * Typed World-Model Graph with Goal Topology
 *
 * A per-user entity graph that gives an agent a structured model of the user's
 * life — typed entities (person / goal / project / routine / commitment /
 * constraint / aversion / preference / threat) with properties and confidence
 * scores, rather than a flat bag of retrieved text snippets.
 *
 * Goal topology:
 *   Each entity may carry a `parentEntityId` inside its JSON properties. This
 *   single field forms a tree: life goals → projects → subgoals → tasks. The
 *   hierarchy is reconstructed at READ time (getGoalTree) — there are no
 *   adjacency tables, no recursive SQL, and no extra columns. One flat list of
 *   rows plus a property link is enough.
 *
 * Context injection:
 *   renderWorldModelContext() turns the graph into a compact, indented block
 *   suitable for injection into a system prompt, so the model reasons about
 *   blockers and milestones instead of re-reading raw memory hits.
 *
 * Dependencies: Node.js built-ins only. The store here is in-memory; the
 * production version persists rows to Postgres and filters by wallet, but the
 * graph reconstruction and rendering logic are identical.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type EntityType =
  | "person"
  | "goal"
  | "routine"
  | "commitment"
  | "constraint"
  | "project"
  | "aversion"
  | "preference"
  | "threat";

export interface WorldModelEntity {
  id:         string;
  entityType: EntityType;
  entityId:   string;
  label:      string;
  properties: Record<string, unknown>;
  confidence: number;
  confirmed:  boolean;
  updatedAt:  number;
}

/** A node in the goal/project hierarchy tree. */
export interface GoalNode extends WorldModelEntity {
  children: GoalNode[];
  depth:    number;
}

export interface UpsertInput {
  entityType:      EntityType;
  label:           string;
  entityId?:       string;
  properties?:     Record<string, unknown>;
  confidence?:     number;
  confirmed?:      boolean;
  parentEntityId?: string;
}

// ── Slug generation ─────────────────────────────────────────────────────────

function slugify(type: EntityType, label: string): string {
  return `${type}.${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`;
}

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `e${_idCounter.toString(36)}`;
}

// ── The graph store ─────────────────────────────────────────────────────────

export class WorldModelGraph {
  private entities: Map<string, WorldModelEntity>;

  constructor() {
    this.entities = new Map();
  }

  /**
   * Insert a new entity or merge into the existing one with the same entityId.
   * Merging keeps the higher confidence and unions properties (new wins).
   */
  upsert(input: UpsertInput): WorldModelEntity {
    const entityId = input.entityId ?? slugify(input.entityType, input.label);

    const propsIn: Record<string, unknown> = { ...(input.properties ?? {}) };
    if (input.parentEntityId) propsIn["parentEntityId"] = input.parentEntityId;

    const existing = this.entities.get(entityId);
    if (existing) {
      existing.label      = input.label;
      existing.properties = { ...existing.properties, ...propsIn };
      existing.confidence = Math.max(existing.confidence, input.confidence ?? 0.8);
      existing.confirmed  = input.confirmed ?? existing.confirmed;
      existing.updatedAt  = Date.now();
      return existing;
    }

    const entity: WorldModelEntity = {
      id:         nextId(),
      entityType: input.entityType,
      entityId,
      label:      input.label,
      properties: propsIn,
      confidence: input.confidence ?? 0.8,
      confirmed:  input.confirmed ?? false,
      updatedAt:  Date.now(),
    };
    this.entities.set(entityId, entity);
    return entity;
  }

  get(entityId: string): WorldModelEntity | null {
    return this.entities.get(entityId) ?? null;
  }

  /** All entities of the given types, sorted by descending confidence. */
  listByType(types: EntityType[]): WorldModelEntity[] {
    const set = new Set(types);
    return [...this.entities.values()]
      .filter(e => set.has(e.entityType))
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Reconstruct the goal/project hierarchy from properties.parentEntityId.
   * Linear in the number of entities — one pass to build nodes, one pass to
   * wire parents. No recursive queries.
   */
  getGoalTree(): GoalNode[] {
    const flat = this.listByType(["goal", "project", "commitment", "routine"]);

    const nodeMap = new Map<string, GoalNode>();
    for (const e of flat) {
      nodeMap.set(e.entityId, { ...e, children: [], depth: 0 });
    }

    const roots: GoalNode[] = [];
    for (const node of nodeMap.values()) {
      const parentId = node.properties["parentEntityId"] as string | undefined;
      const parent = parentId ? nodeMap.get(parentId) : undefined;
      if (parent) {
        node.depth = parent.depth + 1;
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return sortGoalTree(roots);
  }

  /**
   * Render the graph as a compact, indented context block for prompt injection.
   * Hierarchies show up to two levels deep with a typed icon per node.
   */
  renderContext(): string {
    const people      = this.listByType(["person"]);
    const goalTree    = this.getGoalTree();
    const commitments = this.listByType(["commitment"]);
    const constraints = this.listByType(["constraint"]);
    const aversions   = this.listByType(["aversion"]);
    const threats     = this.listByType(["threat"]);

    const total =
      people.length + goalTree.length + commitments.length +
      constraints.length + aversions.length + threats.length;
    if (total === 0) return "";

    const lines: string[] = ["[World Model]"];

    if (people.length > 0) {
      const head = people.slice(0, 5).map(e => e.label).join(", ");
      const more = people.length > 5 ? ` (+${people.length - 5})` : "";
      lines.push(`People: ${head}${more}`);
    }

    if (goalTree.length > 0) {
      const goalLines = goalTree.slice(0, 3).map(n => fmtNode(n, "")).join("\n");
      lines.push(`Goals:\n${goalLines}`);
    }

    fmt(lines, "Commitments", commitments.slice(0, 3));
    fmt(lines, "Constraints", constraints.slice(0, 3));
    fmt(lines, "Aversions",   aversions.slice(0, 3));
    if (threats.length > 0) fmt(lines, "Active threats", threats);

    return lines.join("\n");
  }

  size(): number {
    return this.entities.size;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sortGoalTree(nodes: GoalNode[]): GoalNode[] {
  nodes.sort((a, b) => b.confidence - a.confidence);
  for (const node of nodes) sortGoalTree(node.children);
  return nodes;
}

const TYPE_ICON: Partial<Record<EntityType, string>> = {
  goal:    "[goal]",
  project: "[proj]",
};

function fmtNode(node: GoalNode, indent: string): string {
  const icon = TYPE_ICON[node.entityType] ?? "[item]";
  const line = `${indent}${icon} ${node.label}`;
  // Stop expanding past two indent levels to keep the block compact.
  if (node.children.length === 0 || indent.length > 2) return line;
  const childLines = node.children.slice(0, 3).map(c => fmtNode(c, indent + "  ")).join("\n");
  return line + "\n" + childLines;
}

function fmt(lines: string[], label: string, ents: WorldModelEntity[]): void {
  if (ents.length === 0) return;
  const head = ents.slice(0, 3).map(e => e.label).join(", ");
  const more = ents.length > 3 ? ` (+${ents.length - 3})` : "";
  lines.push(`${label}: ${head}${more}`);
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const g = new WorldModelGraph();

  // People the agent knows about.
  g.upsert({ entityType: "person", label: "Dana (co-founder)", confidence: 0.95 });
  g.upsert({ entityType: "person", label: "Dr. Lee (physician)", confidence: 0.7 });

  // A life goal → project → subgoal hierarchy built purely from parent links.
  const life = g.upsert({ entityType: "goal", label: "Ship the product", confidence: 0.97 });
  const proj = g.upsert({
    entityType: "project", label: "Beta launch",
    parentEntityId: life.entityId, confidence: 0.9,
  });
  g.upsert({
    entityType: "goal", label: "Finish onboarding flow",
    parentEntityId: proj.entityId, confidence: 0.85,
  });
  g.upsert({
    entityType: "goal", label: "Pass security review",
    parentEntityId: proj.entityId, confidence: 0.8,
  });

  // A second, independent root.
  g.upsert({ entityType: "goal", label: "Get healthier", confidence: 0.6 });

  // Cross-cutting facts.
  g.upsert({ entityType: "commitment", label: "Weekly investor update (Fridays)" });
  g.upsert({ entityType: "constraint", label: "Runway: 7 months", confidence: 0.99 });
  g.upsert({ entityType: "aversion",   label: "Hates surprise meetings" });

  console.log("Entities stored:", g.size());

  const tree = g.getGoalTree();
  console.log("\nGoal tree roots:", tree.map(n => `${n.label}(d=${n.depth},kids=${n.children.length})`).join(", "));

  console.log("\nInjected context block:\n");
  console.log(g.renderContext());

  // Upsert merge: same entityId raises confidence and unions properties.
  const before = g.get(life.entityId)!.confidence;
  g.upsert({ entityType: "goal", label: "Ship the product", confidence: 0.99, properties: { deadline: "Q2" } });
  const after = g.get(life.entityId)!;
  console.log(`\nMerge upsert: confidence ${before} -> ${after.confidence}, props=`, after.properties);
}
