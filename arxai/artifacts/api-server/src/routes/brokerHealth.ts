// Build G — Broker/MT5 Connection Health Monitor.
//
// Composes:
//   - mt5_state          — live process telemetry (heartbeat, lastSyncAt)
//   - safetyCore         — canonical mt5LinkHealth + global state authority
//   - mt5_commands       — used to queue a RECONNECT command for the EA
//   - broker_health_state (singleton) — operator toggles + cached status
//   - broker_health_logs — append-only audit trail
//
// The pure verdict logic lives in lib/domain/src/broker-health/evaluator.ts.
// This file only does I/O: read the inputs, call the evaluator, persist.

import { Router } from "express";
import {
  db,
  brokerHealthLogsTable,
  brokerHealthStateTable,
  mt5StateTable,
  mt5CommandsTable,
  vaultEventsTable,
} from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { evaluateBrokerHealth, type BrokerHealthVerdict } from "@workspace/domain/broker-health";
import { getStatus } from "../lib/safetyCore.js";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

// Singleton accessor — deterministic order to mirror safetyCore's pattern.
// If a concurrent first-write creates duplicates, the lowest-id row is the
// canonical one and the others are ignored (a follow-up cleanup job could
// fold them; the cached lastStatus is overwritten on every persistSnapshot).
async function loadOrCreateBrokerState() {
  const rows = await db.select().from(brokerHealthStateTable)
    .orderBy(asc(brokerHealthStateTable.id))
    .limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(brokerHealthStateTable).values({}).returning();
  return inserted[0]!;
}

async function loadMt5State() {
  const rows = await db.select().from(mt5StateTable).limit(1);
  return rows[0] ?? null;
}

async function appendVault(
  kind: string,
  severity: "INFO" | "WARN" | "DANGER",
  verdict: BrokerHealthVerdict,
  extra: Record<string, unknown> = {},
) {
  await db.insert(vaultEventsTable).values({
    kind,
    severity,
    source: "SYSTEM",
    truthDomain: "BROKER",
    summary: `${kind}: status=${verdict.status}`,
    payload: { status: verdict.status, latencyMs: verdict.latencyMs, ...extra },
    reasons: verdict.reasons,
    blockers: verdict.blockers,
    generatedAtIso: new Date().toISOString(),
  });
}

/** Run the evaluator against current DB inputs. Pure inputs, side-effect free. */
async function evaluateNow() {
  const [bh, mt5, sc] = await Promise.all([
    loadOrCreateBrokerState(),
    loadMt5State(),
    getStatus(),
  ]);

  const verdict = evaluateBrokerHealth({
    nowMs: Date.now(),
    lastHeartbeatAtMs: mt5?.lastHeartbeatAt ? new Date(mt5.lastHeartbeatAt).getTime() : null,
    lastSyncAtMs: mt5?.lastSyncAt ? new Date(mt5.lastSyncAt).getTime() : null,
    executionEnabled: bh.executionEnabled,
    maintenanceMode: bh.maintenanceMode,
    lastErrorCode: bh.lastErrorCode,
    lastErrorMessage: bh.lastErrorMessage,
    priceFeedDelayMs: null, // future: derive from price feed lag
    reconnectAttempts: bh.reconnectAttempts,
  });

  return {
    verdict,
    state: bh,
    mt5State: mt5,
    coreLink: sc.mt5LinkHealth,
  };
}

