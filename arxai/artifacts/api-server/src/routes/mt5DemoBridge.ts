// Phase 28-MT5-DEMO-ARMING sub-phase 3B — EA-facing demo command surface.
//
// Two endpoints, both behind `bridgeAuthPerUserOnly`:
//
//   GET  /api/mt5/demo-commands-poll
//     Returns SENT_TO_MT5_DEMO commands owned by the user whose bridge
//     token authenticated the request, sent to THIS bridge, oldest-sent
//     first, each with `secondsUntilExpiry` / `expiresAtEpoch`. A command
//     past its TTL is not served (the expiry sweep FAILs it); EA v1.32
//     refuses one whose TTL ran out before it got to it. The per-user dispatch gate is
//     re-evaluated at request time — if the user is no longer eligible
//     (disarmed, gate failed, EA downgraded) the endpoint returns an
//     empty list and audits the refusal. Tokens, hashes, broker secrets,
//     and other users' commands are NEVER returned.
//
//   POST /api/mt5/demo-command-result
//     EA-driven write-back. Body identifies the command by commandId and
//     reports broker outcome (FILLED_DEMO | PLACED_DEMO | CANCELLED_DEMO |
//     REJECTED | FAILED). Routed through `reconcileBrokerResult`, scoped to
//     the reporting user AND bridge connection; only mutates rows in
//     SENT_TO_MT5_DEMO (or a row the expiry sweep FAILED, for a late broker
//     success) and is idempotent.
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
import { and, asc, eq } from "drizzle-orm";
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
import { scheduleGuardian } from "../lib/positionGuardian/reconcile.js";
import { DEMO_BROKER_RESULT_STATUSES } from "@workspace/domain/safety-contracts/executionMode";
import { buildDemoPollCommands, guardianTicketForResult } from "../lib/mt5/demoBridgeContract.js";
import { DEMO_COMMAND_TTL_MS } from "../lib/mt5/demoCommandQueue.js";

const router = Router();

function shortIp(req: Request): string {
  const xf = req.header("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? "";
  return req.ip ?? "";
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
    // Oldest-sent first: the EA executes in the order served, so an entry
    // is never run after a later close/modify of the same ticket.
    .orderBy(asc(mt5DemoCommandsTable.sentAt), asc(mt5DemoCommandsTable.id))
    .limit(25);

  // Return ONLY safe fields — never expose safetyGateSnapshot blobs to EA.
  // Expired rows are dropped here (and FAILED by the sweep).
  const commands = buildDemoPollCommands(rows, new Date(), DEMO_COMMAND_TTL_MS);

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
  status: z.enum(DEMO_BROKER_RESULT_STATUSES),
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
  if (parsed.data.status === "FILLED_DEMO" || parsed.data.status === "PLACED_DEMO" || parsed.data.status === "CANCELLED_DEMO") {
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
          message: `EA reported ${parsed.data.status} on non-demo account (accountType=${accountType}). Refused.`,
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
    // Only the bridge the command was sent to may report on it.
    bridgeConnectionId: conn.id,
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
  // Position Guardian — a confirmed MARKET entry fill starts protection
  // checks on its position ticket; a filled close re-checks what remains. A
  // PLACED_DEMO pending order is an order ticket, not a position: nothing is
  // scheduled until the order fills (executionReconciler promotes it).
  if (result.command) {
    const ticket = guardianTicketForResult({
      status: result.command.status,
      commandType: result.command.commandType,
      brokerTicket: result.command.brokerTicket,
      payload: result.command.payload,
    });
    if (ticket) scheduleGuardian("DEMO", userId, ticket, "fill");
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
