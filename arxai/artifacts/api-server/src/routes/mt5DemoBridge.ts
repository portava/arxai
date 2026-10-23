// Phase 28-MT5-DEMO-ARMING sub-phase 3B — EA-facing demo command surface.
//
// Two endpoints, both behind `bridgeAuthPerUserOnly`:
//
//   GET  /api/mt5/demo-commands-poll
//     Returns SENT_TO_MT5_DEMO commands owned by the user whose bridge
//     token authenticated the request. The per-user dispatch gate is
//     re-evaluated at request time — if the user is no longer eligible
//     (disarmed, gate failed, EA downgraded) the endpoint returns an
//     empty list and audits the refusal. Tokens, hashes, broker secrets,
//     and other users' commands are NEVER returned.
//
//   POST /api/mt5/demo-command-result
//     EA-driven write-back. Body identifies the command by commandId and
//     reports broker outcome (FILLED_DEMO | REJECTED | FAILED). Routed
//     through `reconcileBrokerResult` which only mutates rows currently
//     in SENT_TO_MT5_DEMO and is idempotent.
//
// SAFETY:
//   - bridgeAuthPerUserOnly enforces token -> userId.
//   - The poll endpoint AND result endpoint refuse any commandId not owned
//     by the authenticated user (404).
//   - Result endpoint does NOT accept FILLED_DEMO for a non-demo account
//     type — the consumer should never have dispatched it, but we re-check.
//   - No live order code path. EA executes ONLY when its own
//     ACCOUNT_TRADE_MODE == ACCOUNT_TRADE_MODE_DEMO check passes.

import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  mt5DemoCommandsTable,
  type Mt5Connection,
} from "@workspace/db";
import { evaluatePerUserDispatchGate } from "../lib/mt5/demoDispatchGate.js";
import {
  reconcileBrokerResult,
  type BrokerReportedStatus,
} from "../lib/mt5/demoCommandReconciler.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { bridgeAuthPerUserOnly } from "./mt5.js";

const router = Router();

function shortIp(req: Request): string {
  const xf = req.header("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? "";
  return req.ip ?? "";
}

/** Backward-compat: ensure both `volume` and `lot` are present (mirrored) on
 *  outgoing demo-command payloads so any EA build — old (reads `lot`) or new
 *  (reads `volume` with `lot` fallback) — sees the same numeric size. Does
 *  NOT mutate the stored row; only the JSON we hand the EA. */
function mirrorVolumeLot(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const volNum = typeof p.volume === "number" && Number.isFinite(p.volume) ? p.volume : null;
  const lotNum = typeof p.lot === "number" && Number.isFinite(p.lot) ? p.lot : null;
  const v = volNum ?? lotNum;
  if (v == null) return payload;
  return { ...p, volume: v, lot: v };
}

// ── GET /api/mt5/demo-commands-poll ─────────────────────────────────────────
router.get("/mt5/demo-commands-poll", bridgeAuthPerUserOnly, async (req, res) => {
  const conn = (req as Request & { mt5Connection?: Mt5Connection }).mt5Connection;
  if (!conn || conn.userId == null) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }
  const userId = conn.userId;

  // Re-evaluate the per-user gate at poll time. EA never sees a command
  // if the gate would refuse — even if the row is in SENT_TO_MT5_DEMO.
  const gate = await evaluatePerUserDispatchGate({
    userId,
    userConfirmed: true,
    duplicateClear: true,
  });

  if (!gate.eligibility.eligible) {
    try {
      await recordSecurityEvent({
        eventType: "DEMO_POLL_REFUSED",
        severity: "WARNING",
        status: "DENIED",
        actorUserId: userId,
        route: "/api/mt5/demo-commands-poll",
        method: "GET",
        ipAddress: shortIp(req),
        userAgent: req.header("user-agent") ?? null,
        message: `EA poll refused: per-user gate failed (${gate.eligibility.blockers.join(",")}).`,
        metadata: {
          bridgeConnectionId: conn.id,
          perUserBlockers: gate.eligibility.blockers,
          reportedEaVersion: gate.evidence.reportedEaVersion,
          eaVersionAtLeast: gate.evidence.eaVersionAtLeast,
          armed: gate.evidence.armed,
          verifiedDemo: gate.evidence.verifiedDemo,
          accountTypeReported: gate.evidence.accountTypeReported,
          result: "REFUSED",
          reason: "PER_USER_GATE_FAILED",
        },
      });
    } catch { /* non-fatal */ }
    res.json({
      ok: true,
      commands: [],
      gateEligible: false,
      blockers: gate.eligibility.blockers,
      eaMinDemoVersion: gate.evidence.eaMinDemoVersion,
    });
    return;
  }

  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(
      and(
        eq(mt5DemoCommandsTable.userId, userId),
        eq(mt5DemoCommandsTable.bridgeConnectionId, conn.id),
        eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"),
      ),
    )
    .limit(25);

  // Return ONLY safe fields — never expose safetyGateSnapshot blobs to EA.
  const commands = rows.map((r) => ({
    commandId: r.commandId,
    commandType: r.commandType,
    payload: mirrorVolumeLot(r.payload),
    sentAt: r.sentAt?.toISOString() ?? null,
    eaVersionAtDispatch: r.eaVersionAtDispatch,
  }));

  try {
    await recordSecurityEvent({
      eventType: "DEMO_POLL_SERVED",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: userId,
      route: "/api/mt5/demo-commands-poll",
      method: "GET",
      ipAddress: shortIp(req),
      userAgent: req.header("user-agent") ?? null,
      message: `EA polled demo commands. ${commands.length} ready.`,
      metadata: {
        bridgeConnectionId: conn.id,
        count: commands.length,
        commandIds: commands.map((c) => c.commandId),
        result: "SERVED",
      },
    });
  } catch { /* non-fatal */ }

  res.json({
    ok: true,
    commands,
    gateEligible: true,
    eaMinDemoVersion: gate.evidence.eaMinDemoVersion,
  });
});

