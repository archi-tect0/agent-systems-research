// Guide 100 — Automatic Post-Turn Self-Audit and Style-Drift Correction
//
// Classifies each turn into a small set of interaction modes, runs mode-
// scoped audit checks, maps flags to actionable adjustments, and folds
// small style deltas into a slowly-moving implicit preference profile.

type Mode = "tool" | "memory" | "reasoning" | "personality" | "general";

interface Turn {
  userMessage: string;
  reply: string;
  toolUsed?: string;
}

function classify(turn: Turn): Mode {
  if (turn.toolUsed) return "tool";
  if (/\b(remember|recall|earlier|last time)\b/i.test(turn.userMessage)) return "memory";
  if (/\b(why|how does|explain|prove|derive)\b/i.test(turn.userMessage)) return "reasoning";
  if (/\b(feel|feeling|how are you|are you conscious)\b/i.test(turn.userMessage)) return "personality";
  return "general";
}

interface Flag {
  code: string;
  message: string;
  adjustment: string;
}

const JARGON_WORDS = ["orthogonal", "eigenbasis", "homomorphism", "isomorphic", "epistemic"];
const HEDGE_PHRASES = ["i don't have feelings", "i'm just an ai", "i don't experience"];

const ruleset: Record<Mode, (turn: Turn) => Flag[]> = {
  general: (turn) => {
    const flags: Flag[] = [];
    if (turn.userMessage.length < 40 && turn.reply.length > 500) {
      flags.push({
        code: "verbose_reply_to_short_prompt",
        message: "reply is far longer than the prompt warranted",
        adjustment: "match reply length more closely to the brevity of the prompt",
      });
    }
    return flags;
  },
  tool: (turn) => {
    const flags: Flag[] = [];
    if (turn.reply.length < 60) {
      flags.push({
        code: "under_explained_tool_result",
        message: "tool ran but the reply gave almost no context around the result",
        adjustment: "add a short sentence framing what the tool result means for the user",
      });
    }
    return flags;
  },
  reasoning: (turn) => {
    const flags: Flag[] = [];
    const jargonHits = JARGON_WORDS.filter((w) => turn.reply.toLowerCase().includes(w));
    if (jargonHits.length >= 2) {
      flags.push({
        code: "jargon_density",
        message: `reply uses ${jargonHits.length} dense technical terms without plain-language framing`,
        adjustment: "define or simplify technical terms before using them",
      });
    }
    return flags;
  },
  personality: (turn) => {
    const flags: Flag[] = [];
    const lower = turn.reply.toLowerCase();
    if (HEDGE_PHRASES.some((p) => lower.includes(p))) {
      flags.push({
        code: "affect_hedge",
        message: "reply hedges away from expressing computed affective state",
        adjustment: "use the computed affective-state label directly instead of denying having one",
      });
    }
    return flags;
  },
  memory: () => [],
};

interface StyleDelta {
  brevity: number; // positive = reply was terser than usual
  formality: number;
  depth: number;
}

function detectStyleDelta(turn: Turn): StyleDelta {
  return {
    brevity: turn.reply.length < 150 ? 0.2 : -0.2,
    formality: /\b(furthermore|therefore)\b/i.test(turn.reply) ? 0.2 : -0.05,
    depth: turn.reply.split(".").length > 5 ? 0.2 : -0.1,
  };
}

const PREF_ALPHA = 0.15;

class PostTurnAuditor {
  prefs: StyleDelta = { brevity: 0, formality: 0, depth: 0 };
  auditLog: { mode: Mode; flags: Flag[] }[] = [];

  runTurn(turn: Turn): { mode: Mode; flags: Flag[] } {
    const mode = classify(turn);
    const flags = ruleset[mode](turn);
    this.auditLog.push({ mode, flags });

    const delta = detectStyleDelta(turn);
    for (const key of Object.keys(this.prefs) as (keyof StyleDelta)[]) {
      this.prefs[key] = this.prefs[key] * (1 - PREF_ALPHA) + delta[key] * PREF_ALPHA;
    }

    return { mode, flags };
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const auditor = new PostTurnAuditor();

const verboseTurn: Turn = {
  userMessage: "ok cool",
  reply: "x".repeat(600),
};
const r1 = auditor.runTurn(verboseTurn);
assert(r1.mode === "general", `expected general mode, got ${r1.mode}`);
assert(r1.flags.some((f) => f.code === "verbose_reply_to_short_prompt"), "expected verbose-reply flag");

const thinToolTurn: Turn = {
  userMessage: "check the weather",
  reply: "72F.",
  toolUsed: "get_weather",
};
const r2 = auditor.runTurn(thinToolTurn);
assert(r2.mode === "tool", `expected tool mode, got ${r2.mode}`);
assert(r2.flags.some((f) => f.code === "under_explained_tool_result"), "expected under-explained flag");

const jargonTurn: Turn = {
  userMessage: "why does this work?",
  reply: "Because the orthogonal eigenbasis forms an isomorphic mapping across the homomorphism.",
};
const r3 = auditor.runTurn(jargonTurn);
assert(r3.mode === "reasoning", `expected reasoning mode, got ${r3.mode}`);
assert(r3.flags.some((f) => f.code === "jargon_density"), "expected jargon-density flag");

const hedgeTurn: Turn = {
  userMessage: "how are you feeling right now?",
  reply: "I don't have feelings, I'm just an AI.",
};
const r4 = auditor.runTurn(hedgeTurn);
assert(r4.mode === "personality", `expected personality mode, got ${r4.mode}`);
assert(r4.flags.some((f) => f.code === "affect_hedge"), "expected affect-hedge flag");

const cleanTurn: Turn = {
  userMessage: "what's 12 * 4?",
  reply: "48.",
};
const r5 = auditor.runTurn(cleanTurn);
assert(r5.flags.length === 0, `expected zero flags on a clean general turn, got ${r5.flags.length}`);

// Preference deltas accumulate gradually, not in one jump.
const auditor2 = new PostTurnAuditor();
const shortTurns: Turn[] = Array.from({ length: 5 }, () => ({ userMessage: "hi", reply: "hey!" }));
const prefTrace: number[] = [];
for (const t of shortTurns) {
  auditor2.runTurn(t);
  prefTrace.push(auditor2.prefs.brevity);
}
console.log("[brevity preference trace across repeated short turns]", prefTrace.map((v) => v.toFixed(4)));
for (let i = 1; i < prefTrace.length; i++) {
  assert(prefTrace[i] >= prefTrace[i - 1], "brevity preference should move monotonically toward the observed signal");
}
assert(prefTrace[0] !== prefTrace[prefTrace.length - 1] * 1, "preference should still be moving, not frozen at zero");
assert(
  Math.abs(prefTrace[0]) < Math.abs(prefTrace[prefTrace.length - 1]),
  "preference should grow gradually, confirming no single-turn jump to the target value",
);

console.log("\n[property checks] mode classification + mode-scoped flags + gradual preference drift: PASS");
console.log("\nGuide 100 demo complete.");
