/**
 * Conversation State Kernel — Per-Turn Governance FSM
 *
 * The per-turn finite state machine that governs a streaming, tool-calling,
 * worker-forking agent.  It coordinates a set of mechanisms layered over each
 * turn:
 *
 *   • Newest-intent-wins active-turn registry (one in-flight turn / conv)
 *   • Frame versioning — redirects invalidate stale workers; follow-ups inherit
 *   • Primary-command protection window (~120 ms) before hard abort
 *   • Interrupt priority 0 (stop/cancel bypass everything)
 *   • Surface resolution + lock (chat / screen / board)
 *   • Pre-LLM dispatch gate (mustDispatch tools run before any prose)
 *   • Auto-fork scoring (complexity 0–3) with a merge-gate budget
 *   • Empty-response guard (a turn must never say nothing)
 *   • Per-turn conversational-state inference (warmth / pace / length arc)
 *
 * LLM and tool execution are injected as callbacks so this runs standalone.
 * Dependencies: Node.js built-ins only.
 */

// ── Tunables ─────────────────────────────────────────────────────────────────

const EXPLICIT_CMD_PROTECT_MS = 120;    // defer aborting a just-issued command
const MERGE_GATE_MS           = 1500;   // workers finishing within this fold inline
const INTERRUPT_PRIORITY      = 0;

// ── Intent + surface ─────────────────────────────────────────────────────────

export type Surface = "chat" | "screen" | "board";

export type IntentKind =
  | "interrupt" | "conversation" | "command" | "visual" | "complex_query";

export interface ClassifiedIntent {
  kind:         IntentKind;
  surface:      Surface;
  mustDispatch: boolean;     // tool must run before any prose streams
  forcedTool?:  string;
  priority:     number;
  isPrimaryCommand: boolean;
}

// ── Active-turn registry ─────────────────────────────────────────────────────

export type TurnState =
  | "listening"
  | `executing:${string}`
  | `completed:${string}`
  | `awaiting_approval:${string}`;

interface ActiveTurn {
  seq:              number;
  frameVersion:     number;
  controller:       AbortController;
  intent:           ClassifiedIntent;
  state:            TurnState;
  isPrimaryCommand: boolean;
  flushed:          boolean;   // has a visible UI event escaped yet?
  startedAt:        number;
}

// ── Conversation arc (per-turn state) ────────────────────────────────────────

export interface ConversationArc {
  warmth:        number;   // 0..1
  terseness:     number;   // 0..1 (1 = very terse)
  paceMode:      "calm" | "normal" | "rapid";
  dominantEmotion: string;
  avgResponseLen: number;
  turnCount:     number;
}

function freshArc(): ConversationArc {
  return { warmth: 0.5, terseness: 0.5, paceMode: "normal", dominantEmotion: "neutral", avgResponseLen: 0, turnCount: 0 };
}

// ── Callbacks the host wires in ──────────────────────────────────────────────

export interface KernelHooks {
  runToolPlan?:  (intent: ClassifiedIntent, signal: AbortSignal) => Promise<string>;
  streamProse?:  (intent: ClassifiedIntent, arc: ConversationArc, signal: AbortSignal) => Promise<string>;
  spawnWorkers?: (roles: string[], frameVersion: number) => void;
  cancelWorkersByFrame?: (convId: string, frameVersion: number) => void;
  synthesizeFallback?: (intent: ClassifiedIntent, signal: AbortSignal) => Promise<string>;
  emit?:         (convId: string, event: { content?: string; meta?: unknown }) => void;
}

export interface TurnResult {
  seq:        number;
  frameVersion: number;
  surface:    Surface;
  state:      TurnState;
  response:   string;
  aborted:    boolean;
  forkedRoles: string[];
}

// ── Silent internal tools — empty-response guard stays quiet for these ───────

const SILENT_TOOLS = new Set([
  "remember", "record_correction", "grow_personality", "stop_audio", "set_name",
]);

// ── The kernel ────────────────────────────────────────────────────────────────