// ── POST /api/mt5/demo-command-result ───────────────────────────────────────
const resultBodySchema = z.object({
  commandId: z.string().min(1).max(64),
  status: z.enum(["FILLED_DEMO", "REJECTED", "FAILED"]),
  brokerOrderId: z.string().max(64).nullish(),
  brokerTicket: z.string().max(64).nullish(),
  filledPrice: z.number().finite().nullish(),
  filledVolume: z.number().finite().nullish(),
  filledAt: z.string().max(64).nullish(),
  reason: z.string().max(500).nullish(),
  reportedEaVersion: z.string().max(32).nullish(),
  raw: z.record(z.string(), z.unknown()).nullish(),
});

router.post("/mt5/demo-command-result", bridgeAuthPerUserOnly, async (req, res) => {
  const conn = (req as Request & { mt5Connection?: Mt5Connection }).mt5Connection;
  if (!conn || conn.userId == null) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }
  const userId = conn.userId;
  const parsed = resultBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_BODY", issues: parsed.error.issues });
    return;
  }

  // Defensive re-check: refuse FILLED_DEMO if account type isn't demo at
  // result time. The consumer wouldn't have dispatched, but a faulty EA
  // attempting to fake a fill on a live account is rejected here.
  if (parsed.data.status === "FILLED_DEMO") {
    const accountType = (conn.accountType ?? "unknown").toString();
    if (accountType !== "demo" && accountType !== "contest") {
      try {
        await recordSecurityEvent({
          eventType: "DEMO_RESULT_REFUSED",
          severity: "HIGH",
          status: "DENIED",
          actorUserId: userId,
          route: "/api/mt5/demo-command-result",
          method: "POST",
          ipAddress: shortIp(req),
          userAgent: req.header("user-agent") ?? null,
          message: `EA reported FILLED_DEMO on non-demo account (accountType=${accountType}). Refused.`,
          metadata: {
            bridgeConnectionId: conn.id,
            commandId: parsed.data.commandId,
            accountType,
            result: "REFUSED",
            reason: "ACCOUNT_TYPE_NOT_EXPLICIT_DEMO",
          },
        });
      } catch { /* non-fatal */ }
      res.status(400).json({ ok: false, reason: "ACCOUNT_TYPE_NOT_EXPLICIT_DEMO" });
      return;
    }
  }

  const result = await reconcileBrokerResult({
    userId,
    commandId: parsed.data.commandId,
    brokerResult: {
      status: parsed.data.status as BrokerReportedStatus,
      brokerOrderId: parsed.data.brokerOrderId ?? null,
      brokerTicket: parsed.data.brokerTicket ?? null,
      filledPrice: parsed.data.filledPrice ?? null,
      filledVolume: parsed.data.filledVolume ?? null,
      filledAt: parsed.data.filledAt ?? null,
      reason: parsed.data.reason ?? null,
      reportedEaVersion: parsed.data.reportedEaVersion ?? null,
      raw: parsed.data.raw ?? null,
    },
    actorIp: shortIp(req),
    actorUserAgent: req.header("user-agent") ?? null,
  });

  if (!result.ok) {
    res.status(result.reason === "COMMAND_NOT_FOUND" ? 404 : 409).json({
      ok: false,
      reason: result.reason,
    });
    return;
  }
  // Return only safe fields.
  res.json({
    ok: true,
    reason: result.reason,
    commandId: result.command?.commandId,
    status: result.command?.status,
  });
});

export default router;
