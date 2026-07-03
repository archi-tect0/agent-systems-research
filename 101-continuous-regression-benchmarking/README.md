# Guide 101 — Continuous Regression Benchmarking with Automatic Regression Detection


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A small, pluggable benchmark suite that runs against any backend function, diffs each case's pass/fail state against the previous run, and specifically flags regressions — cases that used to pass and no longer do — rather than just reporting an aggregate score.*

---

## Problem

A system with periodic capability changes (new prompts, new routing logic, new fine-tuned weights) has no cheap, continuous way to know whether a change quietly broke a previously-working capability — a factual answer, a safety refusal, a basic helpfulness case — until a user notices in production. An aggregate pass-rate number isn't enough: a suite that goes from 92% to 90% could mean two new failures on core cases, or two flaky cases that never passed reliably in the first place. Those need very different responses.

## Design decisions

- **A small, fixed bank of category-tagged benchmark cases** (factuality, safety, helpfulness, values/fairness), each with a scorer strategy suited to its category — exact match for factual lookups, substring/contains match for helpfulness cases with acceptable-answer variance, refusal-pattern match for safety cases — rather than one universal scorer that would be too strict for some categories and too loose for others.
- **Every run is stored immutably with per-case pass/fail**, so the *previous* run can be diffed against the *current* one. This is what turns a raw pass rate into an actionable regression list.
- **A case that passed last time and fails now is flagged specifically as a regression**, distinct from a case that has simply never passed. A chronic failure needs a feature fix; a fresh regression needs someone to look at what just changed — conflating the two in one "failed cases" list buries the more urgent signal.
- **Results are written incrementally, case by case**, not only at the end of the full run — a crash partway through a long suite still leaves a usable partial record instead of losing the whole run's signal.
- **The suite is designed to be pluggable against any backend function** (a routing decision, a prompt variant, a fine-tuned model) so the same fixed case bank can validate very different kinds of changes before they're promoted, without rewriting the benchmark harness each time.

## Algorithm

```
for case in caseBank:
  response = backend(case.prompt)
  passed   = scorer[case.scorerType](response, case.expected)
  record({ caseId: case.id, category: case.category, passed })

previousRun = loadImmutableRun(runId - 1)
regressions = currentRun.filter(r =>
  r.passed === false && previousRun.find(p => p.caseId === r.caseId)?.passed === true
)

passRate = currentRun.filter(r => r.passed).length / currentRun.length
report({ passRate, regressionCount: regressions.length, regressions })
```

## Reference implementation

`index.ts` defines a small fixed case bank across the four categories, then runs it against two synthetic backend versions: a "good" backend that passes everything, and a "regressed" backend that deliberately fails two previously-passing cases while still passing everything else (including a case that never passed under either version, to confirm it is *not* misclassified as a regression). It verifies the regression detector flags exactly the two newly-broken cases, computes a correct aggregate pass rate for each run, and confirms results are written incrementally (a simulated mid-run crash still leaves completed case results intact).

```bash
node index.ts
```

## Limitations and extensions

- Scorer strategies here (exact/substring/refusal-pattern) are intentionally simple; a real deployment will likely need semantic-similarity or LLM-graded scorers for open-ended categories — the pluggable-scorer-per-case-type structure is designed to accept that without changing the harness.
- This guide detects *that* something regressed, not *why*. Pair it with whatever change-tracking your deployment already has (a prompt version, a routing config version) so a regression alert can be correlated to the specific change that caused it.
- A case bank that never grows becomes less useful over time as it stops covering new capabilities — treat "add a case for every real production failure you find" as an ongoing practice, not a one-time setup step.
