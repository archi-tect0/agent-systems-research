# Intent-Based Tool Schema Selection


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A capable agent exposes a large tool surface — 80+ functions for memory, web,
wallet, scheduling, code, messaging, media, apps, and platform control. The naive
approach sends *every* tool's full JSON schema (name + description + parameter
spec) to the model on every turn. At ~80 tools × ~200 tokens of schema each,
that is **~17K tokens of tool definitions injected before the user even speaks** —
on every single turn.

That cost is paid three ways:

1. **Latency.** 17K extra prompt tokens add 300–800ms to time-to-first-token on a
   cloud model, on every turn.
2. **Money.** Tool schemas are input tokens, billed every turn even when the user
   just says "hi".
3. **Provider limits.** Some chat-completions APIs cap the number of tools per
   request (e.g. 128). A 200-tool agent physically cannot send them all.

But the model still needs to *know what it can do*. If you simply drop tools to
save tokens, the model can't call a tool it was never told exists. The challenge
is to give the model **awareness of the whole surface** while only paying the
schema cost for the handful of tools it's likely to need *this* turn.

This guide describes a three-stage selection scheme that cuts per-turn tool
tokens from ~17K to ~4–8K with no loss of reachability: a name-only catalog tells
the model everything that exists, and full schemas are loaded only for an
always-on core plus intent-matched drawers.

## Design decisions

**Why separate "knowing a tool exists" from "knowing how to call it"?**
These are two different needs with two different costs. *Knowing a tool exists* —
its name and rough category — costs a few tokens and lets the model decide it
*wants* to use it. *Knowing how to call it* — the full parameter schema — costs
~200 tokens and is only needed once the model has committed to using it. By
splitting them, the expensive part (schemas) is loaded lazily while the cheap
part (names) is always present.

**The name-only catalog (`TOOL_INDEX`).**
Tools are grouped into named *drawers* (WEB, VIS, MEM, WALLET, SCHED, …). A
single compact line is injected once at the bottom of the system prompt:

```
TOOL_INDEX: [WEB:web_search,web_fetch,show_map,…] [VIS:generate_image,show_chart,…] [MEM:remember,recall_memory,…] …
```

This is ~250 tokens for the *entire* surface — no parameter schemas, just
`[DRAWER:name,name,…]`. The model now knows every tool it has and which drawer
holds it. If it decides it needs a tool whose schema isn't loaded, it can say so,
and the next turn loads that drawer.

**Stage 1 — always-on core.**
A minimal set (~13 tools) whose full schemas are sent every turn: memory
(`remember`, `recall_memory`), basic navigation (`navigate_to`, `web_search`),
self-expression and user-preference signals (`record_correction`), and the
planning backbone (`create_plan`, `spawn_task`). These are the tools used across
almost all turns regardless of topic, so loading their schemas unconditionally
costs ~1K tokens and avoids a wasted round-trip on the common case.

**Stage 2 — intent → drawer expansion.**
The turn is classified into an intent kind (a separate, cheap classifier).
An `INTENT_DRAWER_MAP` maps each intent to the 1–2 drawers worth pre-loading:

```
wallet         → [WALLET]
image_gen      → [VIS]
screen_display → [VIS, SCENE]
reminder       → [SCHED]
code           → [CODE, VIS]
…
```

Only those drawers' schemas are injected. Because drawers are sized to ≤12 tools,
one drawer is ≤~960 tokens. A typical turn loads core + one or two drawers ≈
2–3K tokens of schema, versus 17K for everything.

**Stage 2b — keyword safety net.**
The intent classifier isn't perfect, and a single turn can carry a sub-intent the
primary intent missed ("…and show me a *chart*" inside a conversation turn). A set
of cheap regex probes over the turn text adds specific tools when their trigger
words appear (`/\bchart\b|graph|plot/` → chart tools; `/remind|schedule|alarm/` →
reminder tools). This catches what the drawer map didn't without loading whole
drawers.

