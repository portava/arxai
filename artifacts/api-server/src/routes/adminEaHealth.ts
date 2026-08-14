// Task #33 — Admin EA Health aggregator + diagnostics dictionaries.
//
// Read-only, ADMIN/OWNER-only consolidation of EXISTING reliability signals into
// the shapes the EA Health and Bridge Diagnostics dashboards render. This task
// adds NO new feature and NO new trading path — every value here is already
// produced by a prior task; this only surfaces them behind operator gating.
//
// SECURITY:
//   - Every route requires an ADMIN or OWNER session. Admin-previewing-as-user
//     is auto-downgraded upstream by applyEffectiveViewMode, so a previewing
//     admin lands in the 403 branch — correct.
//   - Connection rows are emitted ONLY through the allowlist `maskConnection`
//     projection. Token secrets (apiKeyHash/previousApiKeyHash/raw token) are
//     NEVER part of any response.
//   - These are GETs that read existing state — no mutation, so no audit row is
//     written (audit is reserved for mutations on the existing admin routers).

import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  mt5ConnectionTable,
  arxLiveCommandsTable,
  arxSymbolSpecsTable,
  eaUpdateManifestTable,
  eaUpdateReportTable,
} from "@workspace/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  normaliseCapabilities,
  featureSupportMatrix,
  isFeatureSupported,
} from "../lib/mt5/bridgeCapabilities.js";
import { classifyBridge } from "../lib/live/bridgeWatchdog.js";
import { maskConnection } from "../lib/live/bridgeConnectionView.js";
import { listMt5Retcodes } from "../lib/mt5/mt5Retcodes.js";
import {
  aggregateReconciliationIssues,
  type ReconciliationIssue,
} from "../lib/reconciliation/detect.js";
import {
  evaluateEaUpdateGate,
  compareEaVersions,
} from "@workspace/domain/safety-contracts";

const router = Router();

// Statuses that mean a live command is still in flight (used for command-poll
// freshness + the update gate's "pending command" block).
const PENDING_LIVE_STATUSES = ["SENT_TO_MT5_LIVE", "LIVE_APPROVED"];

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

function ageSeconds(ts: Date | null | undefined, now: Date): number | null {
  if (!ts) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(ts).getTime()) / 1000));
}