export class ConversationStateKernel {
  private active = new Map<string, ActiveTurn>();
  private arcs   = new Map<string, ConversationArc>();
  private hooks: KernelHooks;

  constructor(hooks: KernelHooks = {}) { this.hooks = hooks; }

  // ── Intent classification (heuristic, deterministic) ────────────────────────

  classifyIntent(message: string): ClassifiedIntent {
    const m = message.toLowerCase().trim();

    if (/^(stop|cancel|never ?mind|wait|hold on|forget it|abort)\b/.test(m)) {
      return { kind: "interrupt", surface: "chat", mustDispatch: false, priority: INTERRUPT_PRIORITY, isPrimaryCommand: false };
    }

    const surface: Surface =
      /\b(on (the )?screen|full ?screen|show me|display|pull up)\b/.test(m) ? "screen" :
      /\b(pin|board|add to (the )?board|dashboard)\b/.test(m)              ? "board"  : "chat";

    const isVisual  = surface === "screen" || /\b(chart|graph|map|video|image|photo)\b/.test(m);
    const isCommand = /^(show|open|play|send|create|set|make|buy|sell|swap|navigate|go to|delete|remove|pay)\b/.test(m);

    const complexity = this.scoreComplexity(m);
    const kind: IntentKind =
      isVisual  ? "visual" :
      complexity >= 2 ? "complex_query" :
      isCommand ? "command" : "conversation";

    return {
      kind,
      surface,
      mustDispatch: isVisual || isCommand,           // run the tool before talking
      forcedTool:   surface === "screen" ? "render_screen" : undefined,
      priority:     kind === "command" || isVisual ? 1 : 5,
      isPrimaryCommand: isCommand || isVisual,
    };
  }

  /** Complexity 0–3 from how many analytic signal domains the turn touches. */
  scoreComplexity(m: string): number {
    let score = 0;
    if (/\b(bug|crash|error|broken|regression|failing)\b/.test(m)) score++;
    if (/\b(slow|latency|performance|optimi[sz]e|memory leak)\b/.test(m)) score++;
    if (/\b(architecture|design|trade.?off|should (i|we)|decision)\b/.test(m)) score++;
    if (/\b(policy|security|audit|review|compliance)\b/.test(m)) score++;
    return Math.min(score, 3);
  }

  private forkRolesFor(intent: ClassifiedIntent, message: string): string[] {
    const roles: string[] = [];
    const m = message.toLowerCase();
    if (/\b(bug|crash|error|regression)\b/.test(m)) roles.push("regression_analyst");
    if (/\b(architecture|design|should (i|we)|trade.?off)\b/.test(m)) roles.push("dissent_reviewer");
    if (/\b(audit|review|compliance|cross.?check)\b/.test(m)) roles.push("synthesis_planner");
    return roles;
  }

  /** Gate: may prose stream before the mandatory tool plan has run? */
  canStreamSpeechEarly(intent: ClassifiedIntent): boolean {
    return !intent.mustDispatch;
  }

  // ── Redirect / interrupt detection ──────────────────────────────────────────

  private isRedirect(message: string): boolean {
    return /\b(actually|instead|no,? (do|show|make)|forget that|scratch that|different|change of plans)\b/i
      .test(message);
  }

  // ── The main turn handler ───────────────────────────────────────────────────

