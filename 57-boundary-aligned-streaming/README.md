# Boundary-Aligned Streaming Pulse Encoder

## Problem

Language models emit tokens one at a time, and the naive thing to do is forward each token to the client the instant it arrives. That produces visible flicker. Words appear mid-formation — "Open" then "ing" then " the" — so the reader watches text assemble character group by character group. Markdown and code fragments render half-parsed, because a client that re-renders on every token sees `` ```py `` before the fence is closed. And a text-to-speech layer fed token-by-token stutters on partial words, because it has no way to know where one speakable unit ends and the next begins.

The fix is to stop forwarding raw tokens and instead deliver *complete linguistic or code units*. The encoder should accumulate tokens and only flush a frame when the buffer ends on a meaningful boundary — the end of a sentence, the end of a clause — so each frame the client receives is something it can render or speak cleanly.

But boundary-only flushing has a failure mode: a long, unpunctuated span (a URL, a code identifier, a rambling sentence) would never hit a boundary and the stream would appear to stall. So the encoder needs escape hatches: a token-count cap that forces a flush when too much has piled up, and a time cap that forces a flush when nothing has flushed within a short window (~120 ms), so the stream always feels live even mid-sentence. And at stream end, whatever remains must be flushed regardless of boundary.

The result is a small state machine over the token stream that trades a few milliseconds of buffering for frames that are always coherent units.

## Design decisions

**Why flush on a hard boundary (sentence end) immediately?**
A sentence terminator — `". "`, `"? "`, `"! "`, `".\n"`, `"..."` — is the strongest signal that a complete, renderable, speakable unit has formed. The moment the buffer tail matches one, it flushes as `"sentence"`. No reason to wait: the unit is done.

**Why gate soft (clause) boundaries behind a minimum token count?**
A comma or semicolon marks a clause break, but flushing on *every* comma would fragment short phrases into tiny frames and defeat the purpose. The soft boundary only fires once at least `clauseMinTokens` have accumulated, so it splits genuinely long sentences at natural pause points while leaving short ones intact. It flushes as `"clause"`.

**Why both a token cap and a time cap?**
They guard different stalls. The token cap (`maxTokens`) handles a buffer that grows large with no punctuation — it flushes as `"timecap"` to bound frame size. The time cap (`maxMs`) handles a buffer that is small but has sat too long because tokens are arriving slowly — a timer armed on each push flushes whatever is buffered if no boundary fires in time. Together they ensure neither size nor latency runs away.

**Why tag every pulse with its boundary type and a sequence number?**
The boundary type tells the client *why* the frame arrived — a `"sentence"` frame is a safe place to re-render markdown or hand a chunk to TTS, whereas a `"timecap"` frame is a non-semantic cut that may split a word. The monotonic `seq` lets the client order and de-duplicate frames. The remaining-buffer flush at `close()` is tagged `"eos"` so the client knows the stream is complete.

**Why detect boundaries against only the tail of the buffer?**
Boundary regexes run on the last 8 characters, not the whole buffer. Boundary markers are always at the end of what was just appended, so scanning a fixed-size tail keeps detection cheap and allocation-light no matter how large the accumulated text grows.

**Why expose both an event and a direct callback?**
The encoder extends `EventEmitter` so consumers can subscribe to `"pulse"` and `"close"` events, and it also accepts an `onPulse` callback for callers that prefer a direct hook without event wiring. Both fire on every flush.

## Algorithm

```
class PulseEncoder(maxTokens=60, maxMs=120, clauseMinTokens=20, onPulse?):

  push(token):
    if closed or empty token: return
    buffer += token; tokenCount += 1
    armTimer()                              // (re)start the maxMs timer

    tail = buffer.slice(-8)
    if HARD_BOUNDARY_RE matches tail:       // ... or [.!?](space|EOL) or .\n
      flush("sentence"); return
    if SOFT_BOUNDARY_RE matches tail        // , or ;
       and tokenCount >= clauseMinTokens:
      flush("clause"); return
    if tokenCount >= maxTokens:
      flush("timecap")                      // size cap

  armTimer():
    clearTimer()
    timer = setTimeout(maxMs):
      if buffer not empty: flush("timecap") // latency cap

  close():
    if closed: return
    clearTimer()
    if buffer not empty: flush("eos")       // flush remainder
    closed = true; emit("close")

  flush(boundary):
    clearTimer()
    if buffer empty: return
    pulse = { seq: seq++, boundary, text: buffer, tokenCount }
    buffer = ""; tokenCount = 0
    onPulse?(pulse); emit("pulse", pulse)
```

Boundary types: `"sentence"` (hard), `"clause"` (soft), `"timecap"` (size or latency cap), `"eos"` (stream end).

## Reference implementation

See [`boundary-aligned-streaming.ts`](./boundary-aligned-streaming.ts) in this directory.

It runs on Node.js built-ins only (`events` for `EventEmitter`, plus the standard timer functions). The production source (`sqPulseEncoder.ts`) layers the same boundary state machine underneath a binary wire format with dictionary-based compression; this reference keeps the boundary-alignment core and emits plain text frames so the mechanism is legible on its own.

## Usage

```typescript
import {
  PulseEncoder,
  type Pulse,
  type BoundaryType,
  type PulseEncoderOptions,
} from "./boundary-aligned-streaming.js";

const encoder = new PulseEncoder({
  maxTokens: 60,        // hard size cap
  maxMs: 120,           // latency cap in ms
  clauseMinTokens: 20,  // min tokens before a clause flush is allowed
  onPulse: (p: Pulse) => deliverFrame(p), // optional direct callback
});

// You can also subscribe via events:
encoder.on("pulse", (p: Pulse) => {
  // p.seq, p.boundary, p.text, p.tokenCount
  deliverToClient(p);
});
encoder.on("close", () => finishStream());

// Feed streamed model tokens as they arrive.
for await (const token of modelStream) {
  encoder.push(token);
}

// End the stream: flushes any remainder tagged "eos", then emits "close".
encoder.close();
```

## Limitations and extensions

- **English-style boundary heuristics.** The regexes assume `.!?,;` punctuation and ASCII-style sentence breaks. Languages with different terminators (e.g. CJK full stops) or no spaces between words need adjusted patterns.
- **Code and markdown are not parsed.** A `"sentence"` flush can still land inside an open code fence if the model happens to write a period there. For strict code-unit framing, add fence/bracket-balance tracking on top of the punctuation boundaries.
- **Fixed 8-char tail window.** Boundary detection only inspects the last 8 characters. A boundary marker longer than that window (unusual) would be missed; widen the slice if needed.
- **Timer granularity.** The latency cap depends on `setTimeout`, whose resolution and scheduling jitter set the real floor on `maxMs`. Sub-millisecond timing is not achievable here.
- **No back-pressure.** The encoder flushes as soon as a boundary fires; it does not coordinate with a slow consumer. A client that cannot keep up needs its own buffering or flow control downstream.
```