// ─── GET /api/admin/ea/health ───────────────────────────────────────────────
// Per-connection EA health rows consolidating capabilities, heartbeat freshness,
// EA inputs, clock drift, last command result, command-poll age, self-update
// support, and update status vs the latest approved manifest.
router.get("/admin/ea/health", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const now = new Date();

  const connections = await db
    .select()
    .from(mt5ConnectionTable)
    .where(isNull(mt5ConnectionTable.tokenRevokedAt));

  // Latest approved manifest per channel (stable is the default channel an EA
  // takes). Used only to compute the update status badge — not to serve a build.
  const approvedManifests = await db
    .select()
    .from(eaUpdateManifestTable)
    .where(eq(eaUpdateManifestTable.releaseStatus, "approved"))
    .orderBy(desc(eaUpdateManifestTable.approvedAt));

  const latestApprovedByChannel = new Map<string, (typeof approvedManifests)[number]>();
  for (const m of approvedManifests) {
    if (!latestApprovedByChannel.has(m.channel)) latestApprovedByChannel.set(m.channel, m);
  }

  // Last reconciliation result — bucket the existing read-only reconciliation
  // detectors by userId / bridgeConnectionId so each health row can show whether
  // the bridge currently has open reconciliation issues. Read-only; no new path.
  const reconciliation = await aggregateReconciliationIssues();
  const issuesByUser = new Map<number, ReconciliationIssue[]>();
  const issuesByConnection = new Map<number, ReconciliationIssue[]>();
  for (const issue of reconciliation.issues) {
    if (issue.userId != null) {
      const list = issuesByUser.get(issue.userId) ?? [];
      list.push(issue);
      issuesByUser.set(issue.userId, list);
    }
    if (issue.bridgeConnectionId != null) {
      const list = issuesByConnection.get(issue.bridgeConnectionId) ?? [];
      list.push(issue);
      issuesByConnection.set(issue.bridgeConnectionId, list);
    }
  }
  function reconciliationFor(userId: number | null, connectionId: number): {
    issueCount: number;
    criticalCount: number;
    types: string[];
    latest: { type: string; severity: string; reason: string; recommendedAction: string } | null;
    computedAt: string;
  } {
    const seen = new Map<string, ReconciliationIssue>();
    for (const i of issuesByConnection.get(connectionId) ?? []) seen.set(i.id, i);
    if (userId != null) for (const i of issuesByUser.get(userId) ?? []) seen.set(i.id, i);
    const issues = [...seen.values()];
    const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    issues.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
    const top = issues[0] ?? null;
    return {
      issueCount: issues.length,
      criticalCount: issues.filter((i) => i.severity === "critical").length,
      types: [...new Set(issues.map((i) => i.type))],
      latest: top
        ? { type: top.type, severity: top.severity, reason: top.reason, recommendedAction: top.recommendedAction }
        : null,
      computedAt: reconciliation.computedAt,
    };
  }

  const rows = await Promise.all(
    connections.map(async (c) => {
      const caps = normaliseCapabilities(c.capabilities);
      const rawCaps = (c.capabilities ?? {}) as { eaInputs?: Record<string, unknown> };
      const eaInputs = rawCaps.eaInputs ?? {};
      const readOnly =
        eaInputs.readOnlyMode === undefined ? null : Boolean(eaInputs.readOnlyMode);
      const enableLive =
        eaInputs.enableLiveExecution === undefined ? null : Boolean(eaInputs.enableLiveExecution);
      const terminalConnected =
        eaInputs.terminalConnected === undefined ? null : Boolean(eaInputs.terminalConnected);
      const algoTradingAllowed =
        eaInputs.algoTradingAllowed === undefined ? null : Boolean(eaInputs.algoTradingAllowed);

      const liveness = classifyBridge({
        connectionId: c.id,
        userId: c.userId,
        connectionName: c.connectionName,
        tokenRevokedAt: c.tokenRevokedAt,
        lastHeartbeat: c.lastHeartbeat,
        accountType: c.accountType,
        eaVersion: c.eaVersion,
        eaInputs: { readOnlyMode: readOnly, enableLiveExecution: enableLive, terminalConnected, algoTradingAllowed },
        siblingFreshCount: 0,
        now,
      });

      // Last live command result for this user (read-only; allowlist projection).
      let lastCommand: {
        commandId: string;
        commandType: string;
        status: string;
        symbol: string;
        side: string;
        mt5Retcode: number | null;
        rejectionReason: string | null;
        pickedByEaAt: string | null;
        resultRecordedAt: string | null;
        createdAt: string | null;
      } | null = null;
      let commandPollAgeSeconds: number | null = null;
      let hasPendingCommand = false;
      if (c.userId != null) {
        const [lc] = await db
          .select()
          .from(arxLiveCommandsTable)
          .where(eq(arxLiveCommandsTable.userId, c.userId))
          .orderBy(desc(arxLiveCommandsTable.createdAt))
          .limit(1);
        if (lc) {
          lastCommand = {
            commandId: lc.commandId,
            commandType: lc.commandType,
            status: lc.status,
            symbol: lc.symbol,
            side: lc.side,
            mt5Retcode: lc.mt5Retcode ?? null,
            rejectionReason: lc.rejectionReason ?? null,
            pickedByEaAt: lc.pickedByEaAt ? new Date(lc.pickedByEaAt).toISOString() : null,
            resultRecordedAt: lc.resultRecordedAt ? new Date(lc.resultRecordedAt).toISOString() : null,
            createdAt: lc.createdAt ? new Date(lc.createdAt).toISOString() : null,
          };
          commandPollAgeSeconds = ageSeconds(lc.pickedByEaAt, now);
          hasPendingCommand = PENDING_LIVE_STATUSES.includes(lc.status);
        }
      }

      // Last self-update report for this user.
      let lastUpdateReport: {
        phase: string;
        outcome: string;
        fromVersion: string | null;
        toVersion: string | null;
        checksumVerified: boolean;
        blockReason: string | null;
        reportedAt: string | null;
      } | null = null;
      if (c.userId != null) {
        const [ur] = await db
          .select()
          .from(eaUpdateReportTable)
          .where(eq(eaUpdateReportTable.userId, c.userId))
          .orderBy(desc(eaUpdateReportTable.reportedAt))
          .limit(1);
        if (ur) {
          lastUpdateReport = {
            phase: ur.phase,
            outcome: ur.outcome,
            fromVersion: ur.fromVersion ?? null,
            toVersion: ur.toVersion ?? null,
            checksumVerified: ur.checksumVerified,
            blockReason: ur.blockReason ?? null,
            reportedAt: ur.reportedAt ? new Date(ur.reportedAt).toISOString() : null,
          };
        }
      }

      // Update status vs the latest approved stable manifest.
      const manifest = latestApprovedByChannel.get("stable") ?? null;
      const selfUpdateSupported = isFeatureSupported(caps, "supportsSelfUpdate");
      const updateGate = evaluateEaUpdateGate({
        manifest: manifest
          ? {
              version: manifest.version,
              channel: manifest.channel,
              releaseStatus: manifest.releaseStatus,
              sha256Checksum: manifest.sha256Checksum,
              isUpdaterCapable: manifest.isUpdaterCapable,
            }
          : null,
        currentVersion: c.eaVersion,
        allowedChannels: ["stable"],
        eaSupportsSelfUpdate: selfUpdateSupported,
        hasOpenLiveTrade: false,
        hasPendingCommand,
        heartbeatStable: liveness.liveness === "fresh",
        killSwitchEngaged: false,
        maintenanceMode: false,
      });
      const updateAvailable =
        manifest != null &&
        c.eaVersion != null &&
        compareEaVersions(manifest.version, c.eaVersion) > 0;

      return {
        connection: maskConnection(c, now),
        liveness: liveness.liveness,
        conditions: liveness.conditions,
        heartbeatAgeSeconds: ageSeconds(c.lastHeartbeat, now),
        accountType: c.accountType,
        eaVersion: c.eaVersion,
        capabilitiesReportedAt: c.capabilitiesReportedAt
          ? new Date(c.capabilitiesReportedAt).toISOString()
          : null,
        featureSupport: featureSupportMatrix(caps),
        eaInputs: { readOnlyMode: readOnly, enableLiveExecution: enableLive, terminalConnected, algoTradingAllowed },
        allowOrderExecution: c.allowOrderExecution,
        liveLocked: c.liveLocked,
        clockDrift: {
          seconds: c.clockDriftSeconds ?? null,
          severity: c.clockDriftSeverity ?? null,
        },
        lastCommand,
        commandPollAgeSeconds,
        lastReconciliationResult: reconciliationFor(c.userId, c.id),
        selfUpdateSupported,
        update: {
          currentVersion: c.eaVersion,
          latestApprovedVersion: manifest?.version ?? null,
          updateAvailable,
          decision: updateGate.decision,
          reason: updateGate.reason,
          manualBootstrapRequired: updateGate.manualBootstrapRequired,
        },
        lastUpdateReport,
      };
    }),
  );

  res.json({
    ok: true,
    evaluatedAt: now.toISOString(),
    counts: {
      total: rows.length,
      fresh: rows.filter((r) => r.liveness === "fresh").length,
      stale: rows.filter((r) => r.liveness === "stale").length,
      offline: rows.filter((r) => r.liveness === "offline").length,
    },
    rows,
  });
});

