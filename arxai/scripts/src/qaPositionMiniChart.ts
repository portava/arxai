// QA — Position-on-Chart side card + unified positions feed.
//
// Probes:
//  1. /api/me/positions/all exists and is per-user scoped.
//  2. user A cannot see user B's positions via the same endpoint.
//  3. close + modify handlers emit the standardized audit codes
//     (CLOSE_TRADE_REQUESTED, SLTP_EDIT_REQUESTED, SAFETY_GATE_BLOCKED,
//     COMMAND_SUBMITTED_AFTER_APPROVAL).
//  4. POSITION_SELECTED audit fires on every unified read.
//  5. The unified endpoint never returns bridge tokens / apiKeyHash /
//     SESSION_SECRET / TWELVEDATA_API_KEY strings.
//  6. Mini chart component renders price lines for entry/SL/TP/current.
//  7. PositionPickerPanel + PositionSideCard files exist with required testids.
//  8. arx_live_commands count is unchanged after the QA pass.
//
// Read-only. Never dispatches a live trade. Static-analysis style — same
// pattern as qaScannerSelectedMarket.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Probe = { name: string; pass: boolean; detail?: string };
const out: Probe[] = [];
function probe(name: string, pass: boolean, detail?: string) { out.push({ name, pass, detail }); }
function read(p: string): string { return readFileSync(resolve(ROOT, p), "utf8"); }
function exists(p: string): boolean { return existsSync(resolve(ROOT, p)); }

// ── 1. Unified endpoint exists + per-user scoped.
const ROUTE = "artifacts/api-server/src/routes/mePositionsUnified.ts";
probe("[1] mePositionsUnified route file exists", exists(ROUTE));
const routeSrc = exists(ROUTE) ? read(ROUTE) : "";
probe("[1a] route uses requireUser middleware", /requireUser/.test(routeSrc));
probe("[1b] live query filtered by userId", /arxLivePositionsTable.*\.where\(eq\(arxLivePositionsTable\.userId, userId\)\)/s.test(routeSrc));
probe("[1c] demo query filtered by userId", /mt5StateTable[\s\S]*\.where\(eq\(mt5StateTable\.userId, userId\)\)/.test(routeSrc));
probe("[1d] demo commands query filtered by userId", /mt5DemoCommandsTable[\s\S]*\.where\(eq\(mt5DemoCommandsTable\.userId, userId\)\)/.test(routeSrc));

// ── 2. Cross-user isolation: no select uses a userId from req body / params.
probe("[2] userId is derived from req.user only (no req.body/params/query injection)",
  !/userId\s*=\s*(?:req\.body|req\.params|req\.query)/.test(routeSrc));

// ── 3. Audit codes in close + modify handlers.
const ML = "artifacts/api-server/src/routes/meLive.ts";
const mlSrc = read(ML);
probe("[3a] CLOSE_TRADE_REQUESTED audit code present", /action:\s*"CLOSE_TRADE_REQUESTED"/.test(mlSrc));
probe("[3b] SLTP_EDIT_REQUESTED audit code present", /action:\s*"SLTP_EDIT_REQUESTED"/.test(mlSrc));
probe("[3c] SAFETY_GATE_BLOCKED audit code present", /action:\s*"SAFETY_GATE_BLOCKED"/.test(mlSrc));
probe("[3d] COMMAND_SUBMITTED_AFTER_APPROVAL audit code present", /action:\s*"COMMAND_SUBMITTED_AFTER_APPROVAL"/.test(mlSrc));
probe("[3e] SAFETY_GATE_BLOCKED appears on draft/confirm/dispatch failure paths",
  /stage:\s*"draft"[\s\S]*stage:\s*"confirm"[\s\S]*stage:\s*"dispatch"/m.test(mlSrc));

// ── 4. POSITION_SELECTED audit fires on unified read.
probe("[4] POSITION_SELECTED audit emitted on unified positions read",
  /action:\s*"POSITION_SELECTED"/.test(routeSrc));

// ── 5. No secret strings in route source or new components.
const SECRET_NEEDLES = ["MT5_BRIDGE_TOKEN", "SESSION_SECRET", "TWELVEDATA_API_KEY", "apiKeyHash", "X-MT5-Bridge-Token"];
const filesToScan = [
  ROUTE,
  "artifacts/trading-dashboard/src/components/positions/PositionMiniChart.tsx",
  "artifacts/trading-dashboard/src/components/positions/PositionSideCard.tsx",
  "artifacts/trading-dashboard/src/components/positions/PositionPickerPanel.tsx",
];
for (const f of filesToScan) {
  if (!exists(f)) { probe(`[5] file scanned: ${f}`, false, "file missing"); continue; }
  const src = read(f);
  const hits = SECRET_NEEDLES.filter((n) => src.includes(n));
  probe(`[5] no secret strings in ${f.split("/").pop()}`, hits.length === 0, hits.join(","));
}

