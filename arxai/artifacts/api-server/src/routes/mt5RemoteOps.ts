// Task #32 — EA-facing remote ops: remote config delivery, update check,
// update report. Lets ARX configure + update the EA without a manual reinstall.
//
// SAFETY (inviolable):
// - All routes are guarded by `bridgeAuthPerUserOnly`; the legacy server-wide
//   token is rejected upstream. Every query is scoped by `req.mt5Connection`.
// - Remote config delivery is re-sanitised through `sanitiseRemoteConfig` on the
//   way OUT (defence in depth): a protected field can never be served even if
//   one somehow reached the row.
// - Update check serves ONLY an `approved` manifest and only when
//   `evaluateEaUpdateGate` returns ALLOW. The mandatory sha256 checksum is
//   always returned so the EA can verify BEFORE applying. There is no force path.
// - Feature gating: ARX never tells the EA to use a feature it did not report as
//   supported. Unsupported features come back with featureStatus = the admin
//   warning, and the actionable payload is withheld.

import { Router, type Request, type Response } from "express";
import { and, eq, desc, isNull, inArray } from "drizzle-orm";
import {
  db,
  mt5ConnectionTable,
  eaRemoteConfigTable,
  eaUpdateManifestTable,
  eaUpdateReportTable,
  arxLivePositionsTable,
  arxLiveCommandsTable,
  arxLiveArmingTable,
  EA_UPDATE_REPORT_PHASES,
  EA_UPDATE_REPORT_OUTCOMES,
} from "@workspace/db";
import { z } from "zod/v4";
import { bridgeAuthPerUserOnly } from "./mt5.js";
import {
  normaliseCapabilities,
  isFeatureSupported,
  featureGateStatus,
} from "../lib/mt5/bridgeCapabilities.js";
import {
  sanitiseRemoteConfig,
  evaluateEaUpdateGate,
} from "@workspace/domain/safety-contracts";

const router = Router();

// Heartbeat-stability window (mirrors the Phase B 15s heartbeat gate).
const HEARTBEAT_STABLE_MS = 15_000;
// Default channels an EA may take. beta requires explicit opt-in (?betaOptIn=1).
const DEFAULT_ALLOWED_CHANNELS = ["stable", "emergency"] as const;

interface AugReq extends Request {
  mt5Connection?: typeof mt5ConnectionTable.$inferSelect;
}

// Shape of an approved manifest as needed for the update-check response.
export interface UpdateCheckManifest {
  version: string;
  channel: string;
  sha256Checksum: string | null;
  signature: string | null;
  downloadUrl: string | null;
  rollbackVersion: string | null;
  changelog: string | null;
  isUpdaterCapable: boolean;
}

// Decision shape compatible with evaluateEaUpdateGate's result.
export interface UpdateCheckDecision {
  decision: "ALLOW" | "BLOCK";
  reason: string | null;
  manualBootstrapRequired: boolean;
  targetVersion: string | null;
}

/**
 * Pure builder for the GET /mt5/update-check response. The EA's flat JSON parser
 * reads the actionable package fields (`version`, `sha256Checksum`,
 * `downloadUrl`, `isUpdaterCapable`) at the TOP LEVEL — so they MUST be emitted
 * there, never only nested. The package is served ONLY on ALLOW; on any BLOCK
 * the package fields are null so the EA cannot attempt to apply. Extracted as a
 * pure function so the EA↔server key contract can be asserted in a unit test.
 */
export function buildUpdateCheckResponse(
  decision: UpdateCheckDecision,
  manifest: UpdateCheckManifest | null,
  currentVersion: string | null,
  featureStatus: string,
) {
  const servePackage = decision.decision === "ALLOW" && manifest != null;
  return {
    ok: true,
    decision: decision.decision,
    reason: decision.reason,
    manualBootstrapRequired: decision.manualBootstrapRequired,
    targetVersion: decision.targetVersion,
    currentVersion,
    featureStatus,
    // Top-level package fields — what the EA actually parses. Null on BLOCK.
    version: servePackage ? manifest!.version : null,
    channel: servePackage ? manifest!.channel : null,
    sha256Checksum: servePackage ? manifest!.sha256Checksum : null, // verify BEFORE apply
    signature: servePackage ? manifest!.signature : null,
    downloadUrl: servePackage ? manifest!.downloadUrl : null,
    rollbackVersion: servePackage ? manifest!.rollbackVersion : null,
    changelog: servePackage ? manifest!.changelog : null,
    isUpdaterCapable: servePackage ? manifest!.isUpdaterCapable : false,
  };
}

