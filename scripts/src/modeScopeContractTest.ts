// T006 — mode-scope filter contract test.
//
// Static + router-shape assertions that the shared mode-scope helper
// exists and the user-facing data endpoints are mode-aware. Does NOT
// place trades, does NOT insert into arx_live_commands, does NOT touch
// the live broker pipeline or master switch.
//
// What we verify:
//   PART A  — getUserModeScope helper exists and has the expected shape
//   PART B  — /api/live-intent/queue is admin-gated for normal users
//   PART C  — /api/me/positions/all honours mode scope + ?mode= flag
//   PART D  — /api/me/performance-calendar returns empty in LIVE_SHARED
//   PART E  — /api/me/trades/* returns empty for PAPER
//   PART F  — /api/performance/calendar (global aggregator) short-circuits
//             for LIVE_SHARED via isLiveSharedSession()
//   PART G  — arx_live_commands import invariant — this test never imports
//             the live pipeline

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function record(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else    { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const __thisDir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__thisDir, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

console.log("\nPART A — getUserModeScope helper shape (static)");
const helperPath = "artifacts/api-server/src/lib/modeScope/getUserModeScope.ts";
const helperSrc = read(helperPath);
record("helper file exists at expected path", helperSrc.length > 0);
record("helper exports getUserModeScope async function",
  /export\s+async\s+function\s+getUserModeScope\s*\(/.test(helperSrc));
record("helper exports modeScopeEnvelope function",
  /export\s+function\s+modeScopeEnvelope\s*\(/.test(helperSrc));
record("helper reuses T003 precedence (computeAccountModePrecedence)",
  helperSrc.includes("computeAccountModePrecedence"));
record("helper has safe PAPER fallback in catch",
  /catch\b[\s\S]*currentAccountMode:\s*"PAPER"/.test(helperSrc));

console.log("\nPART B — /live-intent/* admin gating");
const liSrc = read("artifacts/api-server/src/routes/liveIntent.ts");
record("live-intent/queue checks role for admin-only access",
  liSrc.includes("ADMIN") && liSrc.includes("OWNER") && liSrc.includes("modeScopeApplied"));
record("live-intent/queue returns empty intents array for non-admin",
  liSrc.includes("intents: []") && liSrc.includes("scopeNote"));
record("live-intent/queue does NOT broaden by removing the gate (sanity)",
  /if\s*\(\s*!isAdmin\s*\)/.test(liSrc));
// /live-intent/:id is the second leak surface flagged by architect: a global
// ID lookup against a table with no userId column. Verify it now admin-gates.
const idRouteMatch = liSrc.match(/router\.get\("\/live-intent\/:id"[\s\S]*?\n\}\);/);
record("/live-intent/:id route exists in source", !!idRouteMatch);
record("/live-intent/:id admin-gates non-admin callers",
  !!idRouteMatch && /role\s*===\s*"ADMIN"/.test(idRouteMatch![0]) && /if\s*\(\s*!isAdmin\s*\)/.test(idRouteMatch![0]));

console.log("\nPART C — /me/positions/all mode scope");
const posSrc = read("artifacts/api-server/src/routes/mePositionsUnified.ts");
record("positions/all imports getUserModeScope",
  posSrc.includes("getUserModeScope"));
// The route returns `currentAccountMode` and `modeScopeApplied: true` either
// inline OR via the `modeScopeEnvelope(scope)` spread helper. Either form
// is acceptable — what matters is that both fields reach the client.
record("positions/all exposes currentAccountMode + modeScopeApplied",
  (posSrc.includes("currentAccountMode: scope.currentAccountMode") || posSrc.includes("modeScopeEnvelope(scope)"))
  && (posSrc.includes("modeScopeApplied: true") || posSrc.includes("modeScopeEnvelope(scope)")));
record("positions/all conditionally reads arx_live_positions via includeLive",
  posSrc.includes("includeLive") && posSrc.includes("? await db.select().from(arxLivePositionsTable)"));
record("positions/all conditionally reads mt5_state via includeDemo",
  posSrc.includes("includeDemo"));

console.log("\nPART D — /me/performance-calendar LIVE_SHARED short-circuit");
const calSrc = read("artifacts/api-server/src/routes/mePerformanceCalendar.ts");
record("performance-calendar imports getUserModeScope",
  calSrc.includes("getUserModeScope"));
record("performance-calendar returns empty days[] in LIVE_SHARED",
  /currentAccountMode === "LIVE_SHARED"/.test(calSrc) && calSrc.includes("days: []"));
record("performance-summary returns zero state in LIVE_SHARED",
  calSrc.includes("totalTrades: 0") && calSrc.includes("modeScopeApplied: true"));
// /me/performance-calendar/:date was the second gap the architect flagged.
const dayRouteMatch = calSrc.match(/router\.get\("\/me\/performance-calendar\/:date"[\s\S]*?\n\}\);/);
record("/me/performance-calendar/:date exists", !!dayRouteMatch);
record("/me/performance-calendar/:date short-circuits LIVE_SHARED",
  !!dayRouteMatch && /currentAccountMode === "LIVE_SHARED"/.test(dayRouteMatch![0]) && /trades:\s*\[\]/.test(dayRouteMatch![0]));

console.log("\nPART E — /me/trades/* PAPER short-circuit");
const trSrc = read("artifacts/api-server/src/routes/meTrades.ts");
record("trades route imports getUserModeScope",
  trSrc.includes("getUserModeScope"));
record("trades/open returns empty cards for PAPER",
  /currentAccountMode === "PAPER"/.test(trSrc) && trSrc.includes("cards: []"));
record("trades/history returns empty rows for PAPER",
  trSrc.includes("rows: []") && trSrc.includes("currentAccountMode: \"PAPER\""));
record("trades/summary returns zero counts for PAPER",
  trSrc.includes("openCount: 0, openPnl: 0"));

console.log("\nPART F — global /performance/calendar LIVE_SHARED guard");
const pccSrc = read("artifacts/api-server/src/routes/performanceCommandCenter.ts");
record("performanceCommandCenter imports getUserModeScope",
  pccSrc.includes("getUserModeScope"));
record("isLiveSharedSession helper exists",
  pccSrc.includes("async function isLiveSharedSession"));
record("/performance/calendar checks isLiveSharedSession before aggregating",
  /await isLiveSharedSession\(req\)/.test(pccSrc));

console.log("\nPART G — arx_live_commands invariant");
const PIPELINE = ["live", "Command", "Pipeline"].join("");
const ARX_LIVE = ["arx", "_live_", "commands"].join("");
record("helper does not import live pipeline",
  !helperSrc.includes(PIPELINE) && !helperSrc.includes("createLiveDraft"));
record("helper does not write to arx_live_commands",
  !helperSrc.includes("arxLiveCommands") && !helperSrc.includes(ARX_LIVE));
// The read-only mode-scope routes must never reach the live dispatch pipeline.
// meTrades is the ONE sanctioned exception: it gained a live-CLOSE / ops
// dispatch path (a close always reduces risk and is routed through the SAME
// 18-gate dispatchLiveCommand as any other live command). It is excluded from
// the blanket check here and pinned by the dedicated assertion below so the
// exception stays narrow (close/ops only, never a generic open-draft creator).
record("read-only mode-scope routes do not import the live dispatch pipeline",
  !liSrc.includes(PIPELINE) && !calSrc.includes(PIPELINE)
   && !pccSrc.includes(PIPELINE) && !posSrc.includes(PIPELINE));
record("meTrades pipeline use is confined to the live-CLOSE / ops dispatch path",
  !trSrc.includes("createLiveDraft(") && trSrc.includes("dispatchLiveCommand"));

const total = pass + fail;
console.log(`\nSummary: ${pass}/${total} PASS${fail ? ` · ${fail} FAIL` : ""}`);
if (fail > 0) process.exit(1);
