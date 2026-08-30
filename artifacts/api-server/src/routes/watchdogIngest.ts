// Capability #28 — the app-side landing pad for the independent protection
// watchdog.
//
//   POST /api/watchdog/alerts   — PUBLIC path, bearer-token authenticated
//                                 inside the handler. Records the watchdog's
//                                 heartbeat and raises notifications through
//                                 the product's OWN notification service.
//   GET  /api/admin/watchdog/status — ADMIN/OWNER: is the watcher still
//                                 reaching us, and what did it last see.
//
// WHY THE INGEST TOKEN IS NOT OPTIONAL
// `ARX_WATCHDOG_INGEST_TOKEN` must be set for this endpoint to do anything.
// Unset → 503 with `ingest_not_configured`. It FAILS CLOSED: an unauthenticated
// caller can never inject a fake "all clear", and — just as important — can
// never inject a fake CRITICAL to spam every operator. Setting that value is an
// OWNER PRESS; this code neither generates nor rotates it, and never logs it.
//
// WHO GETS THE ALERT
// Operators only: users whose product role normalizes to ADMIN or OWNER. Not
// the position's owner. That is a deliberate isolation choice — the watchdog's
// wire envelope strips `userId` from evidence (watchdogAlertEnvelope.ts) and
// this route re-strips it on receipt, so an alert about one trader's position
// never carries that trader's identity onto another account's screen.
//
// AUTHORITY: none. This router reads the envelope and writes notifications and
// a heartbeat row. It cannot place, modify or close anything, and it holds no
// gate, switch or flag.

import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, usersTable, watchdogHeartbeatsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveProductRole, normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { createNotification } from "../lib/notificationService.js";
import { parseAlertEnvelope, type WatchdogAlertEnvelope } from "../lib/protectiveWatchdog/watchdogAlertEnvelope.js";
import { mapEnvelopeToNotifications } from "../lib/protectiveWatchdog/watchdogNotificationMapper.js";

const router: IRouter = Router();

// This envelope states only what THIS router can vouch for. It makes no
// platform-wide claim about live trading (the mistake campaign-8 front G
// removed elsewhere) — those claims are not this router's to make.
const SAFETY_ENVELOPE = {
  surface: "watchdog-ingest" as const,
  placesOrders: false as const,
  allowOrderExecution: false as const,
};

