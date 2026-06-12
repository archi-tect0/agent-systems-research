# Relational Intelligence Model

## Problem

A long-lived personal agent talks to the *same* person across hundreds of sessions. A stateless agent treats every turn as if it met the user for the first time: same verbosity, same tone, same proactivity, whether it is turn 1 or turn 1,000, whether the user is relaxed or visibly stressed. That feels robotic and, worse, mis-calibrated — it lectures a power user who wants one line, and it is curt with a new user who needs hand-holding.

What is missing is a *longitudinal* model of the relationship: a small, slowly-evolving profile that captures how this particular person communicates and how much rapport has accumulated, so the agent can dial its **response density**, **intervention posture**, and **tone** to fit.

The hard part is doing this *cheaply and stably*. You cannot run a sentiment classifier on every turn, and you cannot let one weird message ("STOP") rewrite the model. The signals must be derivable from message shape alone, and they must change slowly.

## Design decisions

**Two signal sources: passive and explicit.**
Passive signals are extracted automatically from every incoming message (length, proportion of short words, presence of shouting). Explicit signals come from an `observe_user` tool the agent can call when it has a clearer read ("user said they're shipping a release today"). Passive keeps the model always-fresh for free; explicit lets the agent record higher-confidence judgments.

**Everything continuous is an exponential moving average.**
Average message length and the stress signal are EMAs, not raw latest values. A single 200-character message barely moves a profile built from 80-character norms; a single "STOP" barely moves a low-stress baseline. The EMA *alpha* is the only knob: higher alpha = more reactive, lower = more stable. This is what makes the model robust to outliers — exactly the property a relationship model needs, because relationships are defined by patterns, not single moments.

**Stress is inferred from shape, not meaning.**
No classifier. The heuristic: a high proportion of very short words (terse, clipped) **or** any shouted ALL-CAPS token nudges the stress estimate up. It is deliberately crude — it is a *hint* fed into an EMA, not a verdict. Cheap, language-agnostic enough, zero dependencies, and good enough to bias tone toward calmer/shorter when the user seems agitated.

**Trust grows slowly and monotonically.**
Each interaction adds a tiny fixed increment (`+0.002`) to trust, capped at 1. Trust is *earned over many turns*, not granted by a single good exchange. This models rapport as something that accrues with sustained interaction. (A production variant can add gentle decay on long absence so a returning user picks up slightly below where they left off — relationships cool a little when neglected.)

**A discrete phase ladder on top of continuous trust.**
Continuous trust is hard to act on directly. The model buckets it into four phases — `new → familiar → trusted → deep` — at fixed thresholds. Discrete phases give the agent a clean switch for posture: a `new` user gets more scaffolding and explicit confirmations; a `deep` user gets terse, high-trust, proactive behavior. The ladder is the bridge between a smooth internal signal and a step-wise behavioral policy.

**Continuous signals bucketed to coarse labels at injection time.**
The model stores precise floats but injects coarse labels (`low`/`moderate`/`high`, `early`/`building`/`high`) into the prompt. The agent does not need three decimal places of "focus" — it needs "focus: high". Coarse labels are also far cheaper in tokens and less likely to make the model over-fit to spurious precision.

**Never block the turn.**
Updating the relational model is best-effort and runs alongside the main turn. If the store write fails, the turn proceeds — a relationship model is an enhancement, never a dependency on the critical path.

## Algorithm

```
updateFromMessage(user, text):           // passive, every turn
  avgLen  = EMA(prevAvgLen, len(text), MSG_LEN_EMA_ALPHA)
  short   = count(words where len<=3) / max(wordCount,1)
  caps    = text has any \b[A-Z]{3,}\b
  hint    = (short > 0.6 or caps) ? 0.6 : 0.3
  stress  = EMA(prevStress, hint, STRESS_EMA_ALPHA)
  trust   = min(prevTrust + 0.002, 1.0)
  phase   = ladder(trust)               // new<0.40<familiar<0.65<trusted<0.85<deep
  sessions += 1
  persist

observeUser(user, {mood,stress,energy,focus,style,note}):   // explicit
  clamp each provided signal into range; prepend note (keep last 20); persist

getRelationalContext(user):              // inject into system prompt
  return compact label-bucketed summary:
    "Phase:<p> Trust:<t> Stress:<s> Energy:<e> Focus:<f> Mood:<m>"
    "Style:<style> Sessions:<n>"
```

EMA: `next = prev*(1-alpha) + sample*alpha`.

## Reference implementation

See [`relational-model.ts`](./relational-model.ts) in this directory.

## Usage

```typescript
import {
  updateFromMessage, observeUser, getRelationalContext,
} from "./relational-model.js";

// At the start of every turn — passive, cheap, outlier-resistant.
updateFromMessage(userId, incomingMessage);

// When the agent forms a clearer read — explicit, higher confidence.
observeUser({ user: userId, stress: 0.7, interventionStyle: "reactive" });

// Prepend the compact summary to the system prompt so the model calibrates.
const systemPrompt = baseSystemPrompt + getRelationalContext(userId);
```

## Limitations and extensions

- **Heuristics are coarse and English-leaning.** Short-word ratio and ALL-CAPS detection are blunt proxies for stress and do not generalize cleanly across languages or writing styles. They are intentionally a *hint into an EMA*, not a measurement. Replace with a lightweight on-device classifier if you need accuracy — the EMA smoothing layer stays the same.
- **No decay in the reference.** Trust here only grows. A fuller model decays trust gently on long absence and lets the stress signal relax toward baseline over time so a single bad session does not leave a permanent mark.
- **Single dimension drives phases.** The phase ladder keys off trust alone. You could make phases a function of trust *and* session count *and* recency to avoid promoting a user who had many sessions in one frantic hour.
- **Privacy.** The model is a behavioral profile of a person. Store it under the user's own key/scope, expose it to them (it is their data), and keep it out of any cloud payload that does not need it — pair with a privacy router.
- **Calibration is advisory.** The model only *suggests* density/tone via injected labels; the LLM may ignore them. For stronger control, also use the labels to set hard knobs (output token budget, system-prompt tone instructions), not just as context text.
