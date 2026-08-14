// CI guard — chart-trade-no-direct-execution (Task #754, extended #764).
//
// Sibling of the assistant-no-direct-execution guard (#750/#755). The
// chart/scanner trade actions (place, Close, partial close, break-even,
// Reverse, Cancel, and — Task #764 — drag-to-modify SL/TP) are ANOTHER
// live-trade entry point. Every one of them MUST route through the Global
// Instant Trade Router (`executeInstant` on the backend, `executeInstantTrade`
// on the frontend) → live command pipeline → 18-gate Phase B dispatch.
//
// This guard locks the no-second-execution-path invariant on BOTH ends of the
// chart surface:
//
//   1. Backend route `artifacts/api-server/src/routes/instantTrade.ts` — the
//      single handler for these actions — must dispatch through `executeInstant`
//      and must NEVER insert directly into a broker command table (mt5 demo/live
//      command queues, arx live commands), call the legacy `/api/me/trades/close`
//      bypass, or call a broker order-send primitive directly.
//
//   2. Frontend `ScannerChartPanel.tsx` — where the SL/TP drag interaction lives
//      (Task #764) — must submit drags through `executeInstantTrade({ source:
//      "chart_drag", ... })` and must NEVER POST to a broker command queue /
//      legacy close bypass / order-send primitive itself. A future edit that
//      tried to open a quiet client-side bypass on the drag path fails the build.
//
// It reuses the assistant guard's hardened, provenance-aware scanner and
// cross-file re-export alias resolution (local `as` aliases, cross-file
// re-export aliases, fail-closed on unresolvable provenance) for the symbol/
// import surface, plus a small comment-stripped endpoint-string scan for the FE
// raw-fetch bypass tokens that never appear as imported symbols.
import { join } from "node:path";
import { ROOT, read, rel, reportResult, type CheckResult } from "./_lib.js";
import {
  scanForViolations,
  collectReexportAliases,
  type Needle,
} from "./check-assistant-no-direct-execution.js";

// The chart/scanner trade-action route handlers. The frontend chart/scanner
// surfaces call `executeInstantTrade({ source: "chart" | "chart_drag", ... })`,
// which posts to `POST /api/trades/instant/*`; this is the single backend
// handler for those actions.
const CHART_TRADE_ROUTE = "artifacts/api-server/src/routes/instantTrade.ts";

// The frontend chart surface that owns the SL/TP drag interaction (Task #764).
const SCANNER_PANEL_FILE =
  "artifacts/trading-dashboard/src/components/scanner/ScannerChartPanel.tsx";

// The sanctioned execution path the chart/scanner route MUST contain. Unlike
// the assistant route there is no Ruby ledger boundary here — the router calls
// the instant-trade dispatcher directly.
const CHART_REQUIRED: Needle[] = [
  {
    rx: /\bexecuteInstant\b/,
    why: "chart/scanner trade actions must dispatch through the instant-trade router (executeInstant)",
  },
];

