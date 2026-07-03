# Tool-Use Critic — Independent Pre-Execution Validator


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An LLM that emits tool calls is, from a security standpoint, an untrusted code generator. It can be steered by prompt injection in retrieved content, it can hallucinate arguments, it can call a high-stakes tool with the risk profile of a low one, and it can simply get the arguments wrong. The authority-band engine (guide 37) decides *whether a tool may auto-execute*, but it does not look at *the call itself* — the specific arguments, whether required fields are present, whether the arguments contain an injection payload, or whether the call's declared risk class is consistent with the band it was assigned.

The tool critic is a **second, independent pass** that inspects a concrete tool call right before execution and returns one of three verdicts:

- **block** — the call is suppressed; the agent gets an error back instead.
- **warn** — the call proceeds, but the agent receives a caution note.
- **allow** — proceed as normal.

It sits at the dispatch boundary — after the model has chosen a tool and arguments, before the tool actually runs — and acts as the layer that turns "the model wants to do X" into "X is safe and well-formed enough to actually do."

## Design decisions

**Why a separate critic instead of folding checks into the band engine?**
Separation of concerns and defense in depth. The band engine is a small, auditable policy lookup; keeping it that way is valuable. The critic is where the messier, call-specific heuristics live — injection-pattern matching, argument completeness, risk/band consistency — which evolve faster and would bloat the policy engine. Running them as an independent stage means a bug or gap in one does not silently disable the other.

**Why is the dangerous-argument check first and always a hard block?**
The single most dangerous input is a tool call whose *arguments* carry a prompt-injection or policy-bypass payload ("ignore previous instructions," "you are now…," "disregard all safety," or — for a wallet agent — a literal seed phrase or private key in the args). These are checked first, before anything else, and always block. There is no legitimate reason for these patterns to appear inside structured tool arguments, so a match is unambiguous. The check flattens the whole argument object to a lowercase string and tests it against a small set of regexes.

**Why are missing arguments block-for-high-risk but warn-for-low-risk?**
A `send_funds` call missing its `amount` is a non-starter — block it. But a low-risk tool missing an optional-ish field can often proceed and self-correct, so a warn (the call goes through, the agent is told it may be incomplete) is less disruptive than a hard block. The threshold is the tool's risk class: `high_write` and `irreversible` block on missing required args; everything else warns.

**Why a passkey "floor"?**
Some tools are marked in the registry with a `passKeyFloor` flag — they require a *fresh* human passkey proof, full stop. If the session does not carry one, the critic blocks and signals `suggestPassKey` so the UI can prompt for authentication. This is independent of the band: it is a property of the tool, enforced even before the band evaluation.

**Why a risk-class ↔ band consistency check?**
The tool registry independently records each tool's `riskClass` (read / draft / simulate / low_write / high_write / irreversible). The critic maps each risk class to a *minimum* band floor:

```
read → 0   draft → 0   simulate → 1   low_write → 2   high_write → 3   irreversible → 4
```

If a tool's risk class implies a higher floor than the band it was actually assigned (e.g. an `irreversible` tool sitting at Band 0), that is almost certainly a misconfiguration. The critic does not block on it — the band engine remains authoritative — but it *warns*, surfacing the inconsistency so an operator can fix the band. This is the cross-check that catches a tool accidentally tiered too low.

**Why fail-open if the policy lookup errors?**
The critic calls the band engine for the band check. If that call throws (DB blip, etc.), the critic returns `allow` rather than blocking — but note that this only bypasses the *band* stage. The band engine itself is fail-closed on unknown tools; the critic's fail-open here is a deliberate choice to not let a transient infrastructure error wedge the whole agent, accepting that the upstream gates (the cap filter, the dispatch gate) remain in force.

**The post-hoc extension.**
The same verdict structure powers a *post-hoc* critic: after a tool runs, evaluate whether the call was appropriate and whether it achieved the user's intent, and write a correction memory when it did not. That feedback (see the reflective/correction-memory guides) is what lets the agent learn from bad calls rather than repeating them. The pre-execution validator and the post-hoc evaluator share the same registry, risk classes, and verdict vocabulary.

## Algorithm

```
criticize(ctx):
  if hasDangerousArgs(ctx.args):                    return block "dangerous_args"
  missing = missingRequiredArgs(tool, args)
  if missing:
    if riskClass in {high_write, irreversible}:     return block "missing_required_args"
    else:                                           return warn  "incomplete_args"
  if meta.passKeyFloor and not session.hasPassKey:  return block "passkey_required" (suggestPassKey)
  policy = evaluateBand(tool)        // fail-open to allow on error
  if policy.neverAuto:                              return block "band4_never_auto" (suggestPassKey)
  if RISK_BAND_FLOOR[riskClass] > policy.band:      return warn  "risk_band_mismatch"
  return allow
```

## Reference implementation

See [`tool-critic.ts`](./tool-critic.ts). It bundles a compact tool registry (family / privacy class / risk class / auth / passkey-floor metadata) and the critic itself, and depends on the authority-band engine from guide 37 (a minimal compatible version is included so the file runs standalone).

## Usage

```typescript
import { criticize } from "./tool-critic.js";

const verdict = await criticize({
  wallet,
  toolName: "send_funds",
  args: { to: "0xabc…", amount: "1.5" },
  sessionHasPassKey: false,
});

if (verdict.decision === "block") {
  // suppress the tool call; return verdict.reason to the agent
  if (verdict.suggestPassKey) promptForPasskey();
} else if (verdict.decision === "warn") {
  // run the tool, but attach verdict.reason as a caution
}
```

## Limitations and extensions

- **Regex injection detection is a screen, not a proof.** The dangerous-argument patterns catch known phrasings; a novel obfuscation can slip through. Treat it as one layer — the band engine, the passkey floor, and human approval on high bands are the real backstops.
- **Required-args lists are hand-maintained.** The critic only knows the required fields for tools it has been told about. Generating these from the tool schemas (JSON Schema `required`) would remove the maintenance burden and close the gap for tools without an entry.
- **Risk/band mismatch only warns.** By design — but a stricter deployment could promote the mismatch to a block for `irreversible`-class tools, refusing to run an irreversible tool that someone tiered below Band 4.
- **The post-hoc loop needs a memory sink.** The appropriateness/intent evaluation is only useful if its corrections are stored and retrieved on later turns; wire it to a correction-priority memory layer (guides 06/07) to close the learning loop.
