import { read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

// check-live-ai-harness-honesty — Feature Truth Audit guard.
//
// Locks three contracts around the admin/dev live-intent test harness and the
// investor UI:
//
//  1. /live-ai-auto-test stays honest: the page source must contain the
//     audit-only banner, and must NOT contain Math.random (fake generated
//     results) or a hardcoded "Risk governor: active" style state.
//  2. /live-ai-auto-test (and its aliases /ai-autopilot, /ai-decisions) stays
//     admin/dev-only: none of those paths may appear in the NORMAL_USER_EXACT
//     allowlist in routeAccess.ts (route containment).
//  3. Investor portal UI cannot import live execution writers: investor.tsx
//     must never import the instant trade router or the live trade ticket, and
//     must never call a live execution endpoint.

const HARNESS_PAGE = "artifacts/trading-dashboard/src/pages/live-ai-auto-test.tsx";
const ROUTE_ACCESS = "artifacts/trading-dashboard/src/lib/routeAccess.ts";
const INVESTOR_PAGE = "artifacts/trading-dashboard/src/pages/investor.tsx";

const HARNESS_ROUTES = ["/live-ai-auto-test", "/ai-autopilot", "/ai-decisions"];

// Live execution surfaces the investor UI must never touch.
const INVESTOR_FORBIDDEN = [
  "instantTradeRouter",
  "executeInstantTrade",
  "LiveSharedTradeTicket",
  "/api/live-intent/submit",
  "/api/me/live/commands",
  "/api/me/trades/instant",
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function checkLiveAiHarnessHonesty(): CheckResult {
  const violations: string[] = [];

  // ---- 1. Harness page honesty --------------------------------------------
  const pagePath = join(ROOT, HARNESS_PAGE);
  if (!existsSync(pagePath)) {
    violations.push(`${HARNESS_PAGE} is missing — the harness page must exist (keep + fix, not delete).`);
  } else {
    const pageSrc = stripComments(read(pagePath));
    if (/Math\.random/.test(pageSrc)) {
      violations.push(`${HARNESS_PAGE} uses Math.random — fake generated results are forbidden on this page.`);
    }
    if (/Risk governor[\s\S]{0,80}?["'`]active["'`]|>active</.test(pageSrc) && !/risk-check-state/.test(pageSrc)) {
      violations.push(`${HARNESS_PAGE} hardcodes a risk-governor "active" state instead of server-derived truth.`);
    }
    if (!pageSrc.includes("audit-only-banner")) {
      violations.push(`${HARNESS_PAGE} lost its audit-only admin/dev banner (data-testid="audit-only-banner").`);
    }
    if (!/accepted=false|accepted: false|accepted:false/.test(pageSrc)) {
      violations.push(`${HARNESS_PAGE} no longer explains that the endpoint always returns accepted=false.`);
    }
  }

  // ---- 2. Route containment ------------------------------------------------
  const raPath = join(ROOT, ROUTE_ACCESS);
  const raSrc = read(raPath);
  const exactBlock = raSrc.match(/NORMAL_USER_EXACT[\s\S]*?\]\)/)?.[0] ?? "";
  if (!exactBlock) {
    violations.push(`${ROUTE_ACCESS}: could not locate the NORMAL_USER_EXACT allowlist block.`);
  } else {
    for (const route of HARNESS_ROUTES) {
      if (exactBlock.includes(`"${route}"`)) {
        violations.push(`${ROUTE_ACCESS}: ${route} appears in NORMAL_USER_EXACT — the harness must stay admin/dev-only.`);
      }
    }
  }

  // ---- 3. Investor UI cannot reach live execution --------------------------
  const invPath = join(ROOT, INVESTOR_PAGE);
  if (existsSync(invPath)) {
    const invSrc = stripComments(read(invPath));
    for (const token of INVESTOR_FORBIDDEN) {
      if (invSrc.includes(token)) {
        violations.push(`${rel(invPath)} references "${token}" — investor UI must never touch live execution surfaces.`);
      }
    }
  }

  return {
    name: "live-ai-harness-honesty",
    ok: violations.length === 0,
    violations,
    notes: [
      "The /live-ai-auto-test harness must stay admin/dev-only, audit-only, and honest:",
      "  - no Math.random-driven displayed results, no hardcoded risk-governor state,",
      "  - the audit-only banner and accepted=false explanation must remain,",
      "  - its routes must never enter NORMAL_USER_EXACT,",
      "  - investor.tsx must never import/call live execution surfaces.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLiveAiHarnessHonesty();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
