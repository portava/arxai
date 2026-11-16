// One-off, idempotent reconciler for PRE-FIX orphaned bridged Phase B live
// commands.
//
// PROBLEM (now fixed in POST /api/mt5/command-result):
//   The v1.50 EA only answers the legacy mt5_commands mailbox. A bridged Phase B
//   live command is mirrored into mt5_commands; the EA executes it and posts the
//   real broker result (retcode / brokerMessage / ticket) back onto the MIRROR
//   row. Before the forward branch existed, that terminal result was never
//   propagated to the authoritative arx_live_commands record, so the live row
//   stayed SENT_TO_MT5_LIVE forever and its exposure reservation never settled.
//
// WHAT THIS DOES:
//   For every arx_live_commands row still in SENT_TO_MT5_LIVE, finds its bridged
//   mt5_commands mirror (payload.bridged='LIVE_PHASE_B', payload.liveCommandId =
//   command_id) and, IF that mirror has reached a terminal broker state, forwards
//   the REAL stored broker result through recordLiveCommandResult — the exact
//   same path the live handler now runs automatically. This settles the exposure
//   reservation and writes the standard audit. It NEVER fabricates a result and
//   NEVER calls a broker; it only propagates broker truth already stored on the
//   mirror.
//
// SAFETY:
//   - Reads broker outcome ONLY from the mirror row's persisted columns.
//   - recordLiveCommandResult re-applies bridge-binding + exactly-once CAS, so a
//     row that raced to terminal is treated as a duplicate, never overwritten.
//   - DRY-RUN by default. Pass --apply to forward.
//
// USAGE (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/__qa__/forwardBridgedLiveResults.ts
//   pnpm --filter @workspace/api-server exec tsx src/__qa__/forwardBridgedLiveResults.ts -- --apply

import { and, eq, sql } from "drizzle-orm";
import { db, arxLiveCommandsTable as n, mt5CommandsTable } from "@workspace/db";
import {
  recordLiveCommandResult,
  mapBridgedLiveOutcome,
} from "../lib/live/liveCommandPipeline.js";
import { logger } from "../lib/logger.js";

const APPLY = process.argv.includes("--apply");
const ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const ONLY = ONLY_ARG ? ONLY_ARG.slice("--only=".length) : null;

const TERMINAL_MIRROR = /fill|filled|reject|fail|error/i;

async function main(): Promise<void> {
  const orphans = await db
    .select()
    .from(n)
    .where(eq(n.status, "SENT_TO_MT5_LIVE"));

  if (orphans.length === 0) {
    logger.info("No SENT_TO_MT5_LIVE live commands. Nothing to reconcile.");
    return;
  }

  logger.info(
    `${APPLY ? "APPLY" : "DRY-RUN"} — ${orphans.length} live command(s) in SENT_TO_MT5_LIVE`,
  );

  for (const row of orphans) {
    if (ONLY && row.commandId !== ONLY) continue;
    const [mirror] = await db
      .select()
      .from(mt5CommandsTable)
      .where(
        and(
          sql`${mt5CommandsTable.payload} ->> 'bridged' = 'LIVE_PHASE_B'`,
          sql`${mt5CommandsTable.payload} ->> 'liveCommandId' = ${row.commandId}`,
        ),
      )
      .orderBy(sql`${mt5CommandsTable.id} desc`)
      .limit(1);

    if (!mirror) {
      logger.info(`  ${row.commandId}: no bridged mirror found — skip`);
      continue;
    }
    if (!TERMINAL_MIRROR.test(mirror.status)) {
      logger.info(
        `  ${row.commandId}: mirror ${mirror.id} not terminal (status=${mirror.status}) — skip`,
      );
      continue;
    }

    const brokerTicket = mirror.mt5PositionTicket ?? mirror.mt5OrderTicket ?? null;
    const mirrorReason = (() => {
      const rp = mirror.resultPayload as Record<string, unknown> | null;
      const r = rp?.["reason"];
      return typeof r === "string" ? r : null;
    })();
    const outcome = mapBridgedLiveOutcome({
      status: mirror.status,
      reason: mirrorReason,
      hasBrokerTicket: brokerTicket != null,
    });
    logger.info(
      `  ${row.commandId}: mirror ${mirror.id} ${mirror.status} → ${outcome} ` +
        `(retcode=${mirror.mt5Retcode ?? "—"}, msg="${mirror.brokerMessage ?? "—"}", ` +
        `ticket=${brokerTicket ?? "—"})`,
    );

    if (!APPLY) continue;

    const userId = row.userId;
    if (userId == null) {
      logger.info(`  ${row.commandId}: null userId — skip`);
      continue;
    }

    const reportingBridgeConnectionId =
      row.bridgeConnectionId ?? mirror.mt5ConnectionId;
    if (reportingBridgeConnectionId == null) {
      logger.info(`  ${row.commandId}: no bridge connection id — skip`);
      continue;
    }

    const result = await recordLiveCommandResult({
      userId,
      commandId: row.commandId,
      outcome,
      reportingBridgeConnectionId,
      brokerTicket: brokerTicket != null ? String(brokerTicket) : null,
      fillPrice: mirror.fillPrice != null ? Number(mirror.fillPrice) : null,
      executedVolume:
        mirror.filledLotSize != null ? Number(mirror.filledLotSize) : null,
      mt5Retcode: mirror.mt5Retcode ?? null,
      brokerMessage: mirror.brokerMessage ?? null,
      eaReason: mirrorReason,
    });
    logger.info(
      `    forwarded: ok=${result.ok} reason=${result.reason ?? "—"} ` +
        `finalStatus=${result.command?.status ?? "—"}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "forwardBridgedLiveResults failed");
    process.exit(1);
  });
