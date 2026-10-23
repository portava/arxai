// Static-source guard: the LIVE execution surface must stay LIVE-only.
//
// This test FAILS the build if demo/paper/sim wording or demo-pushing copy
// leaks back into the user-facing live trade surface, or if the scanner
// stops routing a LIVE_SHARED account to the live ticket by account MODE.
//
// Why a static scan: a live account must never be shown demo wording or be
// dumped into the demo order body on a transient bridge block. These are
// copy/routing invariants that have regressed before and are invisible to
// runtime tests when the live path isn't exercised.
//
// Run: pnpm --filter @workspace/scripts run test:live-surface-no-demo

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FE = resolve(here, "../../artifacts/trading-dashboard/src");

function read(rel: string): string {
  return readFileSync(resolve(FE, rel), "utf8");
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`[${name}] ${detail ?? "assertion failed"}`);
}

// ── 1. LiveSharedTradeTicket — the live execution surface ──────────────
// It must NOT contain demo-pushing copy. A blocked live user is told to
// contact their operator, never to "use Demo mode".
const liveTicket = read("components/live/LiveSharedTradeTicket.tsx");

// Forbidden demo-pushing phrases in the LIVE ticket's user copy.
const FORBIDDEN_DEMO_COPY = [
  "use Demo mode",
  "switch to Demo",
  "try Demo",
  "Demo mode instead",
  "fall back to Demo",
  "Paper mode instead",
];
for (const phrase of FORBIDDEN_DEMO_COPY) {
  check(
    `live-ticket forbids "${phrase}"`,
    !liveTicket.includes(phrase),
    `LiveSharedTradeTicket.tsx still contains demo-pushing copy "${phrase}"`,
  );
}

// The live ticket's pending-access block must point at the operator.
check(
  "live-ticket pending-access points at operator",
  liveTicket.includes("Contact your operator"),
  "expected 'Contact your operator' in the live-access-pending block",
);

// ── 2. ScannerTradeModal — LIVE_SHARED routes by MODE, not only canTrade ──
// A live account must reach the live ticket even when canTrade is a
// transient false; otherwise it is dumped into the DEMO order body.
const scannerModal = read("components/scanner/ScannerTradeModal.tsx");
check(
  "scanner routes LIVE_SHARED by account mode",
  scannerModal.includes("tradingMode.isLiveShared"),
  "ScannerTradeModal.tsx must route LIVE_SHARED accounts via tradingMode.isLiveShared (mode), not canTrade alone",
);
check(
  "scanner imports useTradingMode",
  scannerModal.includes("useTradingMode"),
  "ScannerTradeModal.tsx must consume useTradingMode for mode-based routing",
);
// The live-shared branch must render the live ticket, not the demo body.
{
  const liveBranch = scannerModal.indexOf("tradingMode.isLiveShared");
  const ticketAfter = scannerModal.indexOf("LiveSharedTradeTicket", liveBranch);
  check(
    "scanner live branch renders the live ticket",
    liveBranch >= 0 && ticketAfter > liveBranch && (ticketAfter - liveBranch) < 600,
    "the LIVE_SHARED routing branch must return <LiveSharedTradeTicket>",
  );
}

// ── 3. SafetyHeader — Sim Engine badge never shows on a live account ──────
const safetyHeader = read("components/ss/SafetyHeader.tsx");
check(
  "Sim Engine badge gated off LIVE_SHARED",
  safetyHeader.includes("simRunning && !mode.isLiveShared"),
  "the Sim Engine badge must be gated with `simRunning && !mode.isLiveShared` so it never shows on a live surface",
);

// ── 4. Market scanner — auto-scan button uses the clear label ─────────────
const scannerPage = read("pages/market-scanner.tsx");
check(
  "scanner uses 'Start Auto Scan' label",
  scannerPage.includes("Start Auto Scan"),
  "the auto-scan button must read 'Start Auto Scan'",
);
check(
  "scanner no longer uses bare 'Start auto'",
  !scannerPage.includes(">Start auto<") && !scannerPage.includes('"Start auto"'),
  "found leftover bare 'Start auto' label",
);
check(
  "scanner recent-trades description is mode-neutral",
  !scannerPage.includes("Demo commands the scanner pushed"),
  "the recent-trades section description still hardcodes 'Demo commands'",
);

// ── 5. RecentScannerTrades — title reflects real mode, not always Demo ────
const recentTrades = read("components/scanner/RecentScannerTrades.tsx");
check(
  "recent-trades title is mode-accurate (live)",
  recentTrades.includes("Recent Scanner Trades — Live Shared"),
  "expected a Live Shared title branch",
);
check(
  "recent-trades title no longer defaults paper to Demo",
  recentTrades.includes("mode.isDemo"),
  "title must branch on mode.isDemo so paper/other modes are not mislabelled 'Demo'",
);

console.log(`live-surface demo-wording guard: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
