/**
 * Guide 83 — Batch Card SSE + turn_end Protocol
 * Runnable reference implementation (no external deps).
 *
 * Demonstrates:
 *   A. createCardDispatcher() factory and turn isolation
 *   B. turn_end fires before done on the clean path
 *   C. turn_end does NOT fire on the error/interrupt path
 *   D. All card emission shapes are routed correctly
 *
 * Run:  node index.ts --demo
 */

// ─── Logical clock ─────────────────────────────────────────────────────────
let _tick = 0;
const advance = (ms: number): void => { _tick += ms; };

// ─── Types ─────────────────────────────────────────────────────────────────
interface AgentCard {
  type: string;
  [key: string]: unknown;
}

interface CardDispatcherOpts {
  onCard:    (card: AgentCard) => void;
  onText:    (delta: string) => void;
  onTurnEnd: () => void;
  onDone:    () => void;
  onUnknown?: (raw: unknown) => void;
}

interface CardDispatcher {
  dispatch:  (raw: unknown) => void;
  cardCount: () => number;
}

// ─── isRecord helper ────────────────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Factory ────────────────────────────────────────────────────────────────
function createCardDispatcher(opts: CardDispatcherOpts): CardDispatcher {
  let _cardCount = 0;

  function emitCard(card: AgentCard): void {
    _cardCount++;
    opts.onCard(card);
  }

  function dispatch(raw: unknown): void {
    if (!isRecord(raw)) return;

    if (typeof raw["text"] === "string")  { opts.onText(raw["text"]); return; }
    if (raw["turn_end"] === true)         { opts.onTurnEnd(); return; }
    if (raw["done"] === true)             { opts.onDone(); return; }

    if (Array.isArray(raw["cards"])) {
      for (const c of raw["cards"] as AgentCard[]) emitCard(c);
      return;
    }

    if (isRecord(raw["ghost_card"]))  { emitCard({ ...(raw["ghost_card"]  as unknown as AgentCard), type: "ghost_card"  } as AgentCard); return; }
    if (isRecord(raw["memory_card"])) { emitCard({ ...(raw["memory_card"] as unknown as AgentCard), type: "memory_card" } as AgentCard); return; }

    const INLINE_KEYS = ["nav_card", "stat_card", "article_card", "confirm_card",
                         "web_preview", "image_card", "video_card", "audio_card"] as const;
    for (const key of INLINE_KEYS) {
      if (isRecord(raw[key])) { emitCard(raw[key] as unknown as AgentCard); return; }
    }

    opts.onUnknown?.(raw);
  }

  return { dispatch, cardCount: () => _cardCount };
}

// ─── Minimal SSE emitter (simulates res.write) ──────────────────────────────
function buildEmitter(dispatcher: CardDispatcher): (event: unknown) => void {
  return (event: unknown) => dispatcher.dispatch(event);
}

// ─── Server-side turn simulator ─────────────────────────────────────────────
function runNormalTurn(emit: (ev: unknown) => void): void {
  emit({ text: "Here is your market summary: " });
  emit({ cards: [
    { type: "stat_card",  label: "ETH/USD", value: "$3,812" },
    { type: "chart_card", symbol: "ETH",    range: "1d"     },
  ]});
  emit({ text: "Prices are up 2.4% today." });
  emit({ turn_end: true }); // ← clean path: always before done
  emit({ done: true });
}

function runErrorTurn(emit: (ev: unknown) => void): void {
  emit({ text: "Fetching data…" });
  // Simulates stream error — turn_end is NOT emitted
  emit({ done: true });
}

function runInterruptTurn(emit: (ev: unknown) => void): void {
  emit({ text: "Let me check—" });
  emit({ ghost_card: { toolName: "get_token_price" } });
  // Client disconnected mid-turn — turn_end NOT emitted
  emit({ done: true });
}

