// Regression suite for the chart-trade-no-direct-execution CI guard (#754).
//
// The chart/scanner trade actions (place, Close, partial close, break-even,
// Reverse, Cancel) must route ONLY through the Global Instant Trade Router
// (`executeInstant`). This suite exercises the shared `scanForViolations`
// scanner against synthetic instant-trade-route snippets with the chart-route
// REQUIRED anchor (executeInstant, WITHOUT the Ruby ledger boundary). The
// sanctioned path must stay clean; every direct-execution escape — direct
// command-table insert, the legacy `/api/me/trades/close` bypass, a broker
// order-send primitive, or an ALIASED import of any of those — MUST be flagged.
// Pure source analysis: no network, DB, or fs.

import {
  scanForViolations,
  type ForbiddenAlias,
  type Needle,
} from "./check-assistant-no-direct-execution.js";
import {
  SCANNER_PANEL_REQUIRED,
  SCANNER_PANEL_FORBIDDEN,
  scanForbiddenStrings,
} from "./check-chart-trade-no-direct-execution.js";

export {};

// The chart/scanner instant-trade route's sanctioned anchor: executeInstant
// only (no recordAndExecuteRuby — that boundary is assistant-specific).
const CHART_REQUIRED: Needle[] = [
  {
    rx: /\bexecuteInstant\b/,
    why: "chart/scanner trade actions must dispatch through the instant-trade router (executeInstant)",
  },
];

// A minimal sanctioned tail so the REQUIRED check is satisfied; append to any
// "stay clean" / "still flag the bypass" snippet so a failure is unambiguously
// about the forbidden scan, not a MISSING path.
const SANCTIONED = `
  const result = await executeInstant({ userId, intent, ip, ua });
`;

type Case = {
  name: string;
  src: string;
  extra?: ForbiddenAlias[];
  shouldFlag: boolean;
};

const cases: Case[] = [
  // ── Must stay CLEAN ────────────────────────────────────────────────────────
  {
    name: "sanctioned instant-router path only (executeInstant)",
    shouldFlag: false,
    src: SANCTIONED,
  },
  {
    name: "assistant ledger boundary is NOT required on the chart route",
    shouldFlag: false,
    // No recordAndExecuteRuby — must still be clean (chart route never uses it).
    src: `const r = await executeInstant({ source: "chart" });`,
  },
  {
    name: "doc-comment mentioning a forbidden table is stripped, not flagged",
    shouldFlag: false,
    src: `// never insert into arxLiveCommandsTable directly\n/* mt5CommandsTable is off-limits */\n${SANCTIONED}`,
  },
  {
    name: "the route's own /trades/instant/close path is not the legacy bypass",
    shouldFlag: false,
    src: `router.post("/trades/instant/close", h);\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — direct literal escapes ───────────────────────────────
  {
    name: "direct insert into arxLiveCommandsTable",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable } from "@workspace/db";\nawait db.insert(arxLiveCommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct insert into mt5CommandsTable",
    shouldFlag: true,
    src: `import { mt5CommandsTable } from "@workspace/db";\nawait db.insert(mt5CommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct broker order-send call",
    shouldFlag: true,
    src: `await orderSend({ symbol });\n${SANCTIONED}`,
  },
  {
    name: "direct placeLiveOrderGuarded call",
    shouldFlag: true,
    src: `await placeLiveOrderGuarded({ symbol });\n${SANCTIONED}`,
  },
  {
    name: "legacy /api/me/trades/close bypass string",
    shouldFlag: true,
    src: `await fetch("/api/me/trades/close", { method: "POST" });\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — ALIAS bypass (local + cross-file re-export) ───────────
  {
    name: "local alias of a command table caught at its usage",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable as q } from "@workspace/db";\nawait db.insert(q).values({});\n${SANCTIONED}`,
  },
  {
    name: "imported re-export alias of an order-send primitive",
    shouldFlag: true,
    extra: [{ id: "sendItNow", kind: "fn", origin: "artifacts/api-server/src/lib/reexport.ts" }],
    src: `import { sendItNow } from "../lib/reexport.js";\nawait sendItNow({ symbol });\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — sanctioned path removed ──────────────────────────────
  {
    name: "missing executeInstant is flagged",
    shouldFlag: true,
    src: `const noop = 1;\n`,
  },
];

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}

for (const c of cases) {
  const flags = scanForViolations(c.src, c.extra ?? [], CHART_REQUIRED);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    c.name,
    ok,
    ok
      ? c.shouldFlag
        ? `flagged (${flags.length})`
        : "clean"
      : c.shouldFlag
        ? "expected a violation but got none"
        : `expected clean but got: ${flags[0]}`,
  );
}

// ── Task #764 — FE drag-submit surface (ScannerChartPanel) ───────────────────
// The drag path MUST call executeInstantTrade and tag source "chart_drag", and
// must never POST to a broker command queue / legacy close / order-send. These
// cases exercise the FE-side REQUIRED (via scanForViolations) and the
// raw-endpoint FORBIDDEN scan (scanForbiddenStrings) the guard layers on.

// REQUIRED present + no raw bypass → clean.
{
  const src = `
    const res = await executeInstantTrade({ source: "chart_drag", action: "MODIFY_SL_TP", positionId: m.ticket, newStopLoss: m.sl, newTakeProfit: m.tp });
  `;
  const req = scanForViolations(src, [], SCANNER_PANEL_REQUIRED);
  const forb = scanForbiddenStrings(src, SCANNER_PANEL_FORBIDDEN);
  record(
    "FE: sanctioned drag-submit (executeInstantTrade + chart_drag) stays clean",
    req.length === 0 && forb.length === 0,
    req.length === 0 && forb.length === 0 ? "clean" : `unexpected: ${[...req, ...forb][0]}`,
  );
}

// Missing the chart_drag source tag → flagged as MISSING sanctioned path.
{
  const src = `const res = await executeInstantTrade({ source: "chart", action: "CLOSE" });`;
  const req = scanForViolations(src, [], SCANNER_PANEL_REQUIRED);
  record(
    "FE: drag-submit without source \"chart_drag\" is flagged",
    req.length > 0,
    req.length > 0 ? `flagged (${req.length})` : "expected a violation but got none",
  );
}

// Raw legacy-close bypass on the FE → flagged.
{
  const src = `await fetch("/api/me/trades/close", { method: "POST" });`;
  const forb = scanForbiddenStrings(src, SCANNER_PANEL_FORBIDDEN);
  record(
    "FE: legacy /api/me/trades/close bypass is flagged",
    forb.length > 0,
    forb.length > 0 ? `flagged (${forb.length})` : "expected a violation but got none",
  );
}

// Raw broker command-queue POST on the FE → flagged.
{
  const src = `await fetch("/api/mt5/command-result", { method: "POST" });`;
  const forb = scanForbiddenStrings(src, SCANNER_PANEL_FORBIDDEN);
  record(
    "FE: direct /api/mt5/command-result POST is flagged",
    forb.length > 0,
    forb.length > 0 ? `flagged (${forb.length})` : "expected a violation but got none",
  );
}

// A forbidden endpoint mentioned ONLY in a comment is stripped, not flagged.
{
  const src = `// never POST to /api/me/trades/close from here\nconst ok = true;`;
  const forb = scanForbiddenStrings(src, SCANNER_PANEL_FORBIDDEN);
  record(
    "FE: forbidden endpoint in a comment is stripped, not flagged",
    forb.length === 0,
    forb.length === 0 ? "clean" : `expected clean but got: ${forb[0]}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} chart-trade-guard tests passed`);
process.exit(failed === 0 ? 0 : 1);
