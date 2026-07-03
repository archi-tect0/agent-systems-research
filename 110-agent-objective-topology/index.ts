// Guide 110 — Agent Objective Topology and Process Management
//
// A standalone demonstration of stateful process management (stack-based subtasks)
// and objective topology (milestones, horizons, and context injection).

import { randomUUID } from "node:crypto";

// --- Types ---

type ProcessStatus = "running" | "paused" | "completed" | "error";
type ObjectiveStatus = "active" | "paused" | "completed" | "abandoned";
type ObjectiveHorizon = "day" | "week" | "month" | "ongoing";

interface Process {
  id: string;
  name: string;
  status: ProcessStatus;
  stack: string[];
  locals: Record<string, any>;
  nextStep: string | null;
}

interface Milestone {
  id: string;
  description: string;
  completed: boolean;
}

interface Objective {
  id: string;
  title: string;
  horizon: ObjectiveHorizon;
  status: ObjectiveStatus;
  milestones: Milestone[];
  progressPct: number;
}

// --- Process Manager ---

class ProcessManager {
  private processes = new Map<string, Process>();

  createProcess(name: string, steps: string[]): Process {
    const id = randomUUID();
    const process: Process = {
      id,
      name,
      status: "running",
      stack: [...steps].reverse(), // stack: top is end of array
      locals: {},
      nextStep: steps[0] || null,
    };
    this.processes.set(id, process);
    return process;
  }

  step(id: string): string | null {
    const p = this.processes.get(id);
    if (!p || (p.status !== "running" && p.status !== "completed")) return null;

    const step = p.stack.pop();
    if (!step) {
      p.status = "completed";
      p.nextStep = null;
      return null;
    }

    p.nextStep = p.stack[p.stack.length - 1] || null;
    if (p.stack.length === 0) {
      p.status = "completed";
    }
    return step;
  }

  getProcess(id: string) { return this.processes.get(id); }
}

// --- Objective Manager ---

class ObjectiveManager {
  private objectives = new Map<string, Objective>();

  createObjective(title: string, horizon: ObjectiveHorizon, milestoneDescs: string[]): Objective {
    const id = randomUUID();
    const milestones: Milestone[] = milestoneDescs.map((d, i) => ({
      id: `${id}-m${i}`,
      description: d,
      completed: false
    }));

    const obj: Objective = {
      id,
      title,
      horizon,
      status: "active",
      milestones,
      progressPct: 0
    };
    this.objectives.set(id, obj);
    return obj;
  }

  completeMilestone(objId: string, milestoneId: string) {
    const obj = this.objectives.get(objId);
    if (!obj) return;

    const m = obj.milestones.find(m => m.id === milestoneId);
    if (m) {
      m.completed = true;
      const done = obj.milestones.filter(ms => ms.completed).length;
      obj.progressPct = Math.round((done / obj.milestones.length) * 100);
      if (obj.progressPct === 100) obj.status = "completed";
    }
  }

  getInjectionContext(): string {
    const active = Array.from(this.objectives.values()).filter(o => o.status === "active");
    if (active.length === 0) return "";

    const lines = ["\nOBJ:"];
    for (const obj of active) {
      const next = obj.milestones.find(m => !m.completed);
      const h = obj.horizon[0].toUpperCase();
      lines.push(`[${h}]${obj.title} ${obj.progressPct}% →${next?.description || "DONE"}`);
    }
    return lines.join("\n");
  }
}

// --- Assertions & Demo ---

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function runDemo() {
  console.log("--- Starting Guide 110 Demo ---");

  const pm = new ProcessManager();
  const om = new ObjectiveManager();

  // 1. Process Lifecycle Test
  console.log("\n[Scenario 1] Stateful Process Execution");
  const proc = pm.createProcess("Research Project", ["Identify sources", "Extract data", "Synthesize"]);
  assert(proc.status === "running", "Process should start as running");
  
  const step1 = pm.step(proc.id);
  console.log(`Executed: ${step1}`);
  assert(step1 === "Identify sources", "First step should be the first item in the list");
  assert(pm.getProcess(proc.id)?.nextStep === "Extract data", "Next step should be updated");

  pm.step(proc.id);
  pm.step(proc.id);
  assert(pm.getProcess(proc.id)?.status === "completed", "Process should complete after all steps");
  console.log("Process lifecycle: PASS");

  // 2. Objective Topology Test
  console.log("\n[Scenario 2] Objective Topology & Context Injection");
  const obj = om.createObjective("Launch Satellite", "month", ["Build rocket", "Fuel up", "Ignite"]);
  
  let ctx = om.getInjectionContext();
  console.log("Initial Context:", ctx);
  assert(ctx.includes("[M]Launch Satellite 0%"), "Context should show 0% progress");
  assert(ctx.includes("→Build rocket"), "Context should show first milestone");

  om.completeMilestone(obj.id, obj.milestones[0].id);
  ctx = om.getInjectionContext();
  console.log("Updated Context:", ctx);
  assert(ctx.includes("33%"), "Progress should reflect completed milestone");
  assert(ctx.includes("→Fuel up"), "Context should advance to next milestone");

  om.completeMilestone(obj.id, obj.milestones[1].id);
  om.completeMilestone(obj.id, obj.milestones[2].id);
  assert(om.getInjectionContext() === "", "Completed objectives should be evicted from context");
  console.log("Objective topology: PASS");

  console.log("\nGuide 110 demo complete: ALL PASS");
}

if (process.argv.includes("--demo")) {
  runDemo().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
