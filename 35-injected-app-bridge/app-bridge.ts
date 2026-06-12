/**
 * Injected App Bridge for Single-File Mini-Apps
 *
 * Lets users author tiny one-file HTML mini-apps that run inside a host shell
 * and get identity + scoped storage transparently. The host injects a small
 * bridge <script> into the app's page before </head>; the app then calls
 * window.host.get/set/del/emit/notify with no keys to manage.
 *
 * Transports (chosen at runtime by the bridge):
 *   - embedded (iframe): postMessage RPC to the host
 *   - standalone        : localStorage fallback (same API, no host)
 *
 * Identity is derived by the HOST from the session (wallet or guest:deviceId)
 * and stamped onto every storage row, keyed by (appId, scopeKey, key). The app
 * never sees who it is, and one user's data is physically separate from another's.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Identity ─────────────────────────────────────────────────────────────────

export interface Caller {
  wallet?: string;
  deviceId?: string;
}

/** Resolve a caller to a storage scope key. Real identity, or a guest fallback. */
export function scopeKeyOf(caller: Caller): string {
  if (caller.wallet) return caller.wallet.toLowerCase();
  return `guest:${caller.deviceId ?? "guest"}`;
}

// ── Bridge script generation ─────────────────────────────────────────────────

const BRIDGE_MARKER = "host-app-bridge";

/**
 * Generates the injected <script> — the window.host RPC client.
 * `globalName` defaults to "host" so apps call window.host.set(...).
 */
export function buildBridgeScript(globalName = "host"): string {
  return `<script>
/* ${BRIDGE_MARKER} v1 — auto-injected by the host shell */
window.${globalName} = (function () {
  const pending = new Map();
  const inIframe = window.parent !== window;

  function send(msg) {
    if (inIframe) { try { parent.postMessage({ host: true, ...msg }, '*'); } catch (e) {} }
  }

  function request(method, params) {
    if (!inIframe) return Promise.resolve(localFallback(method, params));
    return new Promise(function (resolve) {
      const id = 'h_' + Math.random().toString(36).slice(2, 9);
      pending.set(id, { resolve: resolve });
      send({ type: 'rpc_request', messageId: id, method: method, params: params });
      setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); resolve(null); } // silent: app keeps working
      }, 3000);
    });
  }

  function localFallback(method, params) {
    if (method === 'storage.get') {
      try { return { value: JSON.parse(localStorage.getItem('host:' + params.key)) }; } catch (e) { return null; }
    }
    if (method === 'storage.set') {
      localStorage.setItem('host:' + params.key, JSON.stringify(params.value)); return { ok: true };
    }
    if (method === 'storage.delete') {
      localStorage.removeItem('host:' + params.key); return { ok: true };
    }
    return null;
  }

  window.addEventListener('message', function (e) {
    if (!e.data || !e.data.host) return;
    const d = e.data;
    if (d.type === 'rpc_response' && pending.has(d.messageId)) {
      const p = pending.get(d.messageId);
      pending.delete(d.messageId);
      p.resolve(d.error ? null : d.result);
    }
  });

  send({ type: 'rpc_request', method: 'app.ready', messageId: 'init', params: {} });

  return {
    get:    function (key)        { return request('storage.get', { key: key }).then(function (r) { return r && r.value !== undefined ? r.value : null; }); },
    set:    function (key, value) { return request('storage.set', { key: key, value: value }); },
    del:    function (key)        { return request('storage.delete', { key: key }); },
    emit:   function (event, payload) { send({ type: 'event_emit', event: event, payload: payload }); },
    notify: function (title, body)    { return request('notify.create', { title: title, body: body }); },
    onState: function (fn) {
      window.addEventListener('message', function (e) {
        if (e.data && e.data.host && e.data.type === 'state_patch') fn(e.data.patch);
      });
    }
  };
})();
</script>`;
}

/** Idempotent splice of the bridge before </head> (or prepend if no head). */
export function injectBridge(html: string, globalName = "host"): string {
  if (html.includes(BRIDGE_MARKER)) return html; // already injected
  const bridge = buildBridgeScript(globalName);
  const i = html.indexOf("</head>");
  if (i === -1) return bridge + "\n" + html;
  return html.slice(0, i) + bridge + "\n" + html.slice(i);
}

// ── App vault (storage model) ────────────────────────────────────────────────

export interface App {
  id: string;
  scopeKey: string;
  name: string;
  slug: string;
  description: string;
  html: string;
  icon: string;
  category: string;
  version: number;
  launchCount: number;
  lastLaunchedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export class BridgeError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "BridgeError";
  }
}

export class AppVault {
  private apps = new Map<string, App>();                                   // appId → app
  private data = new Map<string, unknown>();                               // `${appId}|${scopeKey}|${key}` → value

  private appKey(scopeKey: string, slug: string): string {
    return `${scopeKey}::${slug}`;
  }
  private bySlug = new Map<string, string>();                              // `${scopeKey}::${slug}` → appId

  private dataKey(appId: string, scopeKey: string, key: string): string {
    return `${appId}|${scopeKey}|${key}`;
  }