/** Persist a snapshot to broker_health_logs and update cached state. */
async function persistSnapshot(verdict: BrokerHealthVerdict, state: typeof brokerHealthStateTable.$inferSelect, mt5: { broker: string | null; lastHeartbeatAt: Date | null } | null) {
  await db.insert(brokerHealthLogsTable).values({
    brokerName: mt5?.broker ?? null,
    status: verdict.status,
    latencyMs: verdict.latencyMs == null ? null : Math.round(verdict.latencyMs),
    priceFeedDelayMs: null,
    lastHeartbeatAt: mt5?.lastHeartbeatAt ?? null,
    errorCode: state.lastErrorCode,
    errorMessage: state.lastErrorMessage,
    reconnectAttempts: state.reconnectAttempts,
    executionEnabled: state.executionEnabled,
    reasons: verdict.reasons,
    warnings: verdict.warnings,
    blockers: verdict.blockers,
  });

  await db.update(brokerHealthStateTable)
    .set({
      lastStatus: verdict.status,
      lastEvaluatedAt: new Date(),
      // Reset reconnect counter once we're back to a fully healthy link.
      reconnectAttempts: verdict.status === "CONNECTED" ? 0 : state.reconnectAttempts,
      // Clear cached error on CONNECTED.
      ...(verdict.status === "CONNECTED" ? {
        lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null,
      } : {}),
      updatedAt: new Date(),
    })
    .where(eq(brokerHealthStateTable.id, state.id));
}