// ─── GET /api/admin/ea/retcodes ─────────────────────────────────────────────
// Friendly MT5 retcode dictionary. Pure data — no secrets.
router.get("/admin/ea/retcodes", (req, res): void => {
  const role = requireAdmin(req, res);
  if (!role) return;
  res.json({ ok: true, retcodes: listMt5Retcodes() });
});

// ─── GET /api/admin/ea/reconciliation-issues ────────────────────────────────
// Read-only reconciliation feed for the Bridge Diagnostics dashboard. This is a
// pure read of `aggregateReconciliationIssues()` and writes NO audit row, so it
// is safe for the dashboard's recurring poll (the audited variant lives at
// `/api/admin/reconciliation-center/issues` and is reserved for the operator
// Reconciliation Center page where the view itself is an audited action).
// Detection only — never assigns ownership or mutates any reconcile state.
router.get("/admin/ea/reconciliation-issues", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res);
  if (!role) return;
  try {
    const agg = await aggregateReconciliationIssues();
    res.json({ ok: true, ...agg });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "reconciliation_failed",
      reason: (e as Error).message.slice(0, 200),
    });
  }
});

// ─── GET /api/admin/ea/symbol-capabilities ──────────────────────────────────
// EA-reported broker symbol rules (visibility/tradability/lot rules/spread).
// Optional ?userId= filter; default returns all (operator scope).
router.get("/admin/ea/symbol-capabilities", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const now = new Date();

  const userIdRaw = req.query["userId"];
  const userId =
    typeof userIdRaw === "string" && /^\d+$/.test(userIdRaw) ? Number(userIdRaw) : null;

  const specs = await db
    .select()
    .from(arxSymbolSpecsTable)
    .where(userId != null ? eq(arxSymbolSpecsTable.userId, userId) : undefined)
    .orderBy(desc(arxSymbolSpecsTable.reportedAt));

  res.json({
    ok: true,
    evaluatedAt: now.toISOString(),
    symbols: specs.map((s) => ({
      userId: s.userId,
      symbol: s.symbol,
      brokerSymbol: s.brokerSymbol,
      accountType: s.accountType,
      visible: s.visible,
      tradeAllowed: s.tradeAllowed,
      tradeMode: s.tradeMode,
      marketOpen: s.marketOpen,
      digits: s.digits,
      point: s.point,
      minVolume: s.minVolume,
      maxVolume: s.maxVolume,
      volumeStep: s.volumeStep,
      contractSize: s.contractSize,
      tickSize: s.tickSize,
      tickValue: s.tickValue,
      stopsLevelPoints: s.stopsLevelPoints,
      freezeLevelPoints: s.freezeLevelPoints,
      spreadPoints: s.spreadPoints,
      reportedAt: s.reportedAt ? new Date(s.reportedAt).toISOString() : null,
      reportedAgeSeconds: ageSeconds(s.reportedAt, now),
    })),
  });
});

export default router;
