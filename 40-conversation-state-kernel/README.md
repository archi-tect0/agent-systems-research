# Conversation State Kernel — Per-Turn Governance FSM


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A streaming conversational agent that can call tools, spawn background workers, and react to rapid-fire input has a control-flow problem that a simple request/response handler does not. Consider a single conversation where the user says, in quick succession:

> "Show me the ETH chart" … "actually no, the weather" … "stop"

Without explicit governance, three turns are now racing: the first is still streaming a chart, the second is fetching weather, the third wants everything dead. They share one output stream. The chart tokens interleave with the weather card; the "stop" arrives but the first turn keeps emitting. Worse, a turn whose only action was a silent side-effect (write a memory, set a name) can finish having emitted *nothing* to the user — a silent failure.

The conversation state kernel is the per-turn finite state machine that governs this. It is not a single function but a small set of cooperating mechanisms layered over each turn:

- **A newest-intent-wins active-turn registry** — one in-flight turn per conversation, with hard abort of the previous.
- **Surface resolution and locking** — each turn resolves to a target surface (chat / screen / board) and locks routing to it.
- **A pre-LLM dispatch gate** — turns that *must* run a tool first cannot stream prose until the tool has run.
- **Auto-fork gating** — a complexity score decides whether to spawn parallel workers.
- **An empty-response guard** — a turn must never end having said nothing.

## Design decisions

**Why a single active turn per conversation with hard abort?**
The user's latest message *is* their current intent; an older in-flight turn is, by definition, stale. The kernel keeps a registry keyed by conversation id holding the current turn's `AbortController`, sequence number, and frame version. When a new turn arrives it increments the sequence and aborts the previous turn's controller *before the LLM call* — not just on socket close — so a stale branch can never outlive the user's newer intent and pollute the shared stream.

**Why frame versioning on top of sequence numbers?**
A *follow-up* ("and also add USDC") should inherit the previous turn's worker context; a *redirect* ("actually, stop, do this instead") should invalidate it. The kernel detects redirect phrasing and, only then, bumps a `frameVersion`. Background workers are tagged with the frame version they were spawned in, so a redirect cancels exactly the stale branches (`cancelWorkersByFrame`) while a plain follow-up leaves them running. Sequence number = "which turn"; frame version = "which coherent intent context."

**Why a primary-command protection window?**
Aborting the previous turn instantly is correct for interrupts, but harmful for a just-issued explicit command ("show me the chart") that hasn't yet flushed its first visible UI event. If the user types another command 80 ms later, killing the first one mid-flight means its chart never appears. So when the previous turn is an explicit primary command whose action hasn't flushed, the kernel *defers* the abort by a short window (~120 ms) to let the first UI event escape — unless the new message is a true interrupt (stop/cancel/never mind), which always bypasses the delay.

**Why an authoritative surface resolver?**
"Put it on the screen," "pin it to the board," and a plain question all target different output surfaces. The kernel resolves one `surface` (screen / board / chat) per turn and treats it as the authoritative router: when `surface === "screen"`, a full-screen visual tool is forced and the chat-card path is suppressed. Resolving this *once*, up front, replaces a scatter of per-handler heuristics that could disagree with each other mid-turn.

**Why a pre-LLM dispatch gate?**
For some intents the right behavior is "run the tool, *then* talk about the result" — narrating before the tool has run produces confident prose about data you don't have yet. The kernel marks these intents `mustDispatch` and a gate (`canStreamSpeechEarly`) returns false for them, blocking any prose stream until the mandatory tool plan completes. Conversation turns (no mandatory tool) stream immediately.

**Why classify turn *shape* for auto-fork, not phrasing?**
Some questions genuinely need parallel sub-agents (a bug report wants a regression analyst; an architecture decision wants a dissent reviewer; a cross-source audit wants a synthesis planner). The kernel scores the turn's *shape* — signal domains present (bug, performance, architecture, policy, audit) — into a complexity score 0–3, and forks workers accordingly. Workers that finish inside a short merge-gate budget (~1.5 s) fold into the same response; late ones surface as report cards on the next turn. Forking is gated off for burst mode, proactive turns, and turns that already force a tool.

