// Production Launch Readiness Checklist — Admin-only aggregator.
//
// READ-ONLY. Composes env checklist + safety envelope + bridge/queue/audit
// counts + launch blockers. NEVER returns secret values; all output is
// passed through maskSensitiveOutput as defense-in-depth. Audit-the-view
// writes a row to admin_action_audit_log on every fetch.

import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  globalTradingSettingsTable,
  adminActionAuditLogTable,
  arxLiveCommandsTable,
  mt5CommandsTable,
  unattributedMasterTradesTable,
} from "@workspace/db/schema";
import { sql, eq, and, gte } from "drizzle-orm";
import { computeEnvChecklist, summarizeEnvChecklist } from "../lib/startup/envChecklist.js";
import { maskSensitiveOutput } from "../lib/security/redact.js";

const router = Router();

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

function getAdminId(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

interface Blocker { code: string; severity: "INFO" | "WARN" | "CRITICAL"; message: string; }

async function computeReadiness(): Promise<{
  env: ReturnType<typeof computeEnvChecklist>;
  envSummary: ReturnType<typeof summarizeEnvChecklist>;
  safety: { platformMode: string; emergencyKillSwitch: boolean; sharedLiveTradingEnabled: boolean; accountRoutingMode: string; demoEnabled: boolean; liveEnabled: boolean; };
  counts: { arxLiveCommandsTotal: number; arxLiveCommandsLast24h: number; mt5CommandsTotal: number; openNeedsReviewMasterTrades: number; recentAdminActions24h: number; };
  modeContext: { nodeEnv: string; isProduction: boolean; isDevelopment: boolean; isTest: boolean; };
  launchBlockers: Blocker[];
  noLiveCommandEvidence: { ok: boolean; arxLiveCommandsCount: number; note: string; };
  computedAt: string;
}> {
  const envItems = computeEnvChecklist();
  const envSummary = summarizeEnvChecklist(envItems);

  const settingsRows = await db.select().from(globalTradingSettingsTable).limit(1);
  const s = settingsRows[0];
  const safety = {
    platformMode: String(s?.platformMode ?? "OFF"),
    emergencyKillSwitch: !!s?.emergencyKillSwitch,
    sharedLiveTradingEnabled: !!s?.sharedLiveTradingEnabled,
    accountRoutingMode: String(s?.accountRoutingMode ?? "USER_OWNED_MT5"),
    demoEnabled: !!s?.demoEnabled,
    liveEnabled: !!s?.liveEnabled,
  };

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [liveTotal] = await db.select({ c: sql<number>`count(*)::int` }).from(arxLiveCommandsTable);
  const [live24h] = await db.select({ c: sql<number>`count(*)::int` }).from(arxLiveCommandsTable).where(gte(arxLiveCommandsTable.createdAt, since24h));
  const [mt5Total] = await db.select({ c: sql<number>`count(*)::int` }).from(mt5CommandsTable);
  const [needsReview] = await db.select({ c: sql<number>`count(*)::int` }).from(unattributedMasterTradesTable).where(eq(unattributedMasterTradesTable.status, "pending_review"));
  const [admin24h] = await db.select({ c: sql<number>`count(*)::int` }).from(adminActionAuditLogTable).where(gte(adminActionAuditLogTable.createdAt, since24h));

  const counts = {
    arxLiveCommandsTotal: liveTotal?.c ?? 0,
    arxLiveCommandsLast24h: live24h?.c ?? 0,
    mt5CommandsTotal: mt5Total?.c ?? 0,
    openNeedsReviewMasterTrades: needsReview?.c ?? 0,
    recentAdminActions24h: admin24h?.c ?? 0,
  };

  const nodeEnv = String(process.env["NODE_ENV"] ?? "development");
  const modeContext = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    isDevelopment: nodeEnv === "development",
    isTest: nodeEnv === "test",
  };

  const launchBlockers: Blocker[] = [];

  if (envSummary.missingRequired.length > 0) {
    const reasons = Object.entries(envSummary.missingRequiredReasons)
      .map(([k, v]) => `${k}: ${v}`);
    launchBlockers.push({
      code: "ENV_REQUIRED_MISSING", severity: "CRITICAL",
      message: `Missing required env vars: ${envSummary.missingRequired.join(", ")}`
        + (reasons.length > 0 ? ` — ${reasons.join("; ")}` : ""),
    });
  }
  // Named separately from ENV_REQUIRED_MISSING because the consequence is
  // specific and total: with the shield ON and no pepper, every signup is
  // refused with PEPPER_MISSING and the admin cannot mint a key to work around
  // it. An operator reading "a required var is missing" would not know that.
  if (envSummary.registrationShieldBlocked) {
    launchBlockers.push({
      code: "REGISTRATION_SHIELD_BLOCKED", severity: "CRITICAL",
      message: "ARX_BETA_INVITE_REQUIRED=true but REGISTRATION_KEY_PEPPER is absent. "
        + "Every account creation is refused with PEPPER_MISSING and no registration key can be issued. "
        + "Set the secret in Replit Secrets and redeploy — see docs/REGISTRATION_KEY_PEPPER_RUNBOOK.md.",
    });
  }
  if (envSummary.legacyBridgeTokenPresent) {
    launchBlockers.push({ code: "LEGACY_SERVER_WIDE_BRIDGE_TOKEN_PRESENT", severity: "CRITICAL", message: "MT5_BRIDGE_TOKEN env value is set. It is rejected on every EA endpoint and must be removed before public launch." });
  }
  if (envSummary.liveMasterSwitchEnabled) {
    launchBlockers.push({ code: "LIVE_MASTER_SWITCH_ENABLED", severity: "WARN", message: "ARX_LIVE_BROKER_EXECUTION_ENABLED is TRUE. Phase B 16-gate evaluator is active — every gate still must individually PASS, but this is no longer the default-deny posture." });
  }
  if (envSummary.liveMasterSwitchEnabled && !safety.emergencyKillSwitch && safety.platformMode !== "LIVE") {
    // Informational only — operator may be staging
  }
  if (!safety.emergencyKillSwitch && safety.platformMode === "LIVE") {
    launchBlockers.push({ code: "PLATFORM_LIVE_WITHOUT_KILL_SWITCH", severity: "CRITICAL", message: "platformMode=LIVE with emergencyKillSwitch=FALSE. Engage the kill switch before any controlled live test." });
  }
  if (counts.openNeedsReviewMasterTrades > 0) {
    launchBlockers.push({ code: "OPEN_NEEDS_REVIEW_MASTER_TRADES", severity: "WARN", message: `${counts.openNeedsReviewMasterTrades} unattributed master trade(s) in pending_review. Resolve in Shared Master Reconciliation before launch.` });
  }
  if (counts.arxLiveCommandsLast24h > 0) {
    launchBlockers.push({ code: "LIVE_COMMANDS_DISPATCHED_LAST_24H", severity: "WARN", message: `${counts.arxLiveCommandsLast24h} live command(s) dispatched in the last 24h. Verify each was intentional.` });
  }
  if (modeContext.isProduction && (modeContext.isDevelopment || modeContext.isTest)) {
    launchBlockers.push({ code: "AMBIGUOUS_NODE_ENV", severity: "CRITICAL", message: "NODE_ENV resolution is ambiguous." });
  }

  const noLiveCommandEvidence = {
    ok: counts.arxLiveCommandsTotal === 0,
    arxLiveCommandsCount: counts.arxLiveCommandsTotal,
    note: counts.arxLiveCommandsTotal === 0
      ? "No live command has ever been dispatched. Strict-zero invariant intact."
      : `${counts.arxLiveCommandsTotal} live command row(s) exist. Verify each was an intentional operator-approved controlled test.`,
  };

  return { env: envItems, envSummary, safety, counts, modeContext, launchBlockers, noLiveCommandEvidence, computedAt: new Date().toISOString() };
}