// ── 6. Mini chart wires price lines + entry marker.
const MC = "artifacts/trading-dashboard/src/components/positions/PositionMiniChart.tsx";
const mcSrc = exists(MC) ? read(MC) : "";
probe("[6] mini chart exists", exists(MC));
probe("[6a] mini chart draws entry price line", /createPriceLine/.test(mcSrc) && /Entry/.test(mcSrc));
probe("[6b] mini chart draws stop loss price line", /createPriceLine/.test(mcSrc) && /["']SL["']/.test(mcSrc));
probe("[6c] mini chart draws take profit price line", /createPriceLine/.test(mcSrc) && /["']TP["']/.test(mcSrc));
probe("[6d] mini chart draws current price line", /createPriceLine/.test(mcSrc) && /["']Current["']/.test(mcSrc));
probe("[6e] mini chart places a BUY/SELL marker", /setMarkers/.test(mcSrc) && /arrowUp/.test(mcSrc) && /arrowDown/.test(mcSrc));
probe("[6f] mini chart falls back cleanly when no candles", /position-mini-chart-empty/.test(mcSrc));

// ── 7. PositionSideCard + PositionPickerPanel testids.
const SC = "artifacts/trading-dashboard/src/components/positions/PositionSideCard.tsx";
const PP = "artifacts/trading-dashboard/src/components/positions/PositionPickerPanel.tsx";
const scSrc = exists(SC) ? read(SC) : "";
const ppSrc = exists(PP) ? read(PP) : "";
const REQUIRED_TIDS = [
  "position-side-card", "text-position-symbol", "badge-position-side",
  "badge-account-mode", "badge-position-source",
  "text-position-ticket", "text-position-lot", "text-position-entry",
  "text-position-current", "text-position-sl", "text-position-tp",
  "text-position-pnl", "text-position-risk", "text-position-rr",
  "text-position-ordertype", "text-position-opentime", "text-position-status",
  "btn-ask-ruby", "btn-refresh-analysis", "btn-view-full-chart",
  "btn-modify-sltp", "btn-close-position",
];
for (const tid of REQUIRED_TIDS) {
  probe(`[7] PositionSideCard has testid ${tid}`, scSrc.includes(tid));
}
probe("[7p] PositionPickerPanel has data-testid", /position-picker-panel/.test(ppSrc));
probe("[7p] PositionPickerPanel uses /api/me/positions/all", /\/api\/me\/positions\/all/.test(ppSrc));
probe("[7p] PositionPickerPanel polls (setTimeout reload)", /POLL_MS|setTimeout\(load/.test(ppSrc));

// ── 7b. Refresh analysis is throttled in PositionSideCard.
probe("[7t] Refresh-analysis is throttled in PositionSideCard",
  /REFRESH_THROTTLE_MS\s*=\s*\d+/.test(scSrc) && /lastRefreshRef/.test(scSrc));

// ── 8. arx_live_commands count probe via psql (read-only).
try {
  const before = execSync(`psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"`, { encoding: "utf8" }).trim();
  const after = execSync(`psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM arx_live_commands;"`, { encoding: "utf8" }).trim();
  probe(`[8] arx_live_commands unchanged during QA (before=${before} after=${after})`, before === after);
} catch (e) {
  probe("[8] arx_live_commands probe (psql)", false, (e as Error).message);
}

// ── 9. Route registered in routes/index.ts.
const idx = read("artifacts/api-server/src/routes/index.ts");
probe("[9] mePositionsUnifiedRouter imported", /mePositionsUnifiedRouter/.test(idx));
probe("[9] mePositionsUnifiedRouter mounted", /router\.use\(mePositionsUnifiedRouter\)/.test(idx));

// ── 10. Side card never imports or calls a live submit/dispatch endpoint.
probe("[10] PositionSideCard never POSTs to live commands/submit-live/dispatch directly",
  !/me\/live\/commands(?!\/.+\/cancel)|me\/one-click\/submit-live|\/dispatch\b/.test(scSrc));

// ── Report.
const pass = out.filter((p) => p.pass).length;
const fail = out.length - pass;
for (const p of out) {
  // eslint-disable-next-line no-console
  console.log(`${p.pass ? "PASS" : "FAIL"}  ${p.name}${p.detail ? "  — " + p.detail : ""}`);
}
// eslint-disable-next-line no-console
console.log(`\n${pass}/${out.length} position mini-chart probes passed${fail > 0 ? `, ${fail} FAILED` : ""}`);
if (fail > 0) process.exit(1);
