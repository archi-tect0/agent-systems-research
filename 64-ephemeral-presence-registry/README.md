# Ephemeral Presence Registry with Privacy Blackout


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An assistant that runs across several of a person's devices benefits from knowing whether that person is *present* right now: are they actively interacting, did a phone just detect motion, is a microphone listening, or has everything gone quiet for ten minutes? This ambient awareness lets the assistant decide whether to interrupt, when to follow up, and how to phrase things ("you were here a minute ago" vs "welcome back").

But ambient presence is among the most sensitive data a system can hold. Two requirements pull against each other:

1. **Usefulness.** The assistant needs a short, current picture of presence injected into its working context.
2. **Privacy.** That picture must be *ephemeral* — never written to disk or a database where it accumulates into a surveillance log — and the user (or the assistant on the user's behalf) must be able to flip a hard kill switch that stops all tracking immediately.

This guide implements an in-memory ring buffer of ambient signals reduced to a one-line presence summary, plus a **two-layer privacy blackout**: a *soft* mode (self-regulation: outward sensors off, internal awareness retained) and a *hard* mode (all sensors dark, nothing tracked, and an overriding blackout directive injected into context in place of any presence info).

## Design decisions

**Why keep signals only in memory, never persisted?**
Presence is meaningful only in the moment. A signal that the user was active 30 seconds ago is useful now and worthless tomorrow — but a *persisted* trail of such signals is a detailed movement and attention log that becomes a liability the instant it exists. Storing presence in a process-local `Map` of bounded ring buffers means the data is fast to read, costs nothing to maintain, and evaporates on restart. There is no table to subpoena, leak, or accidentally export.

**Why a bounded ring buffer instead of keeping all signals?**
Only recent signals inform the summary; older ones are noise. A fixed cap (newest-first, truncated at a maximum length) gives O(1) memory per principal regardless of how chatty the devices are, and naturally ages out stale data. The summary only ever reads the head of the buffer plus a few derived timestamps (`lastActive`, `lastSignal`), so unbounded history would buy nothing.

**Why reduce raw signals to a single human-readable line?**
The consumer is a language model's context window, where tokens are scarce and structure is cheap to misread. A line like `active 2m ago · last signal: idle 30s ago · 2 devices` conveys everything the model needs in a form it can quote back naturally, without the model having to parse an array of signal objects. The registry does the reduction once; the model never sees raw signals.

**Why two layers of privacy instead of one on/off switch?**
The two layers encode two different intents. *Hard* mode is the user's explicit "stop watching me" — sensors go dark and **nothing is recorded at all**, so even the assistant's internal state holds no presence data. *Soft* mode is the assistant *self-regulating*: during a sensitive task it stops acting on outward sensors (no listening, no watching) but still maintains an internal presence summary so it doesn't lose situational continuity. Collapsing these into one switch would force a false choice between "fully tracked" and "fully blind".

**Why does hard mode inject an overriding directive instead of just returning an empty summary?**
Silence is ambiguous — an empty summary could mean "no signals yet" or "blackout". An *explicit* directive (`PRIVACY_BLACKOUT: all sensors dark … Do NOT listen, watch, or infer presence`) removes that ambiguity and actively instructs the model to refrain from sensing, rather than leaving it to infer the right behavior from missing data. Crucially, the directive carries no presence facts, so nothing leaks even while the model is being told to stand down.

**Why drop signals in hard mode at the recording boundary rather than filtering them at read time?**
Filtering at read time would still mean the sensitive data sat in memory. Dropping at `recordSignal` enforces the guarantee structurally: under a hard blackout, the signal never enters the buffer, so there is nothing to filter, expire, or accidentally surface. `recordSignal` returns `false` so callers can see the signal was rejected.

**Why an injectable clock?**
The summary is entirely about elapsed time ("2m ago"). An injectable `now()` makes the demo and tests deterministic without waiting in real time, and keeps the production default (`Date.now`) trivial.

## Algorithm

```
recordSignal(principal, signal):
  if privacy[principal].mode == HARD:
    return false                       // sensors dark — nothing stored
  buf = ring buffer for principal
  buf.unshift({ ...signal, ts: now() })
  if buf.length > MAX: truncate to MAX
  lastSignal = ts; lastKind = kind
  if kind in {active, focus, voice_start}: lastActive = ts
  if deviceId: devicesSeen.add(deviceId)
  return true

getPresenceSummary(principal):
  if no signals: return null
  parts = []
  if lastActive: parts += "active <ago>"
  if lastSignal differs from lastActive: parts += "last signal: <kind> <ago>"
  if devicesSeen > 1: parts += "<n> devices"
  return parts joined by " · "  (or null)

getContextLine(principal):                // what the agent actually injects
  if privacy[principal].mode == HARD:
    return "PRIVACY_BLACKOUT: all sensors dark … Do NOT listen/watch/infer."
  return getPresenceSummary(principal)    // SOFT and off both summarize

setPrivacyMode(principal, "hard"|"soft", { reason, activatedBy })
clearPrivacyMode(principal)               // tracking resumes on next signal
```

## Reference implementation

See [`ephemeral-presence-registry.ts`](./ephemeral-presence-registry.ts) in this directory. No external dependencies — pure built-ins.

## Usage

```typescript
import { PresenceRegistry, SIGNAL_KIND } from "./ephemeral-presence-registry.js";

const reg = new PresenceRegistry(); // defaults to Date.now()

// Devices push ambient signals (never persisted):
reg.recordSignal("user-1", { kind: SIGNAL_KIND.focus, deviceId: "phone" });
reg.recordSignal("user-1", { kind: SIGNAL_KIND.motion, deviceId: "phone", intensity: 0.4 });

// Inject one line into the agent's context:
const line = reg.getContextLine("user-1"); // "active 0s ago · 1 device" etc.

// User flips the hard kill switch:
reg.setPrivacyMode("user-1", "hard", { reason: "privacy button", activatedBy: "user" });
reg.recordSignal("user-1", { kind: SIGNAL_KIND.voice_start }); // returns false — dropped
reg.getContextLine("user-1"); // -> overriding PRIVACY_BLACKOUT directive

// Resume:
reg.clearPrivacyMode("user-1");

// Soft self-regulation: outward sensors off, presence still summarized:
reg.setPrivacyMode("user-1", "soft", { activatedBy: "agent" });
reg.getContextLine("user-1"); // still a presence summary
```

## Limitations and extensions

- **Per-process, single-node.** The registry lives in one process's memory. In a multi-instance deployment, signals recorded on one node are invisible to another. If you need cross-node presence, replace the `Map` with a short-TTL shared cache — but keep the TTL aggressive so the ephemeral property survives.
- **Hard mode trusts the recording path.** The guarantee "nothing is stored" holds because every writer goes through `recordSignal`. If signals can enter the buffer by another route, enforce the blackout check there too.
- **Summary heuristics are deliberately simple.** "Active if focus/active/voice_start" is a coarse rule. Richer presence (typing cadence, app context, location) would need a more nuanced reducer — but the reducer should stay the *only* place raw signals are interpreted.
- **No automatic blackout expiry.** A hard blackout persists until explicitly cleared. If you want auto-resume after a window, store an `expiresAt` and treat an expired hard state as `off` in `getContextLine`.
- **Soft mode is advisory.** It stops the registry from acting on outward sensors, but it cannot by itself power down a physical microphone or camera. Wire it to the actual device capture layer so "soft" has teeth at the hardware boundary.