// Fail-CLOSED audit-the-view: if the audit insert fails, the route must
// refuse to return the readiness payload. No admin view of launch readiness
// is allowed to bypass `admin_action_audit_log` accountability.
async function writeAdminAudit(args: { adminId: number | null; role: string; action: string; afterState: Record<string, unknown>; }): Promise<void> {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId, adminRole: args.role,
    action: args.action, targetUserId: null,
    beforeState: {}, afterState: args.afterState, reason: null,
    ipAddress: null,
  });
}

// ─── GET /api/admin/launch-readiness ───────────────────────────────────────
router.get("/admin/launch-readiness", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const r = await computeReadiness();
    const masked = maskSensitiveOutput(r) as typeof r;
    await writeAdminAudit({
      adminId: getAdminId(req), role,
      action: "ADMIN_VIEWED_LAUNCH_READINESS",
      afterState: { blockerCount: masked.launchBlockers.length, presentEnv: masked.envSummary.presentCount, missingRequired: masked.envSummary.missingRequired.length },
    });
    res.json({ ok: true, readiness: masked });
  } catch (e) {
    res.status(500).json({ ok: false, error: "readiness_failed", reason: (e as Error).message.slice(0, 200) });
  }
});

// ─── GET /api/admin/launch-readiness/env (env subsection) ─────────────────
// Also audited — no readiness view path may bypass ADMIN_VIEWED_LAUNCH_READINESS.
router.get("/admin/launch-readiness/env", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const items = computeEnvChecklist();
    const summary = summarizeEnvChecklist(items);
    await writeAdminAudit({
      adminId: getAdminId(req), role,
      action: "ADMIN_VIEWED_LAUNCH_READINESS_ENV",
      afterState: { presentEnv: summary.presentCount, missingRequired: summary.missingRequired.length, legacyBridgeTokenPresent: summary.legacyBridgeTokenPresent },
    });
    res.json({ ok: true, env: items, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: "readiness_env_failed", reason: (e as Error).message.slice(0, 200) });
  }
});

export default router;
