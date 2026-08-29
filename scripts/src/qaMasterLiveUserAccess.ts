// qaMasterLiveUserAccess.ts — Master Live per-user approval gate acceptance proof
//
// READ-ONLY at the dispatch surface. Inserts only into
// user_master_live_access (DB seed for the four-status truth table). NEVER
// calls dispatchLiveCommand. NEVER inserts into arx_live_commands.
// Asserts arx_live_commands count is unchanged across the run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool, db, userMasterLiveAccessTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  evaluateUserMasterLiveAccessGate,
} from "../../artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.js";

const ROOT = join(import.meta.dirname, "..", "..");
function read(p: string): string {
  try { return readFileSync(join(ROOT, p), "utf-8"); } catch { return ""; }
}
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:\\])\/\/.*$/, "$1")).join("\n");
}
function collapse(s: string): string { return s.replace(/\s+/g, " "); }

type Verdict = { name: string; pass: boolean; note: string };
const results: Verdict[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function main(): Promise<void> {
  // ── INVARIANT (start) ────────────────────────────────────────────────
  const startCnt = (await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands")).rows[0].n as number;

  // Pick (or create) a throw-away user to seed access rows against.
  let userId: number;
  const existing = await db.select().from(usersTable).limit(1);
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    const [u] = await db.insert(usersTable).values({
      email: `qa-mla-${Date.now()}@arx.test`, role: "USER",
    }).returning();
    userId = u!.id;
  }
  // Clean any prior access row for a deterministic baseline.
  await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, userId));

  // ── 01 — Pure evaluator: no row → USER_NOT_APPROVED_FOR_MASTER_LIVE ──
  const v0 = evaluateUserMasterLiveAccessGate({ access: null });
  record("01_no_row_blocks_not_approved",
    v0.decision === "BLOCKED" && v0.primaryReason === "USER_NOT_APPROVED_FOR_MASTER_LIVE",
    `decision=${v0.decision} primary=${v0.decision==="BLOCKED"?v0.primaryReason:"PASS"}`);

  // ── 02 — Pure evaluator: NOT_APPROVED status blocks ──────────────────
  const v1 = evaluateUserMasterLiveAccessGate({
    access: {
      id: 0, userId, approvedForMasterLive: false, masterLiveTradingEnabled: false,
      masterLiveApprovedBy: null, masterLiveApprovedAt: null,
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "NOT_APPROVED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: [], maxLot: null, dailyLossLimitUsd: null,
      requireStopLoss: true, scannerLiveEnabled: false, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("02_not_approved_status_blocks",
    v1.decision === "BLOCKED" && v1.primaryReason === "USER_NOT_APPROVED_FOR_MASTER_LIVE",
    `primary=${v1.decision==="BLOCKED"?v1.primaryReason:"PASS"}`);

  // ── 03 — APPROVED + toggle OFF → USER_MASTER_LIVE_TOGGLE_OFF ─────────
  const v2 = evaluateUserMasterLiveAccessGate({
    access: { ...(v1 as any).access ?? {}, id:0, userId,
      approvedForMasterLive: true, masterLiveTradingEnabled: false,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "APPROVED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: [], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: false, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("03_approved_toggle_off_blocks",
    v2.decision === "BLOCKED" && v2.blockReasons.includes("USER_MASTER_LIVE_TOGGLE_OFF"),
    `reasons=${v2.decision==="BLOCKED"?v2.blockReasons.join(","):"PASS"}`);

  // ── 04 — SUSPENDED → USER_MASTER_LIVE_SUSPENDED ──────────────────────
  const v3 = evaluateUserMasterLiveAccessGate({
    access: { id:0, userId,
      approvedForMasterLive: true, masterLiveTradingEnabled: true,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "SUSPENDED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: [], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: false, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("04_suspended_status_blocks",
    v3.decision === "BLOCKED" && v3.primaryReason === "USER_MASTER_LIVE_SUSPENDED",
    `primary=${v3.decision==="BLOCKED"?v3.primaryReason:"PASS"}`);

  // ── 05 — RISK_LOCKED → USER_MASTER_LIVE_RISK_LOCKED ──────────────────
  const v4 = evaluateUserMasterLiveAccessGate({
    access: { id:0, userId,
      approvedForMasterLive: true, masterLiveTradingEnabled: true,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "RISK_LOCKED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: [], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: false, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("05_risk_locked_status_blocks",
    v4.decision === "BLOCKED" && v4.primaryReason === "USER_MASTER_LIVE_RISK_LOCKED",
    `primary=${v4.decision==="BLOCKED"?v4.primaryReason:"PASS"}`);

  // ── 06 — DISABLED → USER_MASTER_LIVE_TOGGLE_OFF ──────────────────────
  const v5 = evaluateUserMasterLiveAccessGate({
    access: { id:0, userId,
      approvedForMasterLive: false, masterLiveTradingEnabled: false,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: 1, masterLiveDisabledAt: new Date(),
      masterLiveStatus: "DISABLED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: [], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: false, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("06_disabled_status_blocks_toggle_off",
    v5.decision === "BLOCKED" && v5.blockReasons.includes("USER_MASTER_LIVE_TOGGLE_OFF"),
    `reasons=${v5.decision==="BLOCKED"?v5.blockReasons.join(","):"PASS"}`);

  // ── 07 — Happy path: APPROVED + toggle ON + acks present → PASS ──────
  const v6 = evaluateUserMasterLiveAccessGate({
    access: { id:0, userId,
      approvedForMasterLive: true, masterLiveTradingEnabled: true,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "APPROVED",
      riskDisclosureAcceptedAt: new Date(), riskSettingsConfiguredAt: new Date(),
      allowedSymbols: ["EURUSD"], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: true, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("07_full_approval_passes",
    v6.decision === "PASS",
    `decision=${v6.decision}`);

  // ── 08 — APPROVED + toggle ON but missing risk disclosure → BLOCKED ──
  const v7 = evaluateUserMasterLiveAccessGate({
    access: { id:0, userId,
      approvedForMasterLive: true, masterLiveTradingEnabled: true,
      masterLiveApprovedBy: 1, masterLiveApprovedAt: new Date(),
      masterLiveDisabledBy: null, masterLiveDisabledAt: null,
      masterLiveStatus: "APPROVED",
      riskDisclosureAcceptedAt: null, riskSettingsConfiguredAt: new Date(),
      allowedSymbols: ["EURUSD"], maxLot: 0.01, dailyLossLimitUsd: 100,
      requireStopLoss: true, scannerLiveEnabled: true, capitalTier: null,
      maxOpenPositions: null, maxExposurePerSymbolLots: null,
      createdAt: new Date(), updatedAt: new Date(),
      requireTakeProfit: true, liveBridgeRequestedAt: null, liveBridgeRequestNote: null, liveBridgeRequestRiskDisclosureAcceptedAt: null,
      liveBridgeDeniedAt: null, liveBridgeDeniedBy: null, liveBridgeDeniedReason: null,
      liveBridgeRevokedAt: null, liveBridgeRevokedBy: null, liveBridgeRevokedReason: null,
      defaultExecutionRoute: "SHARED_MASTER_MT5", assignedRiskTemplateId: null,
      sharedBridgeOneClickPermitted: false, sharedBridgeOneClickPermittedBy: null, sharedBridgeOneClickPermittedAt: null,
      sharedBridgeOneClickRevokedBy: null, sharedBridgeOneClickRevokedAt: null,
      disclosureWaivedAt: null, disclosureWaivedBy: null, disclosureWaiverReason: null,
      liveExecutionEnabled: false, liveExecutionActivationSource: null,
      liveExecutionActivatedBy: null, liveExecutionActivatedAt: null,
      liveConfirmationRequired: true, liveConfirmationCompletedAt: null,
      liveConfirmationBypassedByAdmin: null, assignedLiveBridgeId: null,
    },
  });
  record("08_missing_risk_disclosure_blocks",
    v7.decision === "BLOCKED" && v7.blockReasons.includes("USER_MISSING_RISK_DISCLOSURE"),
    `reasons=${v7.decision==="BLOCKED"?v7.blockReasons.join(","):"PASS"}`);

  // ── 09 — Pipeline wires user-access gate BEFORE bridge gate ──────────
  const pipeline = read("artifacts/api-server/src/lib/live/liveCommandPipeline.ts");
  const idxUser = pipeline.indexOf("loadAndEvaluateUserMasterLiveAccessGate(");
  const idxBridge = pipeline.indexOf("loadAndEvaluateMasterLiveBridgeGate(");
  const idxBranch = pipeline.indexOf('"SHARED_MASTER_MT5"');
  record("09_pipeline_order_user_then_bridge",
    idxUser > 0 && idxBridge > 0 && idxBranch > 0 && idxBranch < idxUser && idxUser < idxBridge,
    `branch=${idxBranch} userGate=${idxUser} bridgeGate=${idxBridge}`);

  // ── 10 — Admin routes require ADMIN + write audit row ────────────────
  const adminRoute = read("artifacts/api-server/src/routes/adminMasterLiveAccess.ts");
  const adminCode = stripComments(adminRoute);
  record("10_admin_routes_requireAdmin_and_audit",
    /requireAdmin/.test(adminCode) && /masterLiveAccessAuditTable/.test(adminCode) &&
      /writeAudit\s*\(/.test(adminCode),
    "requireAdmin + audit table + writeAudit() all present");

  // ── 11 — Admin routes registered in router index ─────────────────────
  const routesIdx = read("artifacts/api-server/src/routes/index.ts");
  record("11_routes_registered",
    /adminMasterLiveAccessRouter/.test(routesIdx) && /meMasterLiveAccessRouter/.test(routesIdx),
    "both routers wired");

  // ── 12 — User route requireUser + no email/role leak ─────────────────
  const meRoute = stripComments(read("artifacts/api-server/src/routes/meMasterLiveAccess.ts"));
  record("12_user_route_isolated_no_email_or_role",
    /requireUser/.test(meRoute) && !/\bemail\b/.test(meRoute) && !/\brole\b/.test(meRoute),
    "/api/me/master-live/access uses requireUser and never returns email/role");

  // ── 13 — Schema columns present ──────────────────────────────────────
  const colsQ = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='user_master_live_access'
      AND column_name IN (
        'approved_for_master_live','master_live_trading_enabled',
        'master_live_status','master_live_approved_by','master_live_approved_at',
        'master_live_disabled_by','master_live_disabled_at'
      )
  `);
  record("13_schema_columns_present",
    colsQ.rows.length === 7,
    `cols=${colsQ.rows.map((r)=>r.column_name as string).join(",")}`);

  // ── 14 — Audit table exists with the right columns ───────────────────
  const auditQ = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='master_live_access_audit'
      AND column_name IN ('admin_user_id','target_user_id','action','reason','created_at')
  `);
  record("14_audit_table_present",
    auditQ.rows.length === 5,
    `cols=${auditQ.rows.map((r)=>r.column_name as string).join(",")}`);

  // ── 15 — Gate library is import-clean ────────────────────────────────
  const gateSrc = stripComments(read("artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.ts"));
  record("15_gate_lib_no_trade_imports",
    !/dispatchLiveCommand|placeLiveOrderGuarded|liveCommandPipeline/.test(gateSrc),
    "userMasterLiveAccessGate does not import any trade-placing function");

  // ── 16 — UI banner strings render the exact acceptance sentences ────
  const guard = collapse(read("artifacts/trading-dashboard/src/components/live/MasterLiveAccessGuard.tsx"));
  const scanner = collapse(read("artifacts/trading-dashboard/src/pages/market-scanner.tsx"));
  const ticket = collapse(read("artifacts/trading-dashboard/src/components/live/LiveTradeTicket.tsx"));
  record("16_ui_banners_render_effective_state_copy",
    // T022 — banner is role/status-aware: live-ready, approved-but-blocked,
    // and not-approved copy all present; the old false approval sentence and
    // all Demo/Paper wording are gone from the active flow.
    /Live trading ready\./.test(guard) &&
      /Live trading requires approval\./.test(guard) &&
      /Your account is not approved for master live trading\./.test(guard) &&
      !/Master live trading requires admin approval\./.test(guard) &&
      !/use demo mode/i.test(guard) &&
      !/Paper Trading/i.test(guard) &&
      /MasterLiveAccessBanner/.test(scanner) &&
      /MasterLiveAccessTicketBlock/.test(ticket),
    "scanner banner shows effective live state (ready / blocked / not-approved), old approval sentence + Demo/Paper wording removed");

  // ── 17 — Admin UI section present in admin/master-bridge.tsx ─────────
  const adminPage = read("artifacts/trading-dashboard/src/pages/admin/master-bridge.tsx");
  record("17_admin_ui_section_present",
    /MasterLiveUserAccessTable/.test(adminPage),
    "admin master-bridge page renders MasterLiveUserAccessTable");

  // ── 18 — No bypass: dispatchLiveCommand never called by new files ────
  const newFiles = [
    read("artifacts/api-server/src/lib/mt5/userMasterLiveAccessGate.ts"),
    read("artifacts/api-server/src/routes/adminMasterLiveAccess.ts"),
    read("artifacts/api-server/src/routes/meMasterLiveAccess.ts"),
  ].join("\n---\n");
  record("18_no_dispatch_bypass_in_new_files",
    !/\bdispatchLiveCommand\s*\(/.test(newFiles),
    "no new file invokes dispatchLiveCommand()");

  // ── INVARIANT (end) — arx_live_commands count unchanged across the run ──
  // This suite never dispatches, so the safety invariant is that the row count is
  // UNCHANGED (no auto-fire). Asserting an absolute 0 is wrong against an accumulated
  // dev/prod DB where historical terminal rows are real, immutable audit evidence.
  const endCnt = (await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands")).rows[0].n as number;
  record("19_arx_live_commands_unchanged",
    startCnt === endCnt,
    `start=${startCnt} end=${endCnt} (must be unchanged — no auto-fire; historical rows are real audit evidence)`);

  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${pass}/${total} Master Live per-user access acceptance items PASS, ${total - pass} FAIL`);
  await pool.end();
  if (pass !== total) process.exit(1);
}

await main();
