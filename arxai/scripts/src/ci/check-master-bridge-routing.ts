// Centralized Master MT5 Bridge — 3 CI guards.
//
// These guards stop a future regression from re-breaking Slice 1+2:
//
//  1. modernDemoDispatchUsesRouting
//     The modern demo dispatch path (demoCommandQueue +
//     demoCommandConsumer) must call evaluateRoutedDemoDispatchGate,
//     not evaluatePerUserDispatchGate directly. Otherwise
//     SHARED_MASTER_MT5 mode silently falls back to per-user dispatch
//     and the master bridge is bypassed.
//
//  2. masterBridgeLiveLocked
//     The Master Bridge admin dashboard must visibly state that live
//     trading via the master bridge is disabled. Cosmetic but it's an
//     operator-safety contract; the page should never look like a live
//     trading control panel.
//
//  3. masterBridgeSecretsNotLeaked
//     Master-bridge user/admin UI files (master-bridge.tsx,
//     PlatformMasterBridgeCard in mt5-setup.tsx, meRoutingStatus
//     endpoint) must never render `apiKeyHash`, `bridgeToken`, or
//     `tokenLast4` of the *master* connection. Per-user
//     PerUserBridgeTokenCard is allowed to render the user's own
//     tokenLast4 (that's the whole point of the card) — it's only the
//     master surfaces that must stay silent.
import { read, rel, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const QUEUE = join(ROOT, "artifacts/api-server/src/lib/mt5/demoCommandQueue.ts");
const CONSUMER = join(ROOT, "artifacts/api-server/src/lib/mt5/demoCommandConsumer.ts");
const ADMIN_PAGE = join(ROOT, "artifacts/trading-dashboard/src/pages/admin/master-bridge.tsx");
const ME_ROUTING = join(ROOT, "artifacts/api-server/src/routes/meRoutingStatus.ts");
const MT5_SETUP = join(ROOT, "artifacts/trading-dashboard/src/pages/mt5-setup.tsx");

export function checkModernDemoDispatchUsesRouting(): CheckResult {
  const violations: string[] = [];
  for (const f of [QUEUE, CONSUMER]) {
    let src: string;
    try { src = read(f); } catch { violations.push(`MISSING_FILE:${rel(f)}`); continue; }
    if (!src.includes("evaluateRoutedDemoDispatchGate")) {
      violations.push(`${rel(f)} — must import & call evaluateRoutedDemoDispatchGate (Centralized Master MT5 Bridge wiring)`);
    }
  }
  return {
    name: "master-bridge-modern-demo-dispatch-uses-routing",
    ok: violations.length === 0,
    violations,
  };
}

export function checkMasterBridgeLiveLocked(): CheckResult {
  const violations: string[] = [];
  let src: string;
  try { src = read(ADMIN_PAGE); } catch {
    return { name: "master-bridge-live-locked", ok: false, violations: [`MISSING_FILE:${rel(ADMIN_PAGE)}`] };
  }
  // Must visibly tell operator that live trading via the master bridge is off.
  if (!/live trading via master|live trading via the master|live.*disabled/i.test(src)) {
    violations.push(`${rel(ADMIN_PAGE)} — admin Master Bridge dashboard must visibly state live trading is disabled`);
  }
  return {
    name: "master-bridge-live-locked",
    ok: violations.length === 0,
    violations,
  };
}

// Strip JS/TS comments (line + block) and JSX `{/* ... */}` blocks so
// security-policy comments that LIST the forbidden field names don't
// false-positive on themselves. We only want to flag real code that
// references the secret fields.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")          // /* … */
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX {/* … */}
    .split("\n")
    .map((line) => line.replace(/(^|[^:\\\\])\/\/.*$/, "$1"))
    .join("\n");
}

export function checkMasterBridgeSecretsNotLeaked(): CheckResult {
  const violations: string[] = [];
  const forbidden: Array<{ re: RegExp; label: string }> = [
    { re: /apiKeyHash/, label: "apiKeyHash" },
    { re: /\bbridgeToken\b/, label: "bridgeToken (raw)" },
    { re: /\btokenLast4\b/, label: "tokenLast4" },
  ];
  for (const f of [ADMIN_PAGE, ME_ROUTING]) {
    let src: string;
    try { src = stripComments(read(f)); } catch { violations.push(`MISSING_FILE:${rel(f)}`); continue; }
    for (const { re, label } of forbidden) {
      if (re.test(src)) {
        violations.push(`${rel(f)} renders forbidden master-bridge field: ${label}`);
      }
    }
  }
  // The mt5-setup PlatformMasterBridgeCard subsection only — not
  // PerUserBridgeTokenCard, which legitimately shows the user's own
  // tokenLast4.
  try {
    const src = read(MT5_SETUP);
    const start = src.indexOf("function PlatformMasterBridgeCard(");
    if (start >= 0) {
      const end = src.indexOf("\nexport default function MT5SetupWizardPage", start);
      const slice = stripComments(src.slice(start, end > 0 ? end : start + 4000));
      for (const { re, label } of forbidden) {
        if (re.test(slice)) {
          violations.push(`${rel(MT5_SETUP)}/PlatformMasterBridgeCard renders forbidden field: ${label}`);
        }
      }
    } else {
      violations.push(`${rel(MT5_SETUP)} — PlatformMasterBridgeCard not found`);
    }
  } catch {
    violations.push(`MISSING_FILE:${rel(MT5_SETUP)}`);
  }
  return {
    name: "master-bridge-secrets-not-leaked",
    ok: violations.length === 0,
    violations,
  };
}