  async handleTurn(convId: string, message: string): Promise<TurnResult> {
    const prev      = this.active.get(convId);
    const turnSeq   = (prev?.seq ?? 0) + 1;
    const redirected = this.isRedirect(message);
    const frameVer  = redirected ? (prev?.frameVersion ?? 0) + 1 : (prev?.frameVersion ?? 0);
    const intent    = this.classifyIntent(message);

    // Supersede the previous in-flight turn.
    if (prev) {
      const isInterrupt = intent.kind === "interrupt";
      if (!redirected && !isInterrupt && prev.isPrimaryCommand && !prev.flushed) {
        // Defer the abort so the just-issued command can flush its first UI event.
        const toAbort = prev.controller;
        setTimeout(() => { if (!toAbort.signal.aborted) toAbort.abort(); }, EXPLICIT_CMD_PROTECT_MS);
      } else {
        prev.controller.abort();
      }
    }

    const controller = new AbortController();
    const turn: ActiveTurn = {
      seq: turnSeq, frameVersion: frameVer, controller, intent,
      state: "listening", isPrimaryCommand: intent.isPrimaryCommand,
      flushed: false, startedAt: Date.now(),
    };
    this.active.set(convId, turn);

    // A redirect invalidates workers spawned under the old frame.
    if (redirected) this.hooks.cancelWorkersByFrame?.(convId, frameVer);

    // Interrupts win immediately (priority 0).
    if (intent.kind === "interrupt") {
      this.hooks.emit?.(convId, { content: "Stopped." });
      this.finish(convId, turnSeq);
      return { seq: turnSeq, frameVersion: frameVer, surface: intent.surface, state: "completed:interrupt", response: "Stopped.", aborted: false, forkedRoles: [] };
    }

    const arc = this.arcs.get(convId) ?? freshArc();
    const signal = controller.signal;

    // Auto-fork gating: never fork burst/forced-tool/interrupt turns.
    let forkedRoles: string[] = [];
    if (intent.kind === "complex_query" && !intent.mustDispatch) {
      forkedRoles = this.forkRolesFor(intent, message);
      if (forkedRoles.length) this.hooks.spawnWorkers?.(forkedRoles, frameVer);
    }

    let response = "";
    try {
      // Pre-LLM dispatch gate.
      if (!this.canStreamSpeechEarly(intent)) {
        turn.state = `executing:${intent.forcedTool ?? "tool"}`;
        const toolText = (await this.hooks.runToolPlan?.(intent, signal)) ?? "";
        turn.flushed = true;
        if (signal.aborted) return this.abortedResult(turnSeq, frameVer, intent);
        response = toolText;
      }

      // Stream prose (conversation, or narration after the tool ran).
      if (this.canStreamSpeechEarly(intent) || response === "") {
        const prose = (await this.hooks.streamProse?.(intent, arc, signal)) ?? "";
        if (signal.aborted) return this.abortedResult(turnSeq, frameVer, intent);
        if (prose) { response = response ? `${response}\n\n${prose}` : prose; turn.flushed = true; }
      }
    } catch (e) {
      if (signal.aborted) return this.abortedResult(turnSeq, frameVer, intent);
      throw e;
    }

    // ── Empty-response guard ──────────────────────────────────────────────────
    response = await this.applyEmptyResponseGuard(convId, intent, response, signal);

    // Update the per-turn conversational arc.
    this.arcs.set(convId, this.inferArcUpdate(arc, message, response));

    turn.state = `completed:${intent.forcedTool ?? intent.kind}`;
    this.hooks.emit?.(convId, { content: response });
    this.finish(convId, turnSeq);

    return { seq: turnSeq, frameVersion: frameVer, surface: intent.surface, state: turn.state, response, aborted: false, forkedRoles };
  }

  /** A turn must never end having said nothing. */
  private async applyEmptyResponseGuard(
    convId: string, intent: ClassifiedIntent, response: string, signal: AbortSignal,
  ): Promise<string> {
    if (response.trim()) return response;

    // Genuinely silent internal tool → stay quiet (do not leak tool names).
    if (intent.forcedTool && SILENT_TOOLS.has(intent.forcedTool)) return "";

    // Second synthesis turn (tool_choice:"none") so the user gets a real answer.
    const synthesized = (await this.hooks.synthesizeFallback?.(intent, signal)) ?? "";
    if (synthesized.trim()) return synthesized;

    // Last-resort confirmation fallback.
    return "Done.";
  }

  // ── Conversational arc inference (heuristic, no LLM) ────────────────────────

