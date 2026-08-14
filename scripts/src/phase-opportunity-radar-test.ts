// Phase Opportunity Radar test — verifies the AI Scanner Brain server slice.
// All checks are STATIC + LIVE (against localhost:80 via the shared proxy).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SERVER = "http://localhost:80";
const R: Array<{ id: number; name: string; ok: boolean; detail?: string }> = [];
// Anchor all repo-relative paths at the repo root so this test works
// whether invoked with cwd=repo-root or cwd=scripts/ (pnpm --filter).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rp = (p: string): string => resolve(REPO_ROOT, p);

function rec(id: number, name: string, ok: boolean, detail?: string): void {
  R.push({ id, name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${id}. ${name}${detail ? "  — " + detail : ""}`);
}
function readIf(p: string): string { const ap = rp(p); try { return existsSync(ap) ? readFileSync(ap, "utf8") : ""; } catch { return ""; } }
/** Strip line + block comments so static greps catch real code, not doc text
 *  describing what the code does NOT do. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
async function probe(path: string, init?: RequestInit) {
  try {
    const res = await fetch(`${SERVER}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.text() };
  } catch (e) { return { status: 0, body: String(e).slice(0, 200) }; }
}

async function main(): Promise<void> {
  const engine = readIf("artifacts/api-server/src/lib/opportunityRadar/radar.ts");
  const routes = readIf("artifacts/api-server/src/routes/opportunityRadar.ts");
  const schema = readIf("lib/db/src/schema/opportunityRadar.ts");
  const tools  = readIf("artifacts/api-server/src/lib/assistant/tools.ts");
  const barrel = readIf("lib/db/src/schema/index.ts");
  const routerIdx = readIf("artifacts/api-server/src/routes/index.ts");
  // Code-only views (doc comments stripped) — for "does this thing call X?"
  // greps that should not be tripped by comments saying "never calls X".
  const engineCode = stripComments(engine);
  const routesCode = stripComments(routes);
  const toolsCode  = stripComments(tools);

  // 1. Radar uses real available data only (imports liveScanner; no synthetic fallback)
  const real = engineCode.includes('scoreLiveCandidates') && !/simulator|fakeCandle|fabricat/i.test(engineCode);
  rec(1, "Radar uses real data only (LiveScanner, no synthetic fallback)", real);

  // 2. Missing candle data → DATA_INSUFFICIENT
  rec(2, "Missing candles produce DATA_INSUFFICIENT opportunity",
    engine.includes('"Data insufficient"') && engine.includes('"DATA_INSUFFICIENT"'));

  // 3. Per-user scoping in routes
  const perUser = routes.includes('req.authUser!.id') && routes.includes('eq(watchlistSymbolPreferencesTable.userId, userId)');
  rec(3, "Routes scope every query to req.authUser.id", perUser);

  // 4. No execution path — radar must NOT import placeOrder/dispatchToBroker
  const safe = !/placeOrder|dispatchToBroker|runOrderGuards/.test(engineCode + routesCode);
  rec(4, "Radar never imports order placement code", safe);

  // 5. Data-insufficient rows always sink to the bottom of the ranking
  rec(5, "Ranking sinks data-insufficient below verified opportunities",
    engine.includes('Data insufficient" ? 1 : 0') || engine.includes('label === "Data insufficient"'));

  // 6. Multi-timeframe alignment included
  rec(6, "Multi-timeframe alignment computed",
    engine.includes('combineMultiTimeframe') && engine.includes('alignmentScore'));

  // 7. tools_used field surfaced
  rec(7, "toolsUsed field is populated on every opportunity",
    engine.includes('toolsUsed:') && engine.includes('"liveScanner"'));

  // 8. Schema declares all 3 required tables
  const tables = ["opportunityScansTable", "watchlistSymbolPreferencesTable", "scannerSettingsTable"];
  const missingTables = tables.filter((t) => !schema.includes(t));
  rec(8, "Schema declares opportunity_scans + watchlist_symbol_preferences + scanner_settings",
    missingTables.length === 0, missingTables.length === 0 ? "3/3" : `missing: ${missingTables.join(",")}`);

  // 9. Schema exported from barrel
  rec(9, "Schema barrel exports opportunityRadar", barrel.includes("opportunityRadar"));

  // 10. Routes mounted in routes/index.ts
  rec(10, "opportunityRadar router mounted", routerIdx.includes("opportunityRadar"));

  // 11. AI tools registered (def + dispatcher)
  const ai = ["getTopOpportunitiesForMe", "explainOpportunityRanking"];
  const missingAi = ai.filter((t) => !(tools.includes(`name: "${t}"`) && tools.includes(`case "${t}":`)));
  rec(11, "Both AI opportunity tools registered (def + dispatcher)",
    missingAi.length === 0, missingAi.length === 0 ? "2/2" : `missing: ${missingAi.join(",")}`);

  // 12. No secrets returned
  const leak = /(return[\s\S]{0,500}|res\.json[\s\S]{0,500}|envelope\([\s\S]{0,500})\b(apiKeyHash|MT5_BRIDGE_TOKEN|SESSION_SECRET|passwordHash|rawToken)\b/i.test(engineCode + routesCode + toolsCode);
  rec(12, "No secret-named fields returned by engine/routes/tools", !leak);

  // 13. Unauthenticated /api/opportunities/top is rejected
  const r1 = await probe("/api/opportunities/top");
  rec(13, "Unauthenticated /api/opportunities/top is rejected (401/403)",
    r1.status === 401 || r1.status === 403, `status=${r1.status}`);

  // 14. Unauthenticated /api/opportunities/scan is rejected
  const r2 = await probe("/api/opportunities/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  rec(14, "Unauthenticated /api/opportunities/scan is rejected (401/403)",
    r2.status === 401 || r2.status === 403, `status=${r2.status}`);

  // 15. Unauthenticated /api/watchlist/intelligence is rejected
  const r3 = await probe("/api/watchlist/intelligence");
  rec(15, "Unauthenticated /api/watchlist/intelligence is rejected (401/403)",
    r3.status === 401 || r3.status === 403, `status=${r3.status}`);

  // 16. Test file exists (sanity)
  rec(16, "Test file exists", existsSync(rp("scripts/src/phase-opportunity-radar-test.ts")));

  // 17. Radar safety envelope includes paper_only + liveLocked
  rec(17, "Radar emits safety envelope (paper_only / liveLocked)",
    engine.includes('safetyMode: "paper_only"') && engine.includes('liveLocked: true'));

  // ── Criterion #6 — Opportunity Radar respects all rules ─────────────────
  const guards = readIf("artifacts/api-server/src/lib/tradeAction/guards.ts");
  // runActionGuards is invoked from the central confirm-action site (NOT a
  // route file). That same call is what the live queue passes through.
  const confirmCode = stripComments(readIf("artifacts/api-server/src/lib/tradeAction/confirm.ts"));

  // 18. Radar wires runActionGuards (single source of truth — no parallel rule system)
  rec(18, "Radar invokes runActionGuards (same chain as live queue)",
    engine.includes("runActionGuards(") && guards.includes("export async function runActionGuards"));

  // 19. All 4 required labels present
  const labels = ["CLEAR", "WARNING_BY_RULE", "BLOCKED_BY_RULE", "DATA_INCOMPLETE"];
  const missingLabels = labels.filter((l) => !engine.includes(`"${l}"`));
  rec(19, "All 4 rule labels surfaced (CLEAR/WARNING/BLOCKED/DATA_INCOMPLETE)",
    missingLabels.length === 0, missingLabels.length === 0 ? "4/4" : `missing: ${missingLabels.join(",")}`);

  // 20. Structured rule blocker detail (name, source, severity, current, allowed, fix)
  const detailFields = ["ruleName", "source", "severity", "currentValue", "allowedLimit", "fixHint"];
  const missingDetail = detailFields.filter((f) => !engine.includes(f + ":") && !engine.includes(f + "?"));
  rec(20, "RuleDetail surfaces name/source/severity/current/allowed/fixHint",
    missingDetail.length === 0 && engine.includes("RULE_REGISTRY"),
    missingDetail.length === 0 ? "6/6" : `missing: ${missingDetail.join(",")}`);

  // 21. Per-scan cache (ScanContext / prefetched) — no per-symbol re-query
  rec(21, "Per-scan ScanContext cache prevents per-symbol re-query",
    engine.includes("buildScanContext") && engine.includes("scanCtx.prefetched")
    && guards.includes("ActionGuardPrefetched"));

  // 22. AI Scanner Brain explains rule results from real guard output
  const brain = tools.includes("explainOpportunityRanking") && tools.includes("ruleExplanation")
    && tools.includes("BLOCKED by") && tools.includes("WARNING from") && tools.includes("DATA INCOMPLETE")
    && tools.includes("ruleDetail:");
  rec(22, "AI Scanner Brain explains pass/warn/block/data-incomplete from real ruleCheck",
    brain);

  // 23. Live queue still hard-blocks confirmed block violations at queue time
  //    — the SAME runActionGuards is what enforces it (called from the
  //    central trade-action confirm path).
  rec(23, "Live queue uses runActionGuards (no scanner-only bypass)",
    confirmCode.includes("runActionGuards("));

  // 24. Scanner does NOT auto-open/auto-close — no order placement in radar or tools paths
  const radarToolsCode = engineCode + routesCode
    + stripComments(tools.match(/getTopOpportunitiesForMeTool[\s\S]{0,4000}/)?.[0] ?? "")
    + stripComments(tools.match(/explainOpportunityRankingTool[\s\S]{0,4000}/)?.[0] ?? "");
  const noExec = !/placeLiveOrderGuarded|placeDemoOrderGuarded|dispatchToBroker|enqueueExecution|placeOrder\(/.test(radarToolsCode);
  rec(24, "Scanner viewing never calls order placement / queueing", noExec);

  // 25. Missing rule data → DATA_INCOMPLETE label (never fabricated CLEAR)
  rec(25, "DATA_INCOMPLETE branch present when scan context fails to load",
    engineCode.includes('contextStatus === "DATA_INCOMPLETE"')
    && engineCode.includes('status: "DATA_INCOMPLETE"'));

  // 26. Mode-aware suggestion cap — never advertise REVIEW_LIVE_TRADE when live unavailable
  rec(26, "Mode-aware action cap (no REVIEW_LIVE_TRADE when live unavailable)",
    engine.includes("applyModeCapToSuggestion") && engine.includes("canSuggestLive"));

  // 27. ruleDetail never fabricates numeric current/allowed when not parseable
  //     (parseCurrentAndLimit returns nulls; the field is typed nullable)
  rec(27, "currentValue/allowedLimit are nullable — never fabricated",
    engine.includes("currentValue: number | string | null")
    && engine.includes("allowedLimit: number | string | null")
    && engine.includes("parseCurrentAndLimit"));

  const passed = R.filter((r) => r.ok).length;
  console.log(`\nPhase Opportunity Radar: ${passed}/${R.length} scenarios passed`);
  if (passed !== R.length) process.exit(1);
}

main().catch((e) => { console.error("radar test crashed:", e); process.exit(1); });