**Stage 3 — dynamic tools, with a conversation shortcut.**
Tools that are computed per-session (installed MCP servers, threat-response tools,
per-user app tools) are appended last. The one important optimization: for *pure
conversation* turns ("hi", small talk), the big app-tool blob (30+ tools ≈ 6K
tokens) and most platform tools are skipped entirely — the core set already covers
what a chat turn needs. Conversation is the most common turn type, so this single
guard saves the most tokens in aggregate.

**Hard cap.**
After all stages, the list is capped at the provider's tool limit (e.g. 128, or
higher for fast backends with large context windows). If the cap is hit, the tail
(lowest-priority app tools) is dropped and a warning is logged — core and
intent-matched tools, added first, always survive.

## Algorithm

```
selectTools(turnText, intentKind, allTools, dynamicTools, limit):
  selected = ordered unique set        # add-order = priority; dedupe by name

  # Stage 1 — always-on core (full schemas)
  add(allTools where name in CORE_NAMES)

  # Stage 1.5 — intent → drawer expansion
  drawers = INTENT_DRAWER_MAP[intentKind] or []
  drawerNames = union of TOOL_DRAWERS[d] for d in drawers
  add(allTools where name in drawerNames)

  # Stage 2 — keyword safety net (sub-intent signals)
  for (pattern, tools) in KEYWORD_PROBES:
    if pattern matches turnText: add(tools)

  # Stage 3 — dynamic tools (with conversation shortcut)
  if intentKind == "conversation":
    add(platformTools[:8], mcpTools, threatTools)     # skip app blob
  else:
    add(platformTools, mcpTools, threatTools, appTools)

  if selected.size > limit:
    log("capped; dropping tail")
    selected = selected[:limit]

  return selected

buildToolCatalog():                    # injected once into system prompt
  return "TOOL_INDEX: " + join(
    for (drawer, names) in TOOL_DRAWERS: "[" + drawer + ":" + names.join(",") + "]"
  )
```

The add-order encodes priority: core first, then intent drawers, then keyword
hits, then dynamic tools. The dedupe-by-name keeps the *first* occurrence, so a
tool that's both core and keyword-matched is loaded once, at its highest priority
position. When the cap truncates the tail, only the lowest-priority additions are
lost.

## Reference implementation

See [`tool-selection.ts`](./tool-selection.ts). It defines the drawer registry,
the catalog builder, the intent→drawer map, the keyword probes, and the staged
selector. The `--demo` block runs three turns (a greeting, a wallet request, a
chart request) and prints the catalog plus the per-turn selected tool count and
estimated token savings.

## Usage

```typescript
import { buildToolCatalog, selectTools } from "./tool-selection.js";

// Once, at prompt-build time:
systemPrompt += "\n" + buildToolCatalog();   // ~250 tokens, names only

// Every turn:
const tools = selectTools({
  turnText,
  intentKind,            // from your intent classifier
  allTools,              // full schema objects, keyed by name
  dynamic: { platform, mcp, threat, app },
  limit: 128,
});
// send `tools` (full schemas) to the chat-completions call
```

## Limitations and extensions

- **Depends on an intent classifier.** The drawer expansion is only as good as
  the upstream intent label. The keyword safety net mitigates misclassification,
  but a badly-wrong intent loads the wrong drawer. The classifier and this
  selector should be evaluated together.
- **A needed tool may take an extra turn.** If the model wants a tool whose drawer
  wasn't loaded, it must signal that and the next turn loads it — a one-turn
  latency cost in the rare miss case. Tuning the drawer map and keyword probes
  pushes these misses toward zero.
- **Drawer membership is hand-maintained.** Adding a tool means assigning it a
  drawer. A large surface benefits from a lint check that every registered tool
  belongs to exactly one drawer.
- **Description stripping is a further lever.** For very simple intents, even the
  loaded schemas' *descriptions* can be dropped (the model infers behavior from
  name + params), saving another 2–3K tokens — orthogonal to drawer selection.
