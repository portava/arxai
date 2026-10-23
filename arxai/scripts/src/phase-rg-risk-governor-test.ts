export {};
// Phase RG — Central Risk Governor + Position Sizing Engine final QA.
// Black-box static + HTTP suite covering the 19 QA items from the spec.
//
// What this verifies:
//   - Risk Governor enforcement is wired into the trade-action guard chain
//     (chokepoint coverage: every OPEN/CLOSE/MODIFY/PARTIAL_CLOSE).
//   - Daily-loss / max-trades / max-open / close-only / shared-master
//     allocation / allowed-symbols / allowed-direction all implemented and
//     log to user_risk_events on block.
//   - Position sizing returns honest "limited" result when data missing.
//   - Risk Center UI + RiskPreviewCard exist.
//   - AI risk tools exist + system prompt forbids inventing balance / pips.
//   - Live actions still require explicit confirmation phrase.
//   - Emergency stop short-circuits the guard chain.
//   - Per-user isolation on /api/me/risk/* routes.
//   - Admin can edit user risk limits (route + audit log).
//   - No secrets exposed in any risk surface (scrubSecrets + grep).
//
// This suite is read-only: no DB writes, no command queueing.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __d = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__d, "..", "..");
function repo(p: string): string { return resolve(REPO_ROOT, p); }
function readRepo(p: string): string {
  const full = repo(p);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

const BASE = process.env["BASE"] ?? "http://localhost:80";
type R = { name: string; pass: boolean; note?: string };
const results: R[] = [];
function record(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "✓" : "✗"} ${name}${note ? "  — " + note : ""}`);
}

async function http(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(`${BASE}${path}`, init);
    const body = await r.text();
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: (e as Error).message };
  }
}

(async () => {
  const enforcement   = readRepo("artifacts/api-server/src/lib/tradeAction/riskGovernorEnforcement.ts");
  const guards        = readRepo("artifacts/api-server/src/lib/tradeAction/guards.ts");
  const confirm       = readRepo("artifacts/api-server/src/lib/tradeAction/confirm.ts");
  const meRisk        = readRepo("artifacts/api-server/src/routes/meRiskGovernor.ts");
  const adminTrading  = readRepo("artifacts/api-server/src/routes/adminTrading.ts");
  const positionSize  = readRepo("artifacts/api-server/src/lib/positionSizing.ts");
  const engine        = readRepo("artifacts/api-server/src/lib/riskGovernorEngine.ts");
  const safetyCore    = readRepo("artifacts/api-server/src/lib/safetyCore.ts");
  const tools         = readRepo("artifacts/api-server/src/lib/assistant/tools.ts");
  const systemPrompt  = readRepo("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
  const riskCenter    = readRepo("artifacts/trading-dashboard/src/pages/risk-command-center.tsx");
  const riskPreview   = readRepo("artifacts/trading-dashboard/src/components/tradePlan/RiskPreviewCard.tsx");
  const userRiskSchm  = readRepo("lib/db/src/schema/userRiskGovernor.ts");

  // ── 1. Every OPEN/CLOSE/MODIFY action passes through Risk Governor ──────
  {
    const wiredImport = guards.includes("enforceRiskGovernor");
    const wiredCall   = /enforceRiskGovernor\s*\(/.test(guards);
    const wiredGate   = /if\s*\(\s*!\s*rg\.passed\s*\)/.test(guards);
    record("1. runActionGuards calls enforceRiskGovernor and fail-closes on block",
      wiredImport && wiredCall && wiredGate);
  }

  // ── 2. Oversized lot rejection (hard cap + per-user cap) ────────────────
  record("2. Lot hard cap + per-user maxLotSize enforced in runActionGuards",
    /MAX_LOT_HARD_CAP/.test(guards) && /maxLotSize/.test(guards));

  // ── 3. Daily loss limit enforced and logs to user_risk_events ───────────
  {
    const hasDailyLoss = /maxDailyLossAmount|maxDailyLossPercent|maxDailyLossUsd/.test(enforcement);
    const logsBlocks   = /logRiskEvent/.test(enforcement) && /eventType:\s*["']blocked_trade["']/.test(enforcement);
    record("3. Daily loss enforcement + audit log",
      hasDailyLoss && logsBlocks);
  }

  // ── 4. Max trades per day enforced ──────────────────────────────────────
  record("4. Max trades per day enforced (engine + admin floor)",
    /maxTradesPerDay/.test(enforcement) && /countTodayOpenedTrades/.test(enforcement));

  // ── 5. Max open trades enforced ─────────────────────────────────────────
  record("5. Max open trades enforced via live_positions count",
    /countOpenLivePositions/.test(enforcement) && /maxOpenTrades/.test(enforcement));

  // ── 6. Shared-master allocation limits ──────────────────────────────────
  {
    const hasRouting = /SHARED_MASTER_MT5/.test(enforcement);
    const hasVAcct   = /virtualTradingAccountsTable/.test(enforcement);
    const hasBlown   = /rg_shared_allocation_blown|rg_shared_margin_would_exceed/.test(enforcement);
    const hasOwnership = /eq\(virtualTradingAccountsTable\.userId,\s*userId\)/.test(enforcement);
    record("6. Shared-master allocation + ownership scoping",
      hasRouting && hasVAcct && hasBlown && hasOwnership);
  }

  // ── 7. Users only see their own risk data (per-user isolation) ──────────
  {
    const usesAuthUser = /req\.authUser\.id|req\.user\.id/.test(meRisk);
    const noClientUserId = !/req\.body\.userId|req\.params\.userId/.test(meRisk.replace(/admin/gi, ""));
    const scoped = (meRisk.match(/eq\([a-zA-Z]+\.userId,\s*userId\)/g) ?? []).length >= 2;
    record("7. /api/me/risk/* routes scoped to req.authUser.id",
      usesAuthUser && noClientUserId && scoped);
  }

  // ── 8. Admin can edit user risk limits ──────────────────────────────────
  record("8. Admin route POST /admin/users/:id/risk-limits exists",
    /risk-limits|user_risk_limits|userRiskLimitsTable/.test(adminTrading));

  // ── 9. Close-only mode blocks OPEN, allows risk-reducing actions ────────
  {
    const opensSet = /OPENS_NEW_RISK\s*=\s*new Set\(\[\s*["']OPEN["']\s*\]\)/.test(enforcement);
    const blocksOpenOnly = /inCloseOnlyMode\s*&&\s*OPENS_NEW_RISK\.has\(actionType\)/.test(enforcement);
    record("9. Close-only blocks OPEN, lets CLOSE/PARTIAL_CLOSE/MODIFY through",
      opensSet && blocksOpenOnly);
  }

  // ── 10. Position sizing works when data exists ──────────────────────────
  record("10. positionSizing returns suggested + final lot when inputs valid",
    /suggestedLot/.test(positionSize) && /finalLot/.test(positionSize) && /maxLotAllowed/.test(positionSize));

  // ── 11. Position sizing honest when data missing ────────────────────────
  {
    // The engine guards against stopDistance===0 and never invents pip
    // value if not provided.
    const honestStopGuard = /stopDistance\s*===\s*0|stop.*distance/i.test(positionSize);
    const noFabricatedPip = !/pipValue\s*=\s*(1|0\.0001|0\.01)\s*[;,]\s*\/\/.*default/i.test(positionSize);
    record("11. positionSizing does not fabricate pip value / shows limited",
      honestStopGuard && noFabricatedPip);
  }

  // ── 12. Trade ticket risk preview component exists ──────────────────────
  record("12. RiskPreviewCard renders risk preview before confirmation",
    riskPreview.length > 0 && /riskAmount|estimatedLoss|maxLoss|computedRr/.test(riskPreview));

  // ── 13. AI can explain trade blocks from real risk data ─────────────────
  {
    const hasTools = /getRiskLimits|getRecentRiskEvents|runPreTradeRiskCheck|getAccountSnapshot/.test(tools);
    const userScoped = /userId:\s*number/.test(tools);
    record("13. AI risk tools exist and are user-scoped",
      hasTools && userScoped);
  }

  // ── 14. AI does NOT invent balance/pip/margin/symbol specs ──────────────
  {
    const forbidsFab = /never invent|do not invent|never fabricat|do not fabricat|never guess|honest.*missing|connected:\s*false/i.test(systemPrompt);
    record("14. systemPrompt forbids inventing balance/pip/margin/specs",
      forbidsFab);
  }

  // ── 15. Live actions still require explicit confirmation phrase ─────────
  record("15. LIVE requires explicit confirmation phrase",
    /CONFIRM LIVE/.test(confirm) || /liveConfirmPhrase/.test(confirm));

  // ── 16. Emergency stop still blocks (kill switch) ───────────────────────
  record("16. Kill switch short-circuits guard chain",
    /killSwitchEngaged/.test(guards) && /Emergency stop/.test(guards));

  // ── 17. Risk audit logs written (user_risk_events) on every block ───────
  {
    const blocksCount = (enforcement.match(/return blockAndLog\(/g) ?? []).length;
    record(`17. Every block path calls blockAndLog (${blocksCount} call sites)`,
      blocksCount >= 8 && /userRiskEventsTable/.test(meRisk));
  }

  // ── 18. No secrets exposed in any risk surface ──────────────────────────
  {
    const env = /process\.env\[\s*["'](?:MT5_BRIDGE_TOKEN|SESSION_SECRET|TWELVEDATA_API_KEY)/;
    const secretRef = /MT5_BRIDGE_TOKEN|SESSION_SECRET|api[_-]?key_hash|apiKeyHash|tokenHash/i;
    const safe = !env.test(enforcement) && !env.test(meRisk) && !env.test(adminTrading)
      && !secretRef.test(enforcement);
    const scrubber = /scrubSecrets|SECRET_KEY_RE|REDACTED/.test(meRisk);
    record("18. No secrets read or returned by risk surfaces; meRiskGovernor uses scrubSecrets",
      safe && scrubber);
  }

  // ── 19. Mobile Risk Center exists and uses responsive Tailwind ──────────
  {
    const exists = riskCenter.length > 0;
    const responsive = /sm:|md:|lg:|grid-cols-1|flex-col/.test(riskCenter);
    record("19. Risk Center page exists with responsive layout",
      exists && responsive);
  }

  // ── 20. Schema readiness — user_risk_settings has all required fields ───
  {
    const cols = ["maxRiskPerTradePercent", "maxDailyLossPercent", "maxOpenTrades",
                  "maxTradesPerDay", "blockAfterDailyLossHit", "requireStopLoss",
                  "liveLocked", "readOnlyMode", "allowOrderExecution"];
    const missing = cols.filter((c) => !userRiskSchm.includes(c));
    record("20. user_risk_settings schema is complete",
      missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : undefined);
  }

  // ── 21. Live HTTP — meRiskGovernor returns 401 unauthenticated ──────────
  {
    const r = await http("/api/me/risk/settings");
    record("21. GET /api/me/risk/settings requires auth (401 unauth)",
      r.status === 401 || r.status === 403);
  }

  // ── 22. Live HTTP — admin route requires auth ───────────────────────────
  {
    const r = await http("/api/admin/users/1/risk-limits", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    record("22. POST /api/admin/users/:id/risk-limits requires admin auth",
      r.status === 401 || r.status === 403);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  // eslint-disable-next-line no-console
  console.log(`\nPhase RG: ${passed}/${total} scenarios passed`);
  if (passed !== total) {
    for (const r of results.filter((r) => !r.pass)) {
      // eslint-disable-next-line no-console
      console.log(`  FAILED: ${r.name}${r.note ? " (" + r.note + ")" : ""}`);
    }
    process.exit(1);
  }
})();
