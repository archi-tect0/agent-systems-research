# Guide 83 — Batch Card SSE + `turn_end` Protocol


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A structured event protocol for streaming heterogeneous agent cards over SSE, with a reliable "all cards flushed" marker.*

---

## Problem

A Kylum agent turn produces heterogeneous output: text deltas, named tool result cards (`nav`, `stat`, `article`, `confirm`, …), ghost cards (pending tool selection), and lifecycle signals (`turn_end`, `done`). Without a shared protocol, SSE consumers must:

1. Write fragile ad-hoc `if ("cards" in ev) …` branches inline in the message handler.
2. Guess when a turn is fully complete — `done` signals stream close, but does it mean "all cards rendered" or "stream aborted"?
3. Duplicate this logic across every UI surface (AgentOrb, SDK clients, test harnesses).

The result is a class of subtle bugs where a card races ahead of its animation, a batch state update fires before all cards are in, or a test asserts card count before the turn has finished.

---

## The two-part solution

### Part 1 — `turn_end` event (server side)

The server emits one `{ turn_end: true }` event immediately before `{ done: true }` on the **clean completion path only**. Error paths, interrupt paths (`onClientClose`), and warmup turns do not emit `turn_end`.

This gives clients a binary distinction:
- `turn_end` received → the turn finished cleanly; all cards for this turn have been emitted.
- `done` without prior `turn_end` → the stream ended abnormally (client disconnect, error, interrupt).

```
normal path:  ... text/cards ... → turn_end → done → res.end()
error path:   ... text/cards ... →            done → res.end()
interrupt:    ... text/cards ... →            done → res.end()
```

### Part 2 — `createCardDispatcher()` factory (client side)

A per-turn factory that routes every SSE data payload to the correct typed handler:

```ts
const dispatcher = createCardDispatcher({
  onCard:    card   => renderCard(card),
  onText:    delta  => appendText(delta),
  onTurnEnd: ()     => flushPendingAnimations(),
  onDone:    ()     => markComplete(),
});

sseSource.onmessage = ev => dispatcher.dispatch(JSON.parse(ev.data));
```

The dispatcher normalises all card emission shapes:

| SSE shape | Normalised to |
|---|---|
| `{ cards: [...] }` | one `onCard` call per element |
| `{ ghost_card: {...} }` | `onCard` with `type: "ghost_card"` |
| `{ memory_card: {...} }` | `onCard` with `type: "memory_card"` |
| `{ nav_card: {...} }` | `onCard` with raw payload (already typed) |
| `{ text: "…" }` | `onText` |
| `{ turn_end: true }` | `onTurnEnd` |
| `{ done: true }` | `onDone` |

---

## Design decisions

### Factory, not singleton

One dispatcher instance is created **per turn**, not shared across turns. This keeps per-turn state (card count, flush flag) isolated — a slow turn can't corrupt the state of a subsequent fast one. Factories are cheap; correctness is not.

### Pure module — no React/DOM

The dispatcher imports nothing from React, the DOM, or any UI library. This means:
- It can be unit-tested in Node with a scripted tape (see `index.ts`).
- It can be reused by SDK clients, CLI tools, and test harnesses without a browser runtime.
- UI concerns (animation, state update) stay in the caller's `onCard`/`onTurnEnd` callbacks.

### `turn_end` on normal path only — not error/interrupt

If `turn_end` fired on every path, the client could not distinguish "clean finish" from "partial abort". The asymmetry is intentional: `turn_end` is a **positive signal** ("everything I promised to emit has been emitted"). Absence of `turn_end` before `done` is the implicit failure signal.

### `cards: [...]` as the primary emission pattern

Most tools emit multiple result cards atomically (e.g. a price query emits a `stat_card` and a `chart_card` together). Wrapping them in a single `cards` array makes the batch atomic from the client's perspective: either all cards arrive or none do. Individual inline shorthands (`ghost_card`, `memory_card`) exist for legacy single-card cases and are handled by the same dispatcher.

---

## Properties

| Property | Mechanism |
|---|---|
| Reliable flush signal | `turn_end` fires only on clean path, before `done` |
| Clean/aborted distinction | `done` without `turn_end` = abnormal end |
| Single routing surface | All SSE shapes handled in one `dispatch()` call |
| Isolated per-turn state | Factory pattern — no singleton global state |
| Testable without browser | Pure module, no DOM imports |
| Backward compatible | Old SSE shapes (inline shorthands) still handled |

---

## Limitations

The reference implementation uses a synchronous in-process event emitter as the SSE transport. The production system uses `res.write()` over an HTTP/1.1 chunked-encoding connection. The `turn_end` ordering guarantee ("fires before `done`") holds because both are sequential writes to the same response stream.

---

## Files

- `artifacts/api-server/src/routes/agent.ts` — server-side `emit({ turn_end: true })` before `emit({ done: true })`
- `artifacts/vanguard/src/lib/cardDispatcher.ts` — `createCardDispatcher()` factory implementation
- `artifacts/vanguard/src/components/AgentOrb.tsx` — primary consumer (inline frame switch wired through dispatcher per turn)
