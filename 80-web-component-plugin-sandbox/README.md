# Guide 80 — Web Component Plugin Sandbox


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

the agent's marketplace allows third-party plugins to render UI panels within the agent surface. Naive embedding (iframe, unsandboxed eval, direct DOM injection) creates three attack vectors:

1. **DOM clobbering / prototype pollution** — a plugin that writes to `window.name` or `Object.prototype` can hijack the host shell.
2. **Credential leakage** — a plugin with access to `document.cookie` or `sessionStorage` can exfiltrate session tokens.
3. **Style contamination** — a plugin's CSS bleeds into the host, breaking the glassmorphic 2085 theme and potentially phishing by overlaying wallet-unlock prompts.

The established solution (opaque iframes with `sandbox` attribute) is correct but too blunt: it breaks `postMessage` patterns, prevents the plugin event bus from being a first-class surface inside plugins, and incurs a full browsing context per plugin (costly on low-end devices).

---

## Approach

**Shadow DOM encapsulation + Trusted Types policy + CSP nonce injection, without an iframe.**

### Layer 1 — Custom Element host

Each plugin is registered as a Custom Element (`class PluginElement extends HTMLElement`). The element's constructor attaches a **closed** Shadow DOM root (`attachShadow({ mode: "closed" })`). The plugin receives no reference to the shadow root directly — all interaction goes through a narrow DOM API wrapper injected into the constructor scope.

Closed Shadow DOM means `document.querySelector`, `element.shadowRoot`, and extension scripts cannot traverse into the plugin tree.

### Layer 2 — Trusted Types policy

A per-plugin `TrustedTypePolicy` is created with `trustedTypes.createPolicy("plugin-<id>", { createHTML: sanitize })`. The `sanitize` function is a strict allowlist (DOMPurify-based) that strips `<script>`, inline event handlers, `data:` URIs, and JavaScript protocol links.

The host's CSP includes `require-trusted-types-for 'script'`, so any plugin that attempts to set `innerHTML` directly (bypassing the policy) is blocked at the browser level.

### Layer 3 — Scoped CSS via adopted stylesheets

The host injects one `CSSStyleSheet` per plugin using `shadowRoot.adoptedStyleSheets`. The stylesheet is locked: `Object.freeze(sheet.cssRules)` prevents runtime mutation. The `:host` selector is scoped so `:root` variables from the plugin cannot affect the parent document.

### Layer 4 — plugin event bus bridge (postMessage protocol)

Instead of direct DOM access, plugins communicate through a typed message bus:

```
Plugin → shadowRoot dispatch → PluginHost bridge → PluginEventBus
PluginEventBus → PluginHost bridge → CustomEvent → shadowRoot
```

The bridge enforces an origin check (`event.source === pluginWindow`) and a schema-validated message envelope (`{ kind: string, payload: unknown }`). Plugins receive only events they registered for — no global event sniffing.

### Layer 5 — Resource budget (PerformanceObserver)

A `PerformanceObserver` watches the plugin's `measure` entries. If CPU time exceeds 200 ms per second (rolling window), the plugin is suspended: the Custom Element is hidden, an error card is shown, and the marketplace audit log records the violation.

---

## Key guarantees

| Threat | Mitigation |
|---|---|
| DOM clobbering | Closed shadow root — no external traversal from outside |
| Style bleed | Adopted stylesheets, frozen, scoped to `:host` |
| Event sniffing | Plugin only receives events it subscribed to via bridge |
| Resource exhaustion | PerformanceObserver budget enforcer |
| Unsafe innerHTML | Trusted Types blocks direct DOM injection |

## ⚠️ Security caveat — same-origin credential isolation requires an iframe boundary

Shadow DOM does **not** isolate JavaScript execution context. A plugin registered as a Custom Element runs in the same JavaScript realm as the host page. This means:

- Plugin code can read `document.cookie`, `sessionStorage`, `localStorage`, and all global variables — **regardless** of Shadow DOM encapsulation.
- Closed Shadow DOM only prevents *DOM traversal* (querySelector etc.) — it does not prevent the plugin's JS from calling `document.cookie` directly.
- Trusted Types prevents `innerHTML` injection but does not restrict what plugin JS can call in `window` scope.

**Consequence:** This design is safe only for **trusted** marketplace plugins that have passed code review. For **untrusted** third-party plugins, the correct isolation boundary is an `<iframe sandbox="allow-scripts">` with `sandbox` attribute, or a `Worker` thread (which has no DOM access at all).

**Revised threat model:**

| Threat | Shadow DOM approach | iframe/Worker approach |
|---|---|---|
| Style bleed | ✅ Blocked | ✅ Blocked |
| DOM clobbering | ✅ Blocked | ✅ Blocked |
| Credential leakage (`document.cookie`, `sessionStorage`) | ❌ Not blocked — same JS realm | ✅ Blocked — cross-origin boundary |
| Prototype pollution | ⚠️ Partial (Trusted Types helps) | ✅ Blocked |

**Practical recommendation:** Use the Shadow DOM + Trusted Types approach for the agent's own first-party extension panels. For untrusted marketplace plugins, gate on a lightweight iframe wrapper with `sandbox="allow-scripts allow-same-origin"` plus a postMessage event bus that mirrors the bridge protocol in Layer 4 above.

---

## Novel contribution

Prior guides addressed the server-side plugin host (MCP) and marketplace trust (guide 38). This guide is the first to define the **client-side rendering sandbox** for the agent's own first-party extension panels — providing strong style isolation and DOM traversal isolation without the full cost of a separate browsing context.

**Trade-off vs. sandboxed iframe:** the Shadow DOM approach is lighter (no separate browsing context, no postMessage serialisation overhead) but provides *weaker* credential isolation than an `<iframe sandbox>` boundary. A sandboxed cross-origin iframe is a hard JS-realm boundary; Shadow DOM is not. The correct choice by trust level is documented in the security caveat above: Shadow DOM for reviewed first-party panels, iframe sandbox for untrusted third-party plugins.

---

## Integration points

- `artifacts/vanguard/src/lib/pluginSandbox.ts` — `PluginSandbox` class
- `artifacts/vanguard/src/lib/pluginBridge.ts` — plugin event bus bridge
- `artifacts/api-server/src/routes/marketplace.ts` — plugin manifest validation
- CSP headers: `artifacts/api-server/src/app.ts` (Helmet configuration)

---

## Deferred

- WASM sandbox for compute-intensive plugins (replaces PerformanceObserver budget)
- SharedArrayBuffer message passing for performance-critical plugin ↔ host data exchange
- Formal verification of the Trusted Types policy allowlist

See `dbk-defer-list.md` for parked items.