function requireBridge(
  req: AugReq,
  res: Response,
): typeof mt5ConnectionTable.$inferSelect | null {
  const conn = req.mt5Connection;
  if (!conn) {
    res.status(401).json({ error: "BRIDGE_AUTH_REQUIRED" });
    return null;
  }
  if (conn.userId == null) {
    res.status(401).json({ error: "BRIDGE_NO_USER_ATTRIBUTION" });
    return null;
  }
  return conn;
}

// ── GET /api/mt5/remote-config ──────────────────────────────────────────────
// EA pulls its allow-listed operational tunables. Protected fields can never be
// present (stripped on write AND re-stripped here on delivery).
router.get("/mt5/remote-config", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireBridge(req, res);
  if (!conn) return;
  const caps = normaliseCapabilities(conn.capabilities);
  const featureStatus = featureGateStatus(caps, "supportsRemoteConfig");

  // Fail-closed capability gate: never serve an actionable remote-config payload
  // to an EA that did not report supportsRemoteConfig. The admin warning is
  // surfaced instead so an operator knows the EA is too old to be managed.
  if (featureStatus !== "SUPPORTED") {
    res.json({
      ok: true,
      hasConfig: false,
      featureStatus,
      configVersion: 0,
      config: {},
    });
    return;
  }

  const [row] = await db
    .select()
    .from(eaRemoteConfigTable)
    .where(eq(eaRemoteConfigTable.userId, conn.userId!))
    .limit(1);

  if (!row) {
    res.json({
      ok: true,
      hasConfig: false,
      featureStatus,
      configVersion: 0,
      config: {},
    });
    return;
  }

  // Re-sanitise on the way out — defence in depth.
  const { clean } = sanitiseRemoteConfig({
    heartbeatPeriodSeconds: row.heartbeatPeriodSeconds,
    pollIntervalSeconds: row.pollIntervalSeconds,
    snapshotPeriodSeconds: row.snapshotPeriodSeconds,
    dealHistorySyncSeconds: row.dealHistorySyncSeconds,
    symbolSpecPeriodSeconds: row.symbolSpecPeriodSeconds,
    verboseDiagnostics: row.verboseDiagnostics,
    maxSpreadPoints: row.maxSpreadPoints,
    maxDeviationPoints: row.maxDeviationPoints,
    quoteFreshnessSeconds: row.quoteFreshnessSeconds,
    defaultCommandTtlSeconds: row.defaultCommandTtlSeconds,
    retryMaxAttempts: row.retryMaxAttempts,
    retryBackoffMs: row.retryBackoffMs,
    maxLiveLotCeiling: row.maxLiveLotCeiling,
    closeCommandSupportEnabled: row.closeCommandSupportEnabled,
    maintenanceMode: row.maintenanceMode,
    allowedCommandTypes: row.allowedCommandTypes,
  });

  // Record delivery (best-effort, non-fatal).
  await db
    .update(eaRemoteConfigTable)
    .set({ lastDeliveredAt: new Date() })
    .where(eq(eaRemoteConfigTable.id, row.id));

  res.json({
    ok: true,
    hasConfig: true,
    featureStatus,
    configVersion: row.configVersion,
    config: clean,
  });
});