/** Constant-time bearer comparison; length is compared first so
 *  `timingSafeEqual` never throws on a mismatched buffer length. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

async function operatorUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id, role: usersTable.role, isSystemUser: usersTable.isSystemUser })
    .from(usersTable);
  return rows
    .filter((r) => !r.isSystemUser && isAdminProductRole(normalizeProductRole(r.role)))
    .map((r) => r.id);
}

async function upsertHeartbeat(env: WatchdogAlertEnvelope, notificationsRaised: number, degradedReason: string | null): Promise<void> {
  const now = new Date();
  const values = {
    instanceId: env.instanceId,
    topology: env.topology,
    lastVerdict: env.passVerdict,
    lastSeenAt: new Date(Date.parse(env.atIso)),
    findingsTotal: env.counts.findingsTotal,
    criticalCount: env.counts.critical,
    cannotVerifyCount: env.counts.cannotVerify,
    activeFindingKeys: env.findings.map((f) => f.key),
    watchdogUptimeSeconds: env.uptimeSeconds,
    notificationsRaised,
    ingestDegraded: degradedReason !== null,
    ingestDegradedReason: degradedReason,
    updatedAt: now,
  };
  await db.insert(watchdogHeartbeatsTable).values(values).onConflictDoUpdate({
    target: watchdogHeartbeatsTable.instanceId,
    set: {
      topology: values.topology,
      lastVerdict: values.lastVerdict,
      lastSeenAt: values.lastSeenAt,
      findingsTotal: values.findingsTotal,
      criticalCount: values.criticalCount,
      cannotVerifyCount: values.cannotVerifyCount,
      activeFindingKeys: values.activeFindingKeys,
      watchdogUptimeSeconds: values.watchdogUptimeSeconds,
      notificationsRaised: values.notificationsRaised,
      ingestDegraded: values.ingestDegraded,
      ingestDegradedReason: values.ingestDegradedReason,
      updatedAt: now,
    },
  });
}

// ── POST /api/watchdog/alerts ───────────────────────────────────────────────
router.post("/watchdog/alerts", async (req, res): Promise<void> => {
  const expected = process.env.ARX_WATCHDOG_INGEST_TOKEN;
  if (!expected || expected.length < 16) {
    // Fail closed, and say so honestly rather than pretending to accept.
    res.status(503).json({
      ok: false,
      error: "ingest_not_configured",
      detail: "ARX_WATCHDOG_INGEST_TOKEN is unset (or too short) on the API server — the watchdog alert path is not armed. This is an owner press; see docs/WATCHDOG_DEPLOYMENT.md.",
      ...SAFETY_ENVELOPE,
    });
    return;
  }
  const presented = bearerOf(req.get("authorization"));
  if (!presented || !tokenMatches(presented, expected)) {
    req.log?.warn("watchdog_ingest_rejected_token");
    res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY_ENVELOPE });
    return;
  }

  const parsed = parseAlertEnvelope(req.body);
  if (!parsed.ok) {
    res.status(400).json({ ok: false, error: "invalid_envelope", reason: parsed.reason, ...SAFETY_ENVELOPE });
    return;
  }
  const envelope = parsed.value;

  let raised = 0;
  let degradedReason: string | null = null;
  try {
    const payloads = mapEnvelopeToNotifications(envelope.findings, envelope.instanceId);
    if (payloads.length > 0) {
      const operators = await operatorUserIds();
      if (operators.length === 0) {
        // The alert has nowhere to land. Say it out loud — a watchdog whose
        // alerts reach no human is worse than none, because it looks covered.
        degradedReason = "no ADMIN/OWNER account exists to receive watchdog alerts";
        req.log?.error({ findings: envelope.findings.length }, "watchdog_alert_has_no_recipient");
      }
      for (const uid of operators) {
        for (const p of payloads) {
          const created = await createNotification(uid, p).catch(() => null);
          if (created) raised++;
        }
      }
      if (operators.length > 0 && raised === 0) {
        degradedReason = "notification service raised nothing for the delivered findings";
      }
    }
  } catch (e) {
    degradedReason = "notification fan-out failed";
    req.log?.error({ err: e }, "watchdog_ingest_fanout_failed");
  }

  try {
    await upsertHeartbeat(envelope, raised, degradedReason);
  } catch (e) {
    req.log?.error({ err: e }, "watchdog_heartbeat_upsert_failed");
    // The heartbeat is diagnostics; the alert already landed (or already
    // reported itself degraded). Report the partial truth, do not 500 the
    // watchdog into a retry storm.
    res.status(200).json({
      ok: true, accepted: true, notificationsRaised: raised,
      heartbeatRecorded: false, degradedReason: degradedReason ?? "heartbeat_write_failed",
      ...SAFETY_ENVELOPE,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    accepted: true,
    findingsReceived: envelope.findings.length,
    notificationsRaised: raised,
    heartbeatRecorded: true,
    degradedReason,
    ...SAFETY_ENVELOPE,
  });
});

// ── GET /api/admin/watchdog/status ──────────────────────────────────────────
router.get("/admin/watchdog/status", requireUser, async (req, res): Promise<void> => {
  if (!isAdminProductRole(resolveProductRole(req.authUser))) {
    res.status(403).json({ ok: false, error: "forbidden", ...SAFETY_ENVELOPE });
    return;
  }
  try {
    const rows = await db.select().from(watchdogHeartbeatsTable).orderBy(sql`${watchdogHeartbeatsTable.lastSeenAt} DESC`).limit(20);
    const now = Date.now();
    const instances = rows.map((r) => {
      const ageSeconds = Math.max(0, Math.floor((now - new Date(r.lastSeenAt).getTime()) / 1000));
      return {
        instanceId: r.instanceId,
        topology: r.topology,
        lastVerdict: r.lastVerdict,
        lastSeenAgeSeconds: ageSeconds,
        findingsTotal: r.findingsTotal,
        criticalCount: r.criticalCount,
        cannotVerifyCount: r.cannotVerifyCount,
        activeFindingKeys: r.activeFindingKeys,
        notificationsRaised: r.notificationsRaised,
        ingestDegraded: r.ingestDegraded,
        ingestDegradedReason: r.ingestDegradedReason,
      };
    });
    res.json({
      ok: true,
      ingestArmed: Boolean(process.env.ARX_WATCHDOG_INGEST_TOKEN && process.env.ARX_WATCHDOG_INGEST_TOKEN.length >= 16),
      instances,
      // An empty list is an honest empty, not a green tick: no watchdog has
      // ever reported in, so nothing is being independently verified.
      isEmpty: instances.length === 0,
      emptyReason: instances.length === 0 ? "no watchdog instance has ever reported to this server — protection is NOT being independently verified" : null,
      ...SAFETY_ENVELOPE,
    });
  } catch (e) {
    req.log?.error({ err: e }, "watchdog_status_failed");
    res.status(500).json({ ok: false, error: "watchdog_status_failed", ...SAFETY_ENVELOPE });
  }
});

export default router;
