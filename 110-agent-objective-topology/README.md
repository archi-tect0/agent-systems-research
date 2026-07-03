# Guide 110 — Agent Objective Topology and Process Management

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A dual-layer system for long-horizon goal tracking and stateful background execution, turning flat todo lists into structured objective topologies and one-shot tools into persistent OS-level processes.*

---

## Problem

Agents often struggle with two distinct but related execution gaps:
1. **The Continuity Gap**: Standard tool calls are stateless and ephemeral. If an agent needs to perform a multi-step research task or monitor a condition over time, it has no native "background process" to hold that state across conversation turns or server restarts.
2. **The Topology Gap**: Simple todo lists fail to capture the relationships between goals. Some objectives are prerequisites for others, some have different time horizons (day vs. quarter), and others are perpetual. Without a typed topology, agents lose focus on the "why" behind their immediate actions.

## Design decisions

- **Process-as-OS-Thread**: Processes are modeled after kernel process tables. They have a `stack` for nested subtasks, `locals` for scratchpad memory, and `status` (running, paused, completed) for lifecycle management.
- **Objective Topology**: Instead of a flat list, objectives are categorized by `horizon` (day, week, month, etc.) and decomposed into ordered `milestones`. This allows the agent to reason about progress percentages and "stale" goals that haven't been reviewed.
- **Context Injection**: Active objectives are distilled into a compact "OBJ" block (e.g., `[W]Research AI 40% 2/5 →Read paper X`) and injected into every agent turn. This ensures long-term goals remain in the agent's immediate "peripheral vision."
- **Persistent State**: Both processes and objectives are backed by a durable database, ensuring that an agent's "mind" survives a restart and can resume background work immediately.

## Algorithm

### Process Lifecycle
```
function runProcess(processId):
  state = loadProcess(processId)
  while state.stack is not empty:
    currentStep = state.stack.pop()
    result = execute(currentStep)
    if result.needsSubtask:
      state.stack.push(currentStep) // resume later
      state.stack.push(result.subtask)
    updateDb(state)
```

### Objective Review
```
function getContext(wallet):
  objectives = listActiveObjectives(wallet)
  for obj in objectives:
    nextMilestone = obj.milestones.find(!completed)
    line = format("[{obj.horizon}] {obj.title} {obj.progress}% -> {nextMilestone}")
  return line
```

## Reference implementation

The implementation demonstrates a standalone `ProcessManager` and `ObjectiveManager` using in-memory stores that mimic the production DB-backed systems.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Simulated Parallelism**: In this reference implementation, "background" processes are stepped manually. A production system would use a dedicated worker loop (like `agentScheduler.ts`) to drive these processes.
- **Dependency Graphs**: The current topology is primarily hierarchical (Objective -> Milestones). Extending this to a full Directed Acyclic Graph (DAG) would allow for cross-objective dependencies.
- **LLM-in-the-loop Review**: Stale objectives are flagged by time, but a more advanced system could use a "critic" model to judge if an objective is still relevant based on recent conversation history.
