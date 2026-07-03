// Guide 105 — Background Task Load and Return-Pressure Scheduler
//
// Standalone implementation of Eq.24 and Eq.25: background task load and return pressure.
// This model governs the load (entropy) imposed by background tasks and the 
// return pressure of suspended threads.

interface BackgroundTask {
  id: string;
  priority: number; // 0-10
  status: 'queued' | 'active' | 'verifying' | 'completed' | 'failed';
  createdAt: number;
}

const MAX_TASKS = 3;

/**
 * Eq.24 — Background Load (H_bg)
 * H_bg = 1 - exp(−Σ_i w_i × u_i)
 * 
 * Measures the load imposed by background tasks.
 */
function computeBackgroundLoad(tasks: BackgroundTask[]): number {
  let sum_wu = 0;
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'failed') continue;

    const w_i = Math.max(0, Math.min(10, task.priority)) / 10;
    let u_i = 0;
    switch (task.status) {
      case "queued":    u_i = 1.0; break;
      case "active":    u_i = 0.7; break;
      case "verifying": u_i = 0.5; break;
    }
    sum_wu += w_i * u_i;
  }

  return 1 - Math.exp(-sum_wu);
}

/**
 * Eq.25 — Thread Return Pressure (R_i)
 * R_i = χ_i * exp(-Δt_i / t_half) * (1 - C_merge)
 * 
 * Measures the pressure to return to a background thread.
 */
function computeThreadReturnPressure(
  task: BackgroundTask,
  now: number,
  tHalfMinutes: number = 30,
  cMerge: number = 0.3
): number {
  const chi_i = Math.max(0, Math.min(10, task.priority)) / 10;
  const deltaT = Math.max(0, (now - task.createdAt) / (1000 * 60));
  
  const R_i = chi_i * Math.exp(-deltaT / tHalfMinutes) * (1 - cMerge);
  return Math.max(0, Math.min(1, R_i));
}

class BackgroundManager {
  private tasks: BackgroundTask[] = [];

  enqueue(id: string, priority: number): void {
    const activeTasks = this.tasks.filter(t => ['queued', 'active', 'verifying'].includes(t.status));
    if (activeTasks.length >= MAX_TASKS) {
      throw new Error("Concurrency cap reached: maximum background tasks allowed.");
    }

    this.tasks.push({
      id,
      priority,
      status: 'queued',
      createdAt: Date.now()
    });
  }

  updateStatus(id: string, status: BackgroundTask['status']): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.status = status;
  }

  getLoad(): number {
    return computeBackgroundLoad(this.tasks);
  }

  getPressure(id: string, now: number): number {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw new Error("Task not found");
    return computeThreadReturnPressure(task, now);
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (process.argv.includes("--demo")) {
  console.log("Running Background Task Load and Return-Pressure Scheduler demo...");

  const manager = new BackgroundManager();
  const now = Date.now();

  // 1. Enqueue tasks and check load
  manager.enqueue("task_1", 8); // High priority
  console.log(`[step 1] task_1 enqueued (priority 8). Load: ${manager.getLoad().toFixed(4)}`);
  assert(manager.getLoad() > 0, "Load should be positive after enqueuing a task");

  manager.enqueue("task_2", 5); // Medium priority
  console.log(`[step 2] task_2 enqueued (priority 5). Load: ${manager.getLoad().toFixed(4)}`);

  manager.enqueue("task_3", 2); // Low priority
  console.log(`[step 3] task_3 enqueued (priority 2). Load: ${manager.getLoad().toFixed(4)}`);

  // 2. Check the concurrency cap
  try {
    manager.enqueue("task_4", 10);
    assert(false, "Should have thrown a concurrency-cap error");
  } catch (e: any) {
    console.log(`[step 4] Saturation check: ${e.message}`);
    assert(e.message.includes("Concurrency cap reached"), "Expected concurrency-cap error message");
  }

  // 3. Test status weights on load
  const h_queued = manager.getLoad();
  manager.updateStatus("task_1", "active");
  const h_active = manager.getLoad();
  console.log(`[step 5] task_1 set to 'active'. Load: ${h_active.toFixed(4)} (was ${h_queued.toFixed(4)})`);
  assert(h_active < h_queued, "Load should decrease as tasks move from queued to active");

  manager.updateStatus("task_1", "verifying");
  const h_verifying = manager.getLoad();
  console.log(`[step 6] task_1 set to 'verifying'. Load: ${h_verifying.toFixed(4)}`);
  assert(h_verifying < h_active, "Load should decrease further in verifying state");

  // 4. Test Thread Return Pressure (Eq. 25)
  const p_initial = manager.getPressure("task_2", now);
  const p_later = manager.getPressure("task_2", now + 15 * 60 * 1000); // 15 mins later
  const p_much_later = manager.getPressure("task_2", now + 60 * 60 * 1000); // 60 mins later

  console.log(`[step 7] task_2 pressure: t=0: ${p_initial.toFixed(4)}, t=15m: ${p_later.toFixed(4)}, t=60m: ${p_much_later.toFixed(4)}`);
  assert(p_later < p_initial, "Pressure should decay over time");
  assert(p_much_later < p_later, "Pressure should continue to decay over time");

  // 5. Completion
  manager.updateStatus("task_1", "completed");
  manager.updateStatus("task_2", "completed");
  manager.updateStatus("task_3", "completed");
  console.log(`[step 8] All tasks completed. Load: ${manager.getLoad().toFixed(4)}`);
  assert(manager.getLoad() === 0, "Load should be 0 when all tasks are completed");

  console.log("\n[property checks] Eq.24 load + Eq.25 pressure decay + concurrency cap: PASS");
  console.log("\nGuide 105 demo complete.");
}
