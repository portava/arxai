import app from "./app";
import { logger } from "./lib/logger";
import { ensureSafetyCoreInitialized } from "./lib/safetyCore";
import { bootstrapOwnerUser } from "./lib/auth/ownerBootstrap";
import { bootstrapAdminUser } from "./lib/auth/adminBootstrap";
import { bootstrapLegacyOwnerDowngrade } from "./lib/auth/legacyOwnerDowngrade";
import { startStuckCommandWatchdog } from "./lib/mt5/stuckCommandWatchdog";
import { startUnknownReconcilerWorker } from "./lib/live/unknownReconcilerWorker";
import { startGuidedSweeperWorker } from "./lib/phase6/guidedSweeperWorker.js";
import { startMt5FeedStalenessWatchdog } from "./lib/data/mt5FeedStalenessWatchdog";
import { startPoolViewAnomalyDetector } from "./lib/audit/poolViewAnomalyDetector";
import { startAgentEcosystemLifecycleRunner } from "./lib/agentEcosystem/lifecycleRunner";
import { startDailyHouseholdReportScheduler } from "./lib/agentEcosystem/dailyReportScheduler";
import { startHeatSnapshotRetentionWorker } from "./lib/timing/heatSnapshotRetention";
import { startExpiredKeySweepWorker } from "./lib/registrationKeys/expiredKeySweepWorker";
import { startExpiringKeysDigestWorker } from "./lib/registrationKeys/expiringKeysDigestWorker";
import { startMissionDriverWorker } from "./lib/missionDriver";
import { computeEnvChecklist, summarizeEnvChecklist } from "./lib/startup/envChecklist";
import { runStartupReadinessCheck } from "./lib/startup/readinessCheck";
import { seedCoreAgents } from "./lib/agentEcosystem/seedCoreAgents";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Process-level last-resort guards.
//
// unhandledRejection: a stray rejected promise (e.g. a fire-and-forget
// background task) must NOT take down the worker — a dead worker is exactly what
// makes the upstream proxy return a body-less 502, which surfaces on the client
// as "Unexpected end of JSON input". We log through the structured logger (never
// console) and keep serving; the always-JSON error middleware in app.ts keeps
// answering request-path errors. This adds NO behavior to any request path.
//
// uncaughtException: a truly-escaped synchronous throw leaves the process in an
// UNDEFINED state (in-flight DB work, live-command bookkeeping, timers). For a
// safety-critical trading server it is NOT safe to keep such a worker alive, so
// we fail safe: log, stop accepting new connections, and exit non-zero so the
// supervisor restarts a clean process. Request-path errors never reach here —
// they are caught by the Express error middleware — so this fires only on a
// genuine, unexpected fault. While the fresh worker boots, the upstream may
// briefly 502; the client's safeJson reader degrades that honestly rather than
// throwing a raw SyntaxError.
let httpServer: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : String(reason) },
    "Unhandled promise rejection (kept alive)",
  );
});
process.on("uncaughtException", (err) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.error(
    { err },
    "Uncaught exception — process state is undefined; shutting down for a clean restart",
  );
  // Guarantee exit even if server.close() hangs on an open/keep-alive socket.
  const forceExit = setTimeout(() => process.exit(1), 3000);
  forceExit.unref();
  try {
    if (httpServer) {
      httpServer.close(() => process.exit(1));
    } else {
      process.exit(1);
    }
  } catch {
    process.exit(1);
  }
});