// The sanctioned path the FE drag-submit MUST contain: it has to call the
// router AND tag the call `source: "chart_drag"` so the backend routes + audits
// the drag as a chart drag (and so this guard proves the drag path is wired to
// the router rather than some other client-side write).
export const SCANNER_PANEL_REQUIRED: Needle[] = [
  {
    rx: /\bexecuteInstantTrade\b/,
    why: "ScannerChartPanel SL/TP drag-modify must submit through the instant-trade router (executeInstantTrade)",
  },
  {
    rx: /source:\s*["']chart_drag["']/,
    why: 'the SL/TP drag-submit must tag its router call with source "chart_drag" so the backend routes + audits it as a chart drag',
  },
];

// FE raw-endpoint / primitive bypass tokens that the chart drag path must NEVER
// reach directly. These are string endpoints / table names that would appear in
// a hand-rolled client bypass but never as a legitimately imported symbol on the
// FE, so they complement the import-aware BASE_FORBIDDEN scan in
// `scanForViolations`.
export const SCANNER_PANEL_FORBIDDEN: Needle[] = [
  {
    rx: /\/api\/me\/trades\/close\b/,
    why: "legacy close bypass — the drag path must route through the instant-trade router, not the legacy close endpoint",
  },
  {
    rx: /\/api\/mt5\/command(?:-result)?\b/,
    why: "direct MT5 command-queue endpoint — the drag path must never POST to the broker command queue",
  },
  {
    rx: /\b(?:mt5_commands|mt5_demo_commands|arx_live_commands)\b/,
    why: "direct broker command-table reference — the drag path must never write a command table",
  },
  {
    rx: /\b(?:placeLiveOrderGuarded|orderSend)\b/,
    why: "direct broker order-send primitive — the drag path must never call order-send",
  },
];

// Comment-stripped, position-preserving scan for raw-string forbidden tokens.
// Block comments are blanked to spaces (newlines preserved) and whole-line `//`
// comments are blanked, so a token mentioned only in a comment never trips the
// guard while reported line/col still point at real code.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

export function scanForbiddenStrings(src: string, forbidden: Needle[]): string[] {
  const stripped = stripComments(src);
  const out: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const { rx, why } of forbidden) {
      const m = rx.exec(line);
      if (m !== null) {
        out.push(
          `:${i + 1}:${m.index + 1} [${why}] off-limits \`${m[0].trim()}\` → ${line.trim().slice(0, 120)}`,
        );
      }
    }
  });
  return out;
}

export function checkChartTradeNoDirectExecution(): CheckResult {
  const routeAbs = join(ROOT, CHART_TRADE_ROUTE);
  const panelAbs = join(ROOT, SCANNER_PANEL_FILE);

  let routeSrc: string;
  try {
    routeSrc = read(routeAbs);
  } catch {
    return {
      name: "chart-trade-no-direct-execution",
      ok: false,
      violations: [
        `${CHART_TRADE_ROUTE}: cannot read (chart/scanner instant-trade route is missing)`,
      ],
    };
  }

  let panelSrc: string;
  try {
    panelSrc = read(panelAbs);
  } catch {
    return {
      name: "chart-trade-no-direct-execution",
      ok: false,
      violations: [
        `${SCANNER_PANEL_FILE}: cannot read (Scanner chart panel with the SL/TP drag surface is missing)`,
      ],
    };
  }

  const { aliases, integrity } = collectReexportAliases();

  const violations: string[] = [];

  // 1. Backend route — sanctioned dispatch present + no command-table / order-send
  //    laundering (import-aware, provenance-resolved).
  for (const v of scanForViolations(routeSrc, aliases, CHART_REQUIRED)) {
    violations.push(`${CHART_TRADE_ROUTE}${v}`);
  }

  // 2. FE drag surface — sanctioned router call + chart_drag source present, no
  //    imported command-table / order-send symbol, and no raw-endpoint bypass.
  for (const v of scanForViolations(panelSrc, aliases, SCANNER_PANEL_REQUIRED)) {
    violations.push(`${SCANNER_PANEL_FILE}${v}`);
  }
  for (const v of scanForbiddenStrings(panelSrc, SCANNER_PANEL_FORBIDDEN)) {
    violations.push(`${SCANNER_PANEL_FILE}${v}`);
  }

  // Curation rot is a guard-integrity failure: provenance can no longer be
  // trusted, so fail loudly rather than silently under-ban.
  for (const issue of integrity) {
    violations.push(`FORBIDDEN_ORIGINS integrity: ${issue}`);
  }

  return {
    name: "chart-trade-no-direct-execution (chart/scanner actions incl. SL/TP drag route ONLY through the instant-trade router, never a 2nd execution path)",
    ok: violations.length === 0,
    violations,
    notes: [
      `scanned ${rel(routeAbs)}`,
      `scanned ${rel(panelAbs)}`,
      `provenance-resolved re-export alias bindings: ${aliases.length}`,
      `curated forbidden-origin integrity issues: ${integrity.length}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkChartTradeNoDirectExecution();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