function verdictToResponse(
  verdict: BrokerHealthVerdict,
  state: typeof brokerHealthStateTable.$inferSelect,
  mt5: { broker: string | null; account: string | null; lastHeartbeatAt: Date | null; lastSyncAt: Date | null } | null,
  coreLink: "OK" | "DEGRADED" | "DOWN",
) {
  return {
    status: verdict.status,
    severity: verdict.severity,
    reasons: verdict.reasons,
    warnings: verdict.warnings,
    blockers: verdict.blockers,
    latencyMs: verdict.latencyMs,
    aiExplanation: verdict.aiExplanation,
    executionEnabled: state.executionEnabled,
    maintenanceMode: state.maintenanceMode,
    reconnectAttempts: state.reconnectAttempts,
    lastErrorCode: state.lastErrorCode,
    lastErrorMessage: state.lastErrorMessage,
    lastErrorAtIso: state.lastErrorAt?.toISOString() ?? null,
    lastReconnectAtIso: state.lastReconnectAt?.toISOString() ?? null,
    lastEvaluatedAtIso: state.lastEvaluatedAt?.toISOString() ?? null,
    brokerName: mt5?.broker ?? null,
    accountNumber: mt5?.account ?? null,
    lastHeartbeatAtIso: mt5?.lastHeartbeatAt?.toISOString() ?? null,
    lastSyncAtIso: mt5?.lastSyncAt?.toISOString() ?? null,
    safetyCoreLinkHealth: coreLink,
  };
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /broker/health — live computed status (no audit row, no mutation).
router.get("/broker/health", async (req, res) => {
  try {
    const { verdict, state, mt5State, coreLink } = await evaluateNow();
    res.json(verdictToResponse(verdict, state, mt5State, coreLink));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /broker/health failed");
    res.status(500).json({ error: "Failed to evaluate broker health" });
  }
});

// POST /broker/health-check — force re-evaluation, persist log, vault event.
router.post("/broker/health-check", async (req, res) => {
  try {
    const { verdict, state, mt5State, coreLink } = await evaluateNow();
    await persistSnapshot(verdict, state, mt5State);
    const sev = verdict.severity === "OK" ? "INFO" : verdict.severity === "WARN" ? "WARN" : "DANGER";
    await appendVault("BROKER_HEALTH_CHECK", sev, verdict);

    // Re-load state because persistSnapshot may have cleared error/reset attempts.
    const fresh = await loadOrCreateBrokerState();
    res.json(verdictToResponse(verdict, fresh, mt5State, coreLink));
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /broker/health-check failed");
    res.status(500).json({ error: "Failed to run broker health check" });
  }
});

// GET /broker/health-logs — paginated audit history.
router.get("/broker/health-logs", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await db.select().from(brokerHealthLogsTable)
      .orderBy(desc(brokerHealthLogsTable.createdAt))
      .limit(limit);
    res.json({
      logs: rows.map((r) => ({
        id: r.id,
        brokerName: r.brokerName,
        status: r.status,
        latencyMs: r.latencyMs,
        priceFeedDelayMs: r.priceFeedDelayMs,
        lastHeartbeatAtIso: r.lastHeartbeatAt?.toISOString() ?? null,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        reconnectAttempts: r.reconnectAttempts,
        executionEnabled: r.executionEnabled,
        reasons: r.reasons,
        warnings: r.warnings,
        blockers: r.blockers,
        createdAtIso: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /broker/health-logs failed");
    res.status(500).json({ error: "Failed to load broker health logs" });
  }
});

// POST /broker/reconnect — queue a RECONNECT command for the EA + bump counter.
const ReconnectBody = z.object({ reason: z.string().max(500).optional() });
router.post("/broker/reconnect", async (req, res): Promise<void> => {
  try {
    const body = ReconnectBody.parse(req.body ?? {});
    // SAFETY: Only enqueue a deliverable PENDING RECONNECT when the system is
    // armed for live trading. Otherwise store as BLOCKED so the EA poll cannot
    // pick it up. This closes the unauthenticated-enqueue path through this
    // endpoint while preserving the operator's ability to record an attempt.
    const { getStatus: getSafetyStatus } = await import("../lib/safetyCore.js");
    const safety = await getSafetyStatus();
    const armed = safety.operationalMode === "LIVE_TRADING" && !safety.killSwitchEngaged;
    const cmdStatus = armed ? "PENDING" : "BLOCKED";
    const cmdDetail = armed
      ? (body.reason ?? "operator-initiated")
      : `BLOCKED: not armed for live (mode=${safety.operationalMode}, kill=${safety.killSwitchEngaged}). Reason: ${body.reason ?? "operator-initiated"}`;

    const state = await loadOrCreateBrokerState();
    const nextAttempts = state.reconnectAttempts + 1;

    await db.update(brokerHealthStateTable)
      .set({
        reconnectAttempts: nextAttempts,
        lastReconnectAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(brokerHealthStateTable.id, state.id));

    await db.insert(mt5CommandsTable).values({
      action: "RECONNECT",
      status: cmdStatus,
      detail: cmdDetail,
    });

    await db.insert(vaultEventsTable).values({
      kind: "BROKER_RECONNECT_REQUESTED",
      severity: "WARN",
      source: "USER",
      truthDomain: "BROKER",
      summary: `Reconnect attempt #${nextAttempts}`,
      payload: { attempt: nextAttempts, reason: body.reason ?? null },
      reasons: [body.reason ?? "operator-initiated"],
      blockers: [],
      generatedAtIso: new Date().toISOString(),
    });

    res.json({ queued: true, reconnectAttempts: nextAttempts });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /broker/reconnect failed");
    res.status(500).json({ error: "Failed to queue reconnect" });
  }
});

// POST /broker/disable-execution — operator toggle off.
const DisableBody = z.object({ reason: z.string().max(500).optional() });
router.post("/broker/disable-execution", async (req, res): Promise<void> => {
  try {
    const body = DisableBody.parse(req.body ?? {});
    const state = await loadOrCreateBrokerState();
    await db.update(brokerHealthStateTable)
      .set({ executionEnabled: false, updatedAt: new Date() })
      .where(eq(brokerHealthStateTable.id, state.id));

    await db.insert(vaultEventsTable).values({
      kind: "BROKER_EXECUTION_DISABLED",
      severity: "DANGER",
      source: "USER",
      truthDomain: "BROKER",
      summary: "Live execution disabled by operator",
      payload: { reason: body.reason ?? null },
      reasons: [body.reason ?? "operator-initiated"],
      blockers: ["execution disabled — operator toggle"],
      generatedAtIso: new Date().toISOString(),
    });

    const { verdict, state: fresh, mt5State, coreLink } = await evaluateNow();
    res.json(verdictToResponse(verdict, fresh, mt5State, coreLink));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /broker/disable-execution failed");
    res.status(500).json({ error: "Failed to disable execution" });
  }
});

// POST /broker/enable-execution — operator toggle on, but only if link is healthy.
const EnableBody = z.object({ reason: z.string().max(500).optional() });
router.post("/broker/enable-execution", async (req, res): Promise<void> => {
  try {
    const body = EnableBody.parse(req.body ?? {});

    // Atomic enable: re-read state + canonical safetyCore.mt5LinkHealth
    // inside a transaction, re-evaluate the hypothetical verdict, and only
    // commit the toggle if the link is still healthy at update time.
    // safetyCore is the canonical authority — if it says the link is not
    // "OK", we refuse regardless of what the broker probe says.
    const result = await db.transaction(async (tx) => {
      const bhRows = await tx.select().from(brokerHealthStateTable)
        .orderBy(asc(brokerHealthStateTable.id)).limit(1);
      const bh = bhRows[0];
      if (!bh) throw new Error("broker_health_state singleton missing");

      const mt5Rows = await tx.select().from(mt5StateTable)
        .orderBy(asc(mt5StateTable.id)).limit(1);
      const mt5 = mt5Rows[0] ?? null;

      const sc = await getStatus();

      // Canonical authority gate: if safetyCore says link is not OK, refuse.
      if (sc.mt5LinkHealth !== "OK") {
        return { ok: false as const, code: 409, status: "DISCONNECTED",
          blockers: [`safetyCore.mt5LinkHealth=${sc.mt5LinkHealth}`] };
      }

      const probe = evaluateBrokerHealth({
        nowMs: Date.now(),
        lastHeartbeatAtMs: mt5?.lastHeartbeatAt ? new Date(mt5.lastHeartbeatAt).getTime() : null,
        lastSyncAtMs: mt5?.lastSyncAt ? new Date(mt5.lastSyncAt).getTime() : null,
        executionEnabled: true, // hypothetical
        maintenanceMode: bh.maintenanceMode,
        lastErrorCode: bh.lastErrorCode,
        lastErrorMessage: bh.lastErrorMessage,
        priceFeedDelayMs: null,
        reconnectAttempts: bh.reconnectAttempts,
      });
      if (probe.status !== "CONNECTED" && probe.status !== "DEGRADED") {
        return { ok: false as const, code: 409, status: probe.status, blockers: probe.blockers };
      }

      await tx.update(brokerHealthStateTable)
        .set({ executionEnabled: true, updatedAt: new Date() })
        .where(eq(brokerHealthStateTable.id, bh.id));

      return { ok: true as const, probeStatus: probe.status };
    });

    if (!result.ok) {
      res.status(result.code).json({
        error: "Cannot enable live execution — broker link is not healthy.",
        status: result.status,
        blockers: result.blockers,
      });
      return;
    }
    const probe = { status: result.probeStatus };

    await db.insert(vaultEventsTable).values({
      kind: "BROKER_EXECUTION_ENABLED",
      severity: "WARN",
      source: "USER",
      truthDomain: "BROKER",
      summary: "Live execution enabled by operator",
      payload: { reason: body.reason ?? null, probedStatus: probe.status },
      reasons: [body.reason ?? "operator-initiated"],
      blockers: [],
      generatedAtIso: new Date().toISOString(),
    });

    const next = await evaluateNow();
    res.json(verdictToResponse(next.verdict, next.state, next.mt5State, next.coreLink));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /broker/enable-execution failed");
    res.status(500).json({ error: "Failed to enable execution" });
  }
});

// ── Internal helper for routes/trades.ts ───────────────────────────────────

/**
 * Compute the current broker-health verdict without any DB writes. Used by
 * /execute-trade as an additional gate when the safetyCore decisionMode is
 * LIVE — because under freeze the gate's PAPER decisionMode keeps real
 * orders out anyway, this is the canonical hard-gate for any future LIVE
 * route. Returns the verdict (caller decides what to do with it).
 */
export async function getBrokerHealthVerdict(): Promise<BrokerHealthVerdict> {
  const { verdict } = await evaluateNow();
  return verdict;
}

export default router;