  private inferArcUpdate(arc: ConversationArc, message: string, response: string): ConversationArc {
    const m = message.toLowerCase();
    const next = { ...arc, turnCount: arc.turnCount + 1 };

    if (/\b(thanks|thank you|love|great|awesome|please)\b/.test(m)) next.warmth = Math.min(1, arc.warmth + 0.05);
    if (/\b(stop|hurry|just|quick|fast|now)\b/.test(m))             next.terseness = Math.min(1, arc.terseness + 0.1);
    if (message.length < 20)                                        next.terseness = Math.min(1, arc.terseness + 0.05);

    const burst = message.length < 25 && /[?!]$/.test(message.trim());
    next.paceMode = burst ? "rapid" : message.length > 200 ? "calm" : "normal";

    next.avgResponseLen = arc.turnCount === 0
      ? response.length
      : Math.round(arc.avgResponseLen * 0.7 + response.length * 0.3);

    next.dominantEmotion =
      next.warmth > 0.7 ? "warm" : next.terseness > 0.7 ? "focused" : "neutral";
    return next;
  }

  /**
   * Post-draft voice guard: cheap critic that trims an over-long reply against
   * the arc's terseness target before it ships.  Returns the (possibly) edited
   * text; a host can swap this for an LLM critic.
   */
  guardVoice(convId: string, draft: string): string {
    const arc = this.arcs.get(convId) ?? freshArc();
    if (arc.terseness > 0.7 && draft.length > 400) {
      const firstPara = draft.split(/\n\n/)[0] ?? draft;
      return firstPara.length < draft.length ? firstPara : draft.slice(0, 400);
    }
    return draft;
  }

  // ── Registry bookkeeping ────────────────────────────────────────────────────

  private finish(convId: string, seq: number): void {
    const cur = this.active.get(convId);
    if (cur && cur.seq === seq) this.active.delete(convId);
  }

  private abortedResult(seq: number, frameVer: number, intent: ClassifiedIntent): TurnResult {
    return { seq, frameVersion: frameVer, surface: intent.surface, state: "completed:aborted", response: "", aborted: true, forkedRoles: [] };
  }

  getArc(convId: string): ConversationArc { return this.arcs.get(convId) ?? freshArc(); }
  getActiveState(convId: string): TurnState | null { return this.active.get(convId)?.state ?? null; }
}

// ── Example usage ──────────────────────────────────────────────────────────────

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];

if (argv[2] === "--demo") {
  const sleep = (ms: number): Promise<void> => new Promise<void>(res => setTimeout(res, ms));
  (async () => {
    const log: string[] = [];
    const kernel = new ConversationStateKernel({
      runToolPlan: async (intent) => { await sleep(30); return `[rendered ${intent.forcedTool ?? "tool"} on ${intent.surface}]`; },
      streamProse: async () => { await sleep(20); return "Here's what I found."; },
      spawnWorkers: (roles, fv) => log.push(`fork frame=${fv}: ${roles.join(", ")}`),
      cancelWorkersByFrame: (_c, fv) => log.push(`cancel workers frame=${fv}`),
      synthesizeFallback: async () => "Let me explain.",
      emit: (_c, e) => { if (e.content) log.push(`emit: ${e.content}`); },
    });

    const conv = "conv-1";

    const r1 = await kernel.handleTurn(conv, "show me the ETH chart");
    console.log("turn1:", r1.state, "surface=" + r1.surface, "seq=" + r1.seq);

    const r2 = await kernel.handleTurn(conv, "actually, the weather instead");
    console.log("turn2:", r2.state, "frameVersion=" + r2.frameVersion);

    const r3 = await kernel.handleTurn(conv, "stop");
    console.log("turn3:", r3.state, "(interrupt, priority 0)");

    const r4 = await kernel.handleTurn(conv, "there's a bug causing slow performance, should we change the architecture?");
    console.log("turn4:", r4.state, "forked=[" + r4.forkedRoles.join(", ") + "]");

    console.log("\narc:", kernel.getArc(conv));
    console.log("\nlog:\n" + log.map(l => "  " + l).join("\n"));
  })();
}