  // ── Save / upsert (versioned), scoped to the caller ─────────────────────────
  saveApp(
    caller: Caller,
    spec: { name: string; slug: string; html: string; description?: string; icon?: string; category?: string },
  ): App {
    if (!spec.name || !spec.slug || !spec.html) throw new BridgeError(400, "name_slug_html_required");
    const scopeKey = scopeKeyOf(caller);
    const existingId = this.bySlug.get(this.appKey(scopeKey, spec.slug));

    if (existingId) {
      const app = this.apps.get(existingId)!;
      app.name = spec.name;
      app.description = spec.description ?? app.description;
      app.html = spec.html;
      app.icon = spec.icon ?? app.icon;
      app.category = spec.category ?? app.category;
      app.version += 1;
      app.updatedAt = Date.now();
      return app;
    }

    const app: App = {
      id: crypto.randomUUID(),
      scopeKey,
      name: spec.name,
      slug: spec.slug,
      description: spec.description ?? "",
      html: spec.html,
      icon: spec.icon ?? "🧩",
      category: spec.category ?? "utility",
      version: 1,
      launchCount: 0,
      lastLaunchedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.apps.set(app.id, app);
    this.bySlug.set(this.appKey(scopeKey, spec.slug), app.id);
    return app;
  }

  private resolve(caller: Caller, slug: string): App {
    const scopeKey = scopeKeyOf(caller);
    const id = this.bySlug.get(this.appKey(scopeKey, slug));
    const app = id ? this.apps.get(id) : undefined;
    if (!app) throw new BridgeError(404, "app_not_found");
    return app;
  }

  // ── Render for embedding: inject bridge + bump launch metrics ────────────────
  render(caller: Caller, slug: string, globalName = "host"): string {
    const app = this.resolve(caller, slug);
    app.launchCount += 1;          // single increment, race-free in a DB
    app.lastLaunchedAt = Date.now();
    return injectBridge(app.html, globalName);
  }

  // ── Scoped data store (REST path AND postMessage RPC backend) ────────────────
  setData(caller: Caller, slug: string, key: string, value: unknown): void {
    if (!key) throw new BridgeError(400, "key_required");
    const app = this.resolve(caller, slug);
    this.data.set(this.dataKey(app.id, scopeKeyOf(caller), key), value);
  }

  getData(caller: Caller, slug: string, key: string): unknown {
    const app = this.resolve(caller, slug);
    return this.data.get(this.dataKey(app.id, scopeKeyOf(caller), key)) ?? null;
  }

  deleteData(caller: Caller, slug: string, key: string): void {
    const app = this.resolve(caller, slug);
    this.data.delete(this.dataKey(app.id, scopeKeyOf(caller), key));
  }
}

// ── Host broker: maps postMessage RPC onto the scoped store (allow-listed) ────

export interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
}

export class HostBroker {
  private vault: AppVault;
  constructor(vault: AppVault) {
    this.vault = vault;
  }

  /** Handle one RPC request from a mini-app, scoped to the resolved caller. */
  handle(caller: Caller, slug: string, req: RpcRequest): { result?: unknown; error?: string } {
    switch (req.method) {
      case "app.ready":
        return { result: { ok: true } };
      case "storage.get":
        return { result: { value: this.vault.getData(caller, slug, String(req.params["key"])) } };
      case "storage.set":
        this.vault.setData(caller, slug, String(req.params["key"]), req.params["value"]);
        return { result: { ok: true } };
      case "storage.delete":
        this.vault.deleteData(caller, slug, String(req.params["key"]));
        return { result: { ok: true } };
      case "notify.create":
        return { result: { delivered: true } };
      default:
        // Never reflect an unknown method into a privileged action.
        return { error: "method_not_allowed" };
    }
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const vault = new AppVault();

  vault.saveApp({ wallet: "0xUSER" }, {
    name: "Counter", slug: "counter",
    html: "<html><head><title>Counter</title></head><body>hi</body></html>",
  });

  const html = vault.render({ wallet: "0xUSER" }, "counter");
  console.log("bridge injected:", html.includes("host-app-bridge"));
  console.log("injection idempotent:", injectBridge(html) === html);

  const broker = new HostBroker(vault);
  broker.handle({ wallet: "0xUSER" }, "counter", { method: "storage.set", params: { key: "n", value: 5 } });
  console.log("user A reads:", broker.handle({ wallet: "0xUSER" }, "counter", { method: "storage.get", params: { key: "n" } }));

  // A different user gets isolated storage for the same app slug
  vault.saveApp({ wallet: "0xOTHER" }, {
    name: "Counter", slug: "counter",
    html: "<html><head></head><body>hi</body></html>",
  });
  console.log("user B reads (isolated):", broker.handle({ wallet: "0xOTHER" }, "counter", { method: "storage.get", params: { key: "n" } }));

  // Unknown methods are rejected
  console.log("unknown method:", broker.handle({ wallet: "0xUSER" }, "counter", { method: "fs.read", params: {} }));

  // Versioned upsert
  const v = vault.saveApp({ wallet: "0xUSER" }, {
    name: "Counter v2", slug: "counter",
    html: "<html><head></head><body>v2</body></html>",
  });
  console.log("version after re-save:", v.version);
}