// ── GET /api/mt5/update-check ───────────────────────────────────────────────
// EA asks whether it should update. Returns the gate decision + the approved
// manifest (with mandatory checksum) only when ALLOW. Always honest on BLOCK.
router.get("/mt5/update-check", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireBridge(req, res);
  if (!conn) return;
  const userId = conn.userId!;
  const caps = normaliseCapabilities(conn.capabilities);

  const channel = String(req.query.channel ?? "stable").toLowerCase();
  const betaOptIn = String(req.query.betaOptIn ?? "") === "1";
  const allowedChannels = betaOptIn
    ? [...DEFAULT_ALLOWED_CHANNELS, "beta"]
    : [...DEFAULT_ALLOWED_CHANNELS];

  // Latest approved manifest for the requested channel.
  const [manifest] = await db
    .select()
    .from(eaUpdateManifestTable)
    .where(
      and(
        eq(eaUpdateManifestTable.channel, channel),
        eq(eaUpdateManifestTable.releaseStatus, "approved"),
      ),
    )
    .orderBy(desc(eaUpdateManifestTable.approvedAt))
    .limit(1);

  // Gate inputs — read the REAL safety state.
  const [arming] = await db
    .select()
    .from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, userId))
    .limit(1);

  const openPositions = await db
    .select({ id: arxLivePositionsTable.id })
    .from(arxLivePositionsTable)
    .where(
      and(
        eq(arxLivePositionsTable.userId, userId),
        isNull(arxLivePositionsTable.closedAt),
      ),
    )
    .limit(1);

  const pendingCommands = await db
    .select({ id: arxLiveCommandsTable.id })
    .from(arxLiveCommandsTable)
    .where(
      and(
        eq(arxLiveCommandsTable.userId, userId),
        inArray(arxLiveCommandsTable.status, ["SENT_TO_MT5_LIVE", "LIVE_APPROVED"]),
      ),
    )
    .limit(1);

  // maintenanceMode is a remote-config tunable.
  const [cfg] = await db
    .select({ maintenanceMode: eaRemoteConfigTable.maintenanceMode })
    .from(eaRemoteConfigTable)
    .where(eq(eaRemoteConfigTable.userId, userId))
    .limit(1);

  const lastHb = conn.lastHeartbeat ? conn.lastHeartbeat.getTime() : 0;
  const heartbeatStable = Date.now() - lastHb <= HEARTBEAT_STABLE_MS;

  const decision = evaluateEaUpdateGate({
    manifest: manifest
      ? {
          version: manifest.version,
          channel: manifest.channel,
          releaseStatus: manifest.releaseStatus,
          sha256Checksum: manifest.sha256Checksum,
          isUpdaterCapable: manifest.isUpdaterCapable,
        }
      : null,
    currentVersion: conn.eaVersion ?? null,
    allowedChannels,
    eaSupportsSelfUpdate: isFeatureSupported(caps, "supportsSelfUpdate"),
    hasOpenLiveTrade: openPositions.length > 0,
    hasPendingCommand: pendingCommands.length > 0,
    heartbeatStable,
    killSwitchEngaged: !!arming?.killSwitchEngaged,
    maintenanceMode: !!cfg?.maintenanceMode,
  });

  res.json(
    buildUpdateCheckResponse(
      decision,
      manifest ?? null,
      conn.eaVersion ?? null,
      featureGateStatus(caps, "supportsSelfUpdate"),
    ),
  );
});

// ── POST /api/mt5/update-report ─────────────────────────────────────────────
// EA reports each step of its self-update lifecycle (check/download/verify/
// apply/rollback/manual-bootstrap). Per-user, audited as an append-only row.
const updateReportSchema = z.object({
  manifestId: z.number().int().optional(),
  fromVersion: z.string().max(40).optional(),
  toVersion: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
  phase: z.enum(EA_UPDATE_REPORT_PHASES),
  outcome: z.enum(EA_UPDATE_REPORT_OUTCOMES),
  checksumVerified: z.boolean().optional(),
  blockReason: z.string().max(200).optional(),
  detail: z.string().max(2000).optional(),
});

router.post("/mt5/update-report", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireBridge(req, res);
  if (!conn) return;
  const parsed = updateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_UPDATE_REPORT", detail: parsed.error.message });
    return;
  }
  const b = parsed.data;
  await db.insert(eaUpdateReportTable).values({
    userId: conn.userId!,
    bridgeConnectionId: conn.id,
    manifestId: b.manifestId ?? null,
    fromVersion: b.fromVersion ?? null,
    toVersion: b.toVersion ?? null,
    channel: b.channel ?? null,
    phase: b.phase,
    outcome: b.outcome,
    checksumVerified: b.checksumVerified ?? false,
    blockReason: b.blockReason ?? null,
    detail: b.detail ?? null,
  });
  res.json({ ok: true });
});

export default router;