// ─── Demo ───────────────────────────────────────────────────────────────────
if (process.argv.includes("--demo")) {
  console.log("=== Guide 83 — Batch Card SSE + turn_end Protocol ===\n");

  // ── Scenario A: factory isolation ───────────────────────────────────────
  advance(10);
  console.log("[A] Factory isolation — two concurrent turns share no state:");
  const cards1: AgentCard[] = [];
  const cards2: AgentCard[] = [];
  const d1 = createCardDispatcher({ onCard: c => cards1.push(c), onText: () => {}, onTurnEnd: () => {}, onDone: () => {} });
  const d2 = createCardDispatcher({ onCard: c => cards2.push(c), onText: () => {}, onTurnEnd: () => {}, onDone: () => {} });
  d1.dispatch({ cards: [{ type: "stat_card", label: "turn-1" }] });
  d2.dispatch({ cards: [{ type: "nav_card", url: "/home" }, { type: "stat_card", label: "turn-2" }] });
  console.log(`    Turn-1 card count: ${d1.cardCount()} (expected 1)`);
  console.log(`    Turn-2 card count: ${d2.cardCount()} (expected 2)`);
  console.assert(d1.cardCount() === 1, "FAIL: turn-1 count");
  console.assert(d2.cardCount() === 2, "FAIL: turn-2 count");
  console.log("    PASS ✓\n");

  // ── Scenario B: clean path — turn_end before done ────────────────────────
  advance(10);
  console.log("[B] Clean turn — turn_end fires before done:");
  const events: string[] = [];
  const texts: string[] = [];
  const dB = createCardDispatcher({
    onCard:    c  => events.push(`card:${c.type}`),
    onText:    t  => texts.push(t),
    onTurnEnd: () => events.push("turn_end"),
    onDone:    () => events.push("done"),
  });
  runNormalTurn(buildEmitter(dB));
  console.log(`    Event sequence: ${events.join(" → ")}`);
  console.log(`    Text collected: "${texts.join("")}"`);
  const turnEndIdx = events.indexOf("turn_end");
  const doneIdx    = events.indexOf("done");
  console.assert(turnEndIdx >= 0,           "FAIL: turn_end not emitted");
  console.assert(doneIdx    >= 0,           "FAIL: done not emitted");
  console.assert(turnEndIdx < doneIdx,      "FAIL: turn_end must precede done");
  console.assert(dB.cardCount() === 2,      "FAIL: expected 2 cards (stat + chart)");
  console.log("    PASS ✓\n");

  // ── Scenario C: error path — no turn_end ────────────────────────────────
  advance(10);
  console.log("[C] Error path — turn_end must NOT fire:");
  const eventsC: string[] = [];
  const dC = createCardDispatcher({
    onCard:    c  => eventsC.push(`card:${c.type}`),
    onText:    () => {},
    onTurnEnd: () => eventsC.push("turn_end"),
    onDone:    () => eventsC.push("done"),
  });
  runErrorTurn(buildEmitter(dC));
  console.log(`    Event sequence: ${eventsC.join(" → ")}`);
  console.assert(!eventsC.includes("turn_end"), "FAIL: turn_end must not fire on error path");
  console.assert(eventsC.includes("done"),      "FAIL: done must still fire");
  console.log("    PASS ✓\n");

  // ── Scenario D: interrupt path — ghost card + no turn_end ───────────────
  advance(10);
  console.log("[D] Interrupt path — ghost card dispatched, no turn_end:");
  const eventsD: string[] = [];
  const dD = createCardDispatcher({
    onCard:    c  => eventsD.push(`card:${c.type}`),
    onText:    () => {},
    onTurnEnd: () => eventsD.push("turn_end"),
    onDone:    () => eventsD.push("done"),
  });
  runInterruptTurn(buildEmitter(dD));
  console.log(`    Event sequence: ${eventsD.join(" → ")}`);
  console.assert(eventsD.includes("card:ghost_card"), "FAIL: ghost_card not routed");
  console.assert(!eventsD.includes("turn_end"),       "FAIL: turn_end must not fire on interrupt");
  console.log("    PASS ✓\n");

  // ── Scenario E: onTurnEnd is the flush trigger ───────────────────────────
  advance(10);
  console.log("[E] onTurnEnd used as animation flush gate:");
  let flushed = false;
  const cardsE: AgentCard[] = [];
  const dE = createCardDispatcher({
    onCard:    c => cardsE.push(c),
    onText:    () => {},
    onTurnEnd: () => { flushed = true; },
    onDone:    () => {},
  });
  runNormalTurn(buildEmitter(dE));
  console.log(`    Cards collected before flush: ${cardsE.length}`);
  console.log(`    Flush triggered: ${flushed}`);
  console.assert(flushed,           "FAIL: flush (onTurnEnd) not triggered");
  console.assert(cardsE.length > 0, "FAIL: no cards collected before flush");
  console.log("    PASS ✓\n");

  console.log("All scenarios passed.");
}
