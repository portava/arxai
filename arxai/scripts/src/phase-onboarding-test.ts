// Phase Onboarding test — verifies the 14-status per-user readiness engine,
// per-user isolation, admin guards, AI tool registration, and safety
// invariants. All checks are STATIC + LIVE (against the running API server
// at localhost:80 via the shared proxy).

import { readFileSync, existsSync } from "node:fs";

const SERVER = "http://localhost:80";
const RESULTS: Array<{ id: number; name: string; ok: boolean; detail?: string }> = [];

function record(id: number, name: string, ok: boolean, detail?: string): void {
  RESULTS.push({ id, name, ok, detail });
  const tag = ok ? "✓" : "✗";
  console.log(`${tag} ${id}. ${name}${detail ? "  — " + detail : ""}`);
}

function readIfExists(p: string): string | null {
  try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; }
}

async function probe(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${SERVER}${path}`, { ...init, signal: AbortSignal.timeout(6000) });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: String(e).slice(0, 200) };
  }
}

const FORBIDDEN_SECRET_NAMES = [
  "apiKeyHash", "MT5_BRIDGE_TOKEN", "SESSION_SECRET",
  "passwordHash", "bridgeToken", "masterCredentials", "rawToken",
];

async function main(): Promise<void> {
  // 1. Engine file exists with 14 statuses
  const engine = readIfExists("artifacts/api-server/src/lib/userReadiness/engine.ts") ?? "";
  const ids = [
    "user_authenticated", "profile_complete", "risk_profile_complete",
    "trading_disclaimer_accepted", "paper_only_guard_active",
    "paper_session_available", "mt5_bridge_connected", "mt5_heartbeat_recent",
    "account_mode_selected", "user_owned_mt5_ready", "shared_master_mt5_ready",
    "demo_trading_ready", "live_account_verified", "admin_live_approval_granted",
  ];
  const missing = ids.filter(id => !engine.includes(`"${id}"`));
  record(1, "Engine declares all 14 readiness statuses", missing.length === 0,
    missing.length === 0 ? `${ids.length}/14` : `missing: ${missing.join(",")}`);

  // 2. Engine supports both routing modes
  const hasBoth = engine.includes("USER_OWNED_MT5") && engine.includes("SHARED_MASTER_MT5");
  record(2, "Engine supports USER_OWNED_MT5 and SHARED_MASTER_MT5 routing", hasBoth);

  // 3. Engine is read-only against safety surfaces
  const hasUnsafeWrite = /(?:safetyCoreTable|liveTradingStateTable)[\s\S]{0,200}(?:\.update\(|\.insert\()/.test(engine);
  record(3, "Engine does not write to safety surfaces", !hasUnsafeWrite);

  // 4. Engine scopes ready_for_live to approved + armed eligible traders only.
  // (Task #750: relaxed from the old blanket PAPER_ONLY hard-lock — live
  // reporting is now reachable ONLY for an admin-approved, armed, eligible human
  // trader, and remains false for everyone else. ready_for_live is REPORTING
  // ONLY and is never read by any execution path.)
  const scopesReadyForLive =
    engine.includes("approvedArmedTrader")
    && engine.includes("liveArmed")
    && engine.includes("getMyArming")
    && /ready_for_live\s*=\s*[\s\S]{0,120}approvedArmedTrader/.test(engine);
  record(4, "Engine scopes ready_for_live to approved+armed eligible traders only", scopesReadyForLive);

  // 5. Routes use requireUser (not _req)
  const routes = readIfExists("artifacts/api-server/src/routes/userReadiness.ts") ?? "";
  const usesRequireUser = routes.includes("requireUser") && !/router\.(get|post)\([^,]+,\s*async\s*\(\s*_req/.test(routes);
  record(5, "User routes use requireUser (no _req anonymous handlers)", usesRequireUser);

  // 6. Admin routes are gated
  const hasAdminGuard = routes.includes("requireAdmin");
  record(6, "Admin routes use requireAdmin guard", hasAdminGuard);

  // 7. Approve-live refuses if upstream live gates missing
  const refuses = routes.includes("live_prereqs_missing");
  record(7, "Approve-live refuses if disclosure/account-verified gates fail", refuses);

  // 8. Schema file with 3 tables exists
  const schema = readIfExists("lib/db/src/schema/userReadinessState.ts") ?? "";
  const hasTables =
    schema.includes("userReadinessStateTable")
    && schema.includes("userLiveDisclosureAcceptancesTable")
    && schema.includes("userReadinessAuditTable");
  record(8, "Schema declares state + acceptances + audit tables", hasTables);

  // 9. Schema exported from barrel
  const barrel = readIfExists("lib/db/src/schema/index.ts") ?? "";
  record(9, "Schema barrel exports userReadinessState", barrel.includes("userReadinessState"));

  // 10. Routes mounted in routes/index.ts
  const routerIdx = readIfExists("artifacts/api-server/src/routes/index.ts") ?? "";
  record(10, "userReadiness router mounted in routes/index.ts", routerIdx.includes("userReadiness"));

  // 11. AI tools registered
  const tools = readIfExists("artifacts/api-server/src/lib/assistant/tools.ts") ?? "";
  const aiTools = ["getMyTradingReadiness", "explainReadinessBlockers", "listMyOnboardingSteps", "getOnboardingProgress"];
  const missingAi = aiTools.filter(t => !(tools.includes(`name: "${t}"`) && tools.includes(`case "${t}":`)));
  record(11, "All 4 AI readiness tools registered (def + dispatcher)",
    missingAi.length === 0, missingAi.length === 0 ? `${aiTools.length}/4` : `missing: ${missingAi.join(",")}`);

  // 12. No secret-named fields returned by engine/routes/tool impls
  const sources = [engine, routes, tools].join("\n");
  const leaks = FORBIDDEN_SECRET_NAMES.filter(s => {
    const pattern = new RegExp(`(return[\\s\\S]{0,500}|res\\.json[\\s\\S]{0,500}|envelope\\([\\s\\S]{0,500})\\b${s}\\b`, "i");
    return pattern.test(sources);
  });
  record(12, "No secret-named fields returned by routes/tools/engine", leaks.length === 0,
    leaks.length === 0 ? "" : `leaks: ${leaks.join(",")}`);

  // 13. Unauthenticated readiness/me request is blocked
  const unauth = await probe("/api/readiness/me");
  const blocked = unauth.status === 401 || unauth.status === 403;
  record(13, "Unauthenticated /api/readiness/me is rejected", blocked, `status=${unauth.status}`);

  // 14. Unauthenticated admin list is blocked
  const unauthAdmin = await probe("/api/admin/readiness/users");
  const adminBlocked = unauthAdmin.status === 401 || unauthAdmin.status === 403;
  record(14, "Unauthenticated /api/admin/readiness/users is rejected", adminBlocked, `status=${unauthAdmin.status}`);

  // 15. Test file itself exists (sanity)
  record(15, "Test file scripts/src/phase-onboarding-test.ts exists",
    existsSync("scripts/src/phase-onboarding-test.ts"));

  // 16. Live readiness still requires ALL gates AND fail-closes non-eligible
  // identities. ready_for_live demands approved + armed (admin approval +
  // per-user arming) AND every upstream live gate (disclosure + verified
  // routing + demo-ready) AND the absence of a genuine system hard stop.
  // Investors and system/bot accounts are excluded by identity; admin approval
  // alone (without arming, identity eligibility, and the other gates) can never
  // flip it true.
  const liveBlockedByDesign = engine.includes("ready_for_live")
    && engine.includes("approvedArmedTrader")
    && engine.includes("&& liveApproved")
    && engine.includes("&& liveArmed")
    && engine.includes("&& demoReady")
    && engine.includes("&& liveDisclosureOk")
    && engine.includes("&& liveAccountVerified")
    && engine.includes("!systemLiveHardStop")
    && engine.includes('=== "INVESTOR"')
    && engine.includes("isSystemUser");
  record(16, "Live readiness requires approved+armed+all gates and excludes investor/system", liveBlockedByDesign);

  const passed = RESULTS.filter(r => r.ok).length;
  const total = RESULTS.length;
  console.log(`\nPhase Onboarding: ${passed}/${total} scenarios passed`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error("phase-onboarding-test crashed:", e);
  process.exit(1);
});