**Why an empty-response guard?**
A turn whose only action was a silent side-effect tool (write a memory, grow personality, stop audio) can reach the end having emitted no user-visible text. That is a silent failure — a violation of the operating contract. The guard catches it: for genuinely silent internal tools it stays quiet (an allowlist prevents leaking "Done. (record correction)" into chat), but for everything else it either runs a second `tool_choice:"none"` synthesis turn so the user gets a real answer, or emits a short confirmation fallback. The agent must never say nothing.

**Per-turn conversational state.**
Around this FSM the kernel also reads and writes a small conversation-state record — warmth, pacing target, dominant emotion, running average response length, turn count — inferred each turn by cheap heuristics (no LLM call) and re-injected as a compact arc block so tone and length stay calibrated across the session. A post-draft voice guard can fire a cheap critic to trim an over-long reply or warm a cold formulaic opener before it ships.

## Algorithm

```
onTurn(convId, message):
  prev      = activeTurns.get(convId)
  turnSeq   = (prev?.seq ?? 0) + 1
  redirected = isRedirect(message)
  frameVer  = redirected ? prev.frameVersion + 1 : prev.frameVersion
  isPrimary = isExplicitCommand(message)

  if prev:
    if not redirected and prev.isPrimaryCommand and not prev.flushed:
      setTimeout(() => prev.abort(), PROTECT_MS)     // defer ~120 ms
    else:
      prev.abort()                                   // hard, immediate
  activeTurns.set(convId, { ctrl, seq: turnSeq, frameVersion: frameVer, intent: "listening", flushed: false })
  if redirected: cancelWorkersByFrame(convId, frameVer)

  intent = classifyIntent(message)        // { kind, surface, mustDispatch, forcedTool }
  if intent.kind == "interrupt": ack "Stopped."; end           // priority 0

  if not canStreamSpeechEarly(intent): runToolPlan() before any prose
  if shouldFork(intent, burst, proactive): spawnWorkers(score, frameVer)

  ... stream / dispatch ...

  if response is empty and tool was not a silent internal tool:
      run synthesis turn (tool_choice:"none")  OR  emit short fallback
  if activeTurns.get(convId).seq == turnSeq: activeTurns.delete(convId)
```

States a turn moves through in the registry: `listening` → `executing:<tool>` → `completed:<tool>` (or `awaiting_approval:<tool>` for gated calls).

## Reference implementation

See [`conversation-state-kernel.ts`](./conversation-state-kernel.ts). It implements the active-turn registry, frame versioning, primary-command protection window, interrupt priority, surface resolution, the pre-LLM dispatch gate, auto-fork scoring, the empty-response guard, and the per-turn conversational-state inference — driven by injectable callbacks so it runs without an LLM or database.

## Usage

```typescript
import { ConversationStateKernel } from "./conversation-state-kernel.js";

const kernel = new ConversationStateKernel({
  runToolPlan:  async (plan) => { /* execute mustDispatch tools */ },
  streamProse:  async (ctx)  => { /* call the LLM, return text */ return "…"; },
  spawnWorkers: (roles, frameVersion) => { /* fork sub-agents */ },
});

await kernel.handleTurn(convId, "show me the ETH chart");
await kernel.handleTurn(convId, "actually, the weather");  // supersedes turn 1
await kernel.handleTurn(convId, "stop");                   // interrupt, priority 0
```

## Limitations and extensions

- **Heuristic intent classification.** Surface resolution, redirect detection, and fork scoring are regex/keyword heuristics. They are fast and deterministic but miss paraphrase; a small classifier model could replace them while keeping the same FSM around it.
- **Single-stream assumption.** The newest-intent-wins design assumes one output stream per conversation. Truly concurrent intents (two screens at once) need multiple surface locks, not one.
- **Merge-gate budget is a fixed timeout.** Workers that almost finish at 1.6 s get bumped to the next turn. An adaptive budget based on observed worker latency would fold more results inline.
- **The empty-response guard's second turn costs tokens.** The synthesis fallback runs another LLM call. For pure-ack tools a static confirmation string is cheaper; the allowlist of silent tools is what keeps the guard from firing needlessly.