// Initialize the Phase 1 Safety Core singleton row before accepting requests.
// This eliminates the loadOrCreate() race window for the safety_core table.
ensureSafetyCoreInitialized()
  .then(() => bootstrapOwnerUser().catch((err) => {
    logger.error({ err }, "Owner bootstrap failed (non-fatal); continuing");
  }))
  .then(() => bootstrapAdminUser().catch((err) => {
    logger.error({ err }, "Admin bootstrap failed (non-fatal); continuing");
  }))
  .then(() => bootstrapLegacyOwnerDowngrade().catch((err) => {
    logger.error({ err }, "Legacy-owner downgrade failed (non-fatal); continuing");
  }))
  .then(() => seedCoreAgents().then((r) => {
    logger.info({ ...r }, "Agent Ecosystem core agents seeded (advisory/shadow only)");
  }).catch((err) => {
    logger.error({ err }, "Core-agent seed failed (non-fatal); continuing");
  }))
  .then(() => {
    httpServer = app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening (Safety Core initialized)");
      try {
        const summary = summarizeEnvChecklist(computeEnvChecklist());
        logger.info(
          {
            envTotal: summary.total,
            envPresent: summary.presentCount,
            missingRequired: summary.missingRequired,
            missingOptional: summary.missingOptional,
            liveMasterSwitchEnabled: summary.liveMasterSwitchEnabled,
            legacyBridgeTokenPresent: summary.legacyBridgeTokenPresent,
          },
          "Production Launch Readiness — env checklist (presence only, no values)",
        );
        if (summary.missingRequired.length > 0) {
          logger.warn({ missingRequired: summary.missingRequired }, "Required env vars missing — launch readiness is BLOCKED");
        }
        if (summary.legacyBridgeTokenPresent) {
          logger.warn({}, "LEGACY MT5_BRIDGE_TOKEN env value is set — it is rejected on every EA endpoint and must be removed before public launch");
        }
      } catch (e) {
        logger.error({ err: String(e) }, "Env checklist computation failed (non-fatal)");
      }
      // Startup readiness self-check: ping the DB and log a clear readiness
      // banner so a dead dependency is loud in the logs instead of silently
      // serving a broken app. Non-fatal, run-once; never crashes the process.
      void runStartupReadinessCheck(port).catch((e) =>
        logger.error({ err: String(e) }, "Startup readiness check threw (non-fatal)"),
      );
      startStuckCommandWatchdog();
      // R2 S3/S4 — scheduled UNKNOWN-command reconciler. Resolves LIVE_UNKNOWN
      // commands from broker evidence (never fabricates an outcome) and
      // persists a reconciliation_runs row per pass, which is what allows the
      // dispatch freshness gate to be turned on at all (Ruling 10).
      // Opt-out via ARX_UNKNOWN_RECONCILER_ENABLED; disabling is logged loudly.
      startUnknownReconcilerWorker();
      // Phase 6 — the guided sweeper. sweepExpiredLiveCommands is driven ONLY
      // by the EA poll, so a venue with no EA (Deriv) would never have its
      // stale guided tickets expired: they would hold an exposure reservation
      // and an active-index slot forever. Expires PENDING/APPROVED only —
      // DISPATCHING and UNRESOLVED may have an order at the venue, and elapsed
      // time is not evidence about whether they do.
      startGuidedSweeperWorker();
      // MT5 candle-feed staleness + connectivity watchdog — raises an admin
      // alert when a previously-contributing symbol+timeframe series stops
      // pushing candles for longer than CANDLE_TTL (the chart then silently
      // falls back to a third-party provider), and a single holistic alert when
      // the EA candle feed as a whole transitions offline (no fresh push within
      // 60s). Both clear with an all-clear when the feed recovers. Read-only
      // over the in-memory provider; observation only, never a gate.
      startMt5FeedStalenessWatchdog();
      // Agent Ecosystem background lifecycle runner — advisory/shadow only,
      // opt-in (default off), defers while a live command is in flight, and
      // never touches the 16-gate live pipeline. The interval ticks but does no
      // work until an admin enables it via the runner-settings endpoint.
      startAgentEcosystemLifecycleRunner();
      // Proactive security detector — raises an admin alert when a brand-new
      // (adminId, IP) origin opens the Shared Bridge Pool view, or when a
      // single admin opens it in a burst. Read-only over the audit log.
      startPoolViewAnomalyDetector();
      // Scheduled daily Household Report — once per UTC day, automatically
      // generates the plain-English team summary and delivers it to admins as an
      // in-app alert (no admin click required). Observation only; audited;
      // never touches the advisory/shadow scope or the 16-gate live pipeline.
      startDailyHouseholdReportScheduler();
      // Heat-snapshot retention worker — automatically prunes OLD heat_snapshots
      // (advisory learning surface, never an execution gate) on a safe, decision
      // -linked-protected policy. Fail-soft; first cycle after one interval.
      startHeatSnapshotRetentionWorker();
      // Expired-registration-key sweep worker — automatically transitions
      // past-expiry PENDING keys to the terminal EXPIRED status so cohort/active
      // counts and the admin Registration Keys list stay honest. Idempotent,
      // audited, fail-soft; first cycle after one interval. beta_invites only —
      // never touches any trade/live/demo/gate surface.
      startExpiredKeySweepWorker();
      // Expiring-registration-keys admin email digest — once per UTC day at/after
      // a target hour, emails admins/OWNERs a MASKED list of PENDING keys
      // expiring within a configurable window so they can extend/revoke before
      // lapse. No email when nothing is expiring (no noise). Observation only,
      // read-only over beta_invites, audited, fail-soft; never touches any
      // trade/live/demo/gate surface. First cycle after one interval.
      startExpiringKeysDigestWorker();
      // F-build — Profit Mission driver. Advances ACTIVE missions unattended:
      // protective exits, protection/goal refresh (stop-and-lock completes with
      // no page open), timeframe expiry, blow-up/emergency pauses, and — ONLY
      // for missions the user promoted to an auto level — scan → auto-approve →
      // dispatch STRICTLY through the existing gated path (dispatchApprovedDraft
      // → executeInstant → 18-gate live dispatch; paper/demo through the
      // simulated recorder that never contacts a broker). Every gate re-runs at
      // act time; a driver crash fails safe (mission skipped, positions
      // untouched). Opt-out via ARX_MISSION_DRIVER_ENABLED (logged loudly).
      startMissionDriverWorker();
      // Eagerly bootstrap the Deriv WebSocket so synthetic-index candles
      // (V10/V25/V50/V75/V100, 1Hz variants, Boom/Crash, Step) are ready
      // before the first scanner pass. Non-blocking; lazy ensureConnection
      // remains the fallback. Never logs DERIV_APP_ID / DERIV_API_TOKEN.
      try {
        if (process.env.DERIV_APP_ID && process.env.DERIV_APP_ID.trim()) {
          import("./lib/data/providers/derivWsClient.js")
            .then((m) => m.getDerivWsClient().ensureConnection())
            .catch((err) => logger.warn({ err: String(err) }, "Deriv WS eager bootstrap failed (non-fatal)"));
          import("./lib/data/providers/derivKeepAlive.js")
            .then((m) => m.startDerivKeepAlive())
            .catch((err) => logger.warn({ err: String(err) }, "Deriv keep-alive start failed (non-fatal)"));
        }
      } catch (e) {
        logger.warn({ err: String(e) }, "Deriv WS eager bootstrap dispatch failed (non-fatal)");
      }
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialize Safety Core; refusing to start");
    process.exit(1);
  });
