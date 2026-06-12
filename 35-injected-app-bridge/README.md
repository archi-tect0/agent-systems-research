# Injected App Bridge for Single-File Mini-Apps

## Problem

We want users to author tiny "mini-apps" — a single HTML file with inline CSS and JavaScript — and run them inside a host application (an OS-like shell, a launcher, an agent surface). These apps should be able to do useful, stateful things: store a value, read it back later, send a notification, react to host state changes. But a single HTML file has no backend, no identity, and no storage of its own.

The naive approach is to give each mini-app a backend SDK and credentials. That is far too heavy for a one-file app, and it pushes secret management onto the app author. We want the *host* to provide identity and storage, transparently, so the app author writes `host.set("score", 100)` and it just works — scoped to the current user, with no keys to manage.

The challenge: the app runs in an untrusted sandbox (an `<iframe>`), authored by a user, and must not be able to read another user's data or escape its scope. The host must inject a controlled bridge into the app's page and broker every privileged operation.

## Design decisions

**Inject the bridge at serve time, not at author time.**
When the host renders a mini-app for embedding, it parses the stored HTML and splices a small `<script>` — the *bridge* — in just before `</head>` (or prepends it if there is no head). The app author never writes or sees the bridge; they just call `window.host.get/set/...`. Injection is idempotent: a marker check prevents double-injection if the HTML already contains the bridge.

**The bridge speaks two transports, chosen at runtime.**
- **Embedded (in an iframe):** the bridge talks to the host via `postMessage`. Each call is an RPC envelope `{ host: true, type: "rpc_request", messageId, method, params }`; the host replies with `{ type: "rpc_response", messageId, result | error }`. The bridge keeps a `Map` of pending promises keyed by `messageId` and resolves them on reply. A timeout (e.g. 3 s) silently resolves to `null` so the app keeps working even if the host doesn't implement a method.
- **Standalone (not in an iframe):** the same API falls back to `localStorage`, so the exact same app code runs when opened directly, with no host.

**The host derives identity from the session — the app never sees it.**
Every privileged data endpoint resolves the caller to a *scope key* (the session's wallet/account, or a `guest:<deviceId>` fallback for unauthenticated use). Storage rows are keyed by `(appId, scopeKey, key)`. The app calls `host.set("score", 100)` with no notion of who it is; the host stamps the identity. One app's data for user A is physically separate from the same app's data for user B, and from a different app's data.

**Two storage paths, same semantics.**
The host exposes REST endpoints (`POST /:slug/data`, `GET /:slug/data/:key`) for apps that prefer fetch, *and* the postMessage RPC for apps that prefer the bridge. Both resolve identity the same way and write to the same scoped store, so an author can mix styles freely.

**Render hardening.**
The rendered HTML is served with `X-Frame-Options: SAMEORIGIN` so only the host origin can frame it, and the content type is pinned. The app's own scripts run in the iframe sandbox; only the bridge is host-authored.

**Versioned upserts and launch metrics.**
Saving an app upserts by `(scopeKey, slug)` and bumps a version counter. Rendering increments a launch count and stamps `lastLaunchedAt` with a single SQL increment (no read-modify-write), so usage metrics are cheap and race-free.

## Algorithm

```
Author saves app:
  POST /apps { name, slug, html, ... }
    scopeKey = identity(session) or guest:deviceId
    upsert app by (scopeKey, slug); version++ on update

Render for embedding:
  GET /apps/:slug/render
    load app for (scopeKey, slug)
    increment launchCount, set lastLaunchedAt   (single SQL update)
    html = injectBridge(app.html)
    serve html with X-Frame-Options: SAMEORIGIN

injectBridge(html):
  if html contains bridge marker: return html        // idempotent
  i = indexOf("</head>")
  return i == -1 ? BRIDGE + html
                 : html[0:i] + BRIDGE + html[i:]

Bridge RPC (iframe):
  request(method, params):
    if not in iframe: return localFallback(method, params)
    id = random; pending[id] = {resolve, reject}
    parent.postMessage({ host:true, type:"rpc_request", messageId:id, method, params })
    timeout(3s) → resolve(null)
  on message {type:"rpc_response", messageId, result, error}:
    pending[messageId].resolve(result) / reject(error)

Privileged data (host side):
  POST /apps/:slug/data { key, value }:
    scopeKey = identity(session); upsert store[(appId, scopeKey, key)] = value
  GET  /apps/:slug/data/:key:
    scopeKey = identity(session); return store[(appId, scopeKey, key)] ?? null
```

## Reference implementation

See [`app-bridge.ts`](./app-bridge.ts) in this directory. It contains:
- `buildBridgeScript()` — generates the injected `<script>` (the `window.host` RPC client with iframe/postMessage and localStorage-fallback paths).
- `injectBridge(html)` — idempotent splice before `</head>`.
- `AppVault` — an in-memory model of save/upsert (versioned), render (with launch metrics and injection), and the scoped data store, with identity resolved per call.
- `HostBroker` — the host-side RPC handler that maps `storage.get/set/delete` and `notify.create` onto the scoped store, demonstrating the postMessage contract end-to-end.

## Usage

```typescript
import { AppVault, HostBroker, injectBridge } from "./app-bridge.js";

const vault = new AppVault();

// A user saves a one-file mini-app
vault.saveApp({ wallet: "0xUSER" }, {
  name: "Counter", slug: "counter",
  html: "<html><head><title>Counter</title></head><body>hi</body></html>",
});

// Rendering injects the bridge and bumps launch metrics
const html = vault.render({ wallet: "0xUSER" }, "counter");
console.log(html.includes("host-app-bridge")); // true

// Host brokers a scoped storage write/read (postMessage RPC backend)
const broker = new HostBroker(vault);
broker.handle({ wallet: "0xUSER" }, "counter", { method: "storage.set", params: { key: "n", value: 5 } });
console.log(broker.handle({ wallet: "0xUSER" }, "counter", { method: "storage.get", params: { key: "n" } }));
```

## Limitations and extensions

- **The iframe sandbox is the real security boundary.** Serve apps from a distinct origin and apply the `sandbox` attribute + a strict CSP so a malicious mini-app cannot reach host cookies or APIs except through the bridge. The bridge is the *only* sanctioned channel.
- **Validate every RPC method on the host.** The bridge can request any method name; the host must allow-list methods and validate params. Never reflect an unknown method into a privileged action.
- **Guest scope is device-bound and weak.** The `guest:<deviceId>` fallback lets unauthenticated apps store data, but it is only as trustworthy as the device id. Promote to real identity before storing anything sensitive.
- **No quota in the model.** Add per-(app, scope) size and rate limits so a runaway app can't exhaust storage.
- **HTML is stored verbatim.** Consider sanitizing or at least size-capping stored HTML, and stripping any pre-existing bridge marker on save to prevent spoofing the injection check.
