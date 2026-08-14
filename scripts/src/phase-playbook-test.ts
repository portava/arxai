// Phase Playbook QA — verifies the Strategy Playbook & Setup Quality Engine
// surfaces are wired correctly. Static checks only (no live HTTP) — fails
// loudly if any required AI tool, route path, schema column, journal field,
// admin control, or scanner integration is missing.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..");
const must = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL:", msg); failures.push(msg); } else { console.log("PASS:", msg); } };
const failures: string[] = [];
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// 1. Schema columns on journal
const journalSchema = read("lib/db/src/schema/journalEntries.ts");
must(/setupTag:\s*text/.test(journalSchema), "journalEntries has setupTag column");
must(/setupQualityScore:\s*integer/.test(journalSchema), "journalEntries has setupQualityScore column");
must(/setupQualityLabel:\s*text/.test(journalSchema), "journalEntries has setupQualityLabel column");
must(/matchedPlaybookId:\s*integer/.test(journalSchema), "journalEntries has matchedPlaybookId column");
must(/setupQualitySource:\s*text/.test(journalSchema), "journalEntries has setupQualitySource column");

// 2. Admin settings schema
const adminSchema = read("lib/db/src/schema/playbookSettings.ts");
must(/playbookEnforcementEnabled/.test(adminSchema), "playbook_admin_settings has playbookEnforcementEnabled");
must(/requireSetupBeforeLive/.test(adminSchema), "playbook_admin_settings has requireSetupBeforeLive");
must(/setupRiskWarnings/.test(adminSchema), "playbook_admin_settings has setupRiskWarnings");
must(/export \* from "\.\/playbookSettings"/.test(read("lib/db/src/schema/index.ts")), "schema barrel exports playbookSettings");

// 3. AI tools registered + implemented
const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
for (const t of ["getMyPlaybooks", "evaluateTradeAgainstPlaybook", "getBestAndWorstPlaybooks", "getRecentPreTradeChecks"]) {
  must(new RegExp(`name:\\s*"${t}"`).test(tools), `AI tool "${t}" registered in tool defs`);
  must(new RegExp(`case\\s+"${t}"`).test(tools), `AI tool "${t}" has dispatcher case`);
}
must(/getMyPlaybooksTool\s*\(/.test(tools) && /userPlaybooksTable/.test(tools), "getMyPlaybooks impl reads real userPlaybooksTable");
must(/getBestAndWorstPlaybooksTool/.test(tools) && /tradeJournalEntriesTable/.test(tools), "getBestAndWorstPlaybooks impl reads real tradeJournalEntriesTable");
must(/evaluateTradeAgainstPlaybookTool/.test(tools) && /preTradeChecksTable/.test(tools), "evaluateTradeAgainstPlaybook impl reads real preTradeChecksTable");
must(/getRecentPreTradeChecksTool/.test(tools) && /preTradeChecksTable/.test(tools), "getRecentPreTradeChecks impl reads real preTradeChecksTable");

// 4. systemPrompt updated
const sp = read("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
must(/Strategy Playbook & Setup Quality awareness/i.test(sp), "systemPrompt has Playbook awareness section");
must(/NEVER claim/.test(sp), "systemPrompt forbids fabricated playbook matches");

// 5. 5 spec endpoint paths
const sac = read("artifacts/api-server/src/routes/setupsAndCoach.ts");
must(/router\.post\("\/setups\/score"/.test(sac), "POST /api/setups/score exists");
must(/router\.get\("\/setups\/performance"/.test(sac), "GET /api/setups/performance exists");
must(/router\.post\("\/trades\/:id\/setup-tag"/.test(sac), "POST /api/trades/:id/setup-tag exists");
must(/router\.get\("\/coach\/strategy-insights"/.test(sac), "GET /api/coach/strategy-insights exists");
must(/router\.post\("\/coach\/build-playbook"/.test(sac), "POST /api/coach/build-playbook exists");
const routesIdx = read("artifacts/api-server/src/routes/index.ts");
must(/setupsAndCoachRouter/.test(routesIdx) && /router\.use\(setupsAndCoachRouter\)/.test(routesIdx),
  "setupsAndCoach router imported and mounted under /api");

// 6. Admin controls
const admin = read("artifacts/api-server/src/routes/adminTrading.ts");
must(/router\.get\("\/admin\/playbook\/settings"/.test(admin), "GET /api/admin/playbook/settings exists");
must(/router\.post\("\/admin\/playbook\/settings"/.test(admin), "POST /api/admin/playbook/settings exists");
must(/playbookEnforcementEnabled/.test(admin) && /requireSetupBeforeLive/.test(admin) && /setupRiskWarnings/.test(admin),
  "admin endpoints expose all 3 controls");
must(/writeAdminAudit\(/.test(admin), "admin write is audited");

// 7. Auto-tag on close
const mePaper = read("artifacts/api-server/src/routes/mePaperTrades.ts");
must(/playbook auto-tag on close/i.test(mePaper), "mePaperTrades close-path includes Playbook auto-tag block");
must(/preTradeChecksTable/.test(mePaper) && /tradeJournalEntriesTable/.test(mePaper) && /setupQualityScore/.test(mePaper),
  "auto-tag writes setup quality from real pre_trade_check into journal");

// 8. Scanner integration
const setupBadgePath = "artifacts/trading-dashboard/src/components/trading/SetupQualityBadge.tsx";
must(existsSync(resolve(ROOT, setupBadgePath)), "SetupQualityBadge component exists");
const badge = read(setupBadgePath);
must(/fetch\("\/api\/setups\/score"/.test(badge), "SetupQualityBadge calls /api/setups/score");
must(/Matching strategy/.test(badge) && /Blocked/.test(badge) && /Warning/.test(badge),
  "SetupQualityBadge surfaces required labels (Matching strategy / Blocked / Warning)");
const scanner = read("artifacts/trading-dashboard/src/pages/scanner.tsx");
must(/SetupQualityBadge/.test(scanner), "scanner.tsx imports SetupQualityBadge");
must(/<SetupQualityBadge\s/.test(scanner), "scanner.tsx renders SetupQualityBadge per row");
const ms = read("artifacts/trading-dashboard/src/pages/market-scanner.tsx");
must(/SetupQualityBadge/.test(ms), "market-scanner.tsx imports SetupQualityBadge");
must(/<SetupQualityBadge\s/.test(ms), "market-scanner.tsx renders SetupQualityBadge per card");

// 9. Safety invariants — no broker execution from these surfaces
must(!/executeBrokerOrder|placeLiveOrder|sendMt5Order/.test(sac), "setupsAndCoach does NOT call broker execution");
must(/safetyMode:\s*"paper_only"/.test(sac), "setupsAndCoach tags responses as paper_only");
must(!/MT5_BRIDGE_TOKEN|SESSION_SECRET|apiKeyHash/.test(sac), "setupsAndCoach does NOT leak secret names in responses");
must(!/MT5_BRIDGE_TOKEN|SESSION_SECRET|apiKeyHash/.test(tools.slice(tools.indexOf("getMyPlaybooksTool"))),
  "Playbook tool impls do NOT reference secrets");

// 10. Done
if (failures.length > 0) {
  console.error(`\nPHASE PLAYBOOK QA: FAIL — ${failures.length} failure(s)`);
  for (const f of failures) console.error(" -", f);
  process.exit(1);
} else {
  console.log("\nPHASE PLAYBOOK QA: PASS");
}
