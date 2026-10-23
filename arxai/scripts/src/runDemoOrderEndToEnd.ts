// One-shot end-to-end driver for the demo bridge verification flow.
//
// Drives the queue services directly as user 4 (bypassing HTTP auth, but
// going through every per-user gate, the partial-unique-index belt, and
// the consumer dispatch chokepoint). Polls until the command reaches a
// terminal state or timeout.
//
// SAFETY: live trading is unaffected. canDispatchToMt5 still refuses
// outside DEMO mode; the consumer re-runs the per-user dispatch gate.

import { eq, and, desc } from "drizzle-orm";
import { db, mt5DemoCommandsTable } from "@workspace/db";
import {
  cancelOrphanedSentCommands,
  createDraftCommand,
  confirmCommand,
} from "../../artifacts/api-server/src/lib/mt5/demoCommandQueue.js";
import { consumeApprovedCommand } from "../../artifacts/api-server/src/lib/mt5/demoCommandConsumer.js";

const USER_ID = 4;
const POLL_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 2_000;

async function snapshot(commandId: string) {
  const r = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.commandId, commandId))
    .limit(1);
  return r[0] ?? null;
}

async function main() {
  console.log("=== DEMO ORDER E2E DRIVER (user 4) ===");

  // STEP 1: idempotent cleanup of any remaining orphans.
  const cleanup = await cancelOrphanedSentCommands({
    userId: USER_ID,
    actorIp: "127.0.0.1",
    actorUserAgent: "runDemoOrderEndToEnd-script",
  });
  console.log("STEP 1 cleanup:", cleanup);

  // STEP 3: create draft + confirm.
  const draft = await createDraftCommand({
    userId: USER_ID,
    commandType: "PLACE_MARKET_ORDER",
    payload: { symbol: "EURUSD", side: "BUY", volume: 0.01 },
    actorIp: "127.0.0.1",
    actorUserAgent: "runDemoOrderEndToEnd-script",
  });
  if (!draft.ok || !draft.command) {
    console.log("STEP 3 draft FAILED:", draft);
    process.exit(1);
  }
  const cmdId = draft.command.commandId;
  console.log("STEP 3 draft:", {
    id: draft.command.id,
    commandId: cmdId,
    status: draft.command.status,
    bridgeConnectionId: draft.command.bridgeConnectionId,
  });

  const confirmed = await confirmCommand({
    userId: USER_ID,
    commandId: cmdId,
    actorIp: "127.0.0.1",
    actorUserAgent: "runDemoOrderEndToEnd-script",
  });
  if (!confirmed.ok || !confirmed.command) {
    console.log("STEP 3 confirm FAILED:", confirmed);
    process.exit(1);
  }
  console.log("STEP 3 confirm:", {
    status: confirmed.command.status,
    bridgeConnectionId: confirmed.command.bridgeConnectionId,
  });

  // STEP 4: dispatch (writes SENT_TO_MT5_DEMO via consumer + fingerprint).
  const dispatched = await consumeApprovedCommand({
    userId: USER_ID,
    commandId: cmdId,
    actorIp: "127.0.0.1",
    actorUserAgent: "runDemoOrderEndToEnd-script",
  });
  console.log("STEP 4 dispatch:", {
    ok: dispatched.ok,
    reason: dispatched.reason,
    status: dispatched.command?.status,
    bridgeConnectionId: dispatched.command?.bridgeConnectionId,
    fingerprint: (dispatched.command as { fingerprint?: string } | undefined)?.fingerprint?.slice(0, 16),
  });

  if (!dispatched.ok) {
    console.log("Dispatch refused. Aborting wait loop.");
    process.exit(2);
  }

  // STEP 5/6/7: poll until terminal.
  const start = Date.now();
  let last: Awaited<ReturnType<typeof snapshot>> | null = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    last = await snapshot(cmdId);
    if (!last) break;
    if (
      last.status === "FILLED_DEMO" ||
      last.status === "REJECTED" ||
      last.status === "FAILED"
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log("STEP 5 final:", {
    id: last?.id,
    commandId: last?.commandId,
    status: last?.status,
    reason: last?.reason,
    brokerTicket: last?.brokerTicket,
    fillPrice: last?.fillPrice,
    filledAt: last?.filledAt,
    sentAt: last?.sentAt,
    bridgeConnectionId: last?.bridgeConnectionId,
    elapsedMs: Date.now() - start,
  });

  // STEP 6: if REJECTED, surface broker reason.
  if (last?.status === "REJECTED") {
    console.log("STEP 6 broker rejection reason:", last.reason);
  }
  // STEP 7: if FILLED, show fill fields.
  if (last?.status === "FILLED_DEMO") {
    console.log("STEP 7 fill:", {
      brokerTicket: last.brokerTicket,
      symbol: (last.payload as { symbol?: string } | null)?.symbol,
      side: (last.payload as { side?: string } | null)?.side,
      volume: (last.payload as { volume?: number } | null)?.volume,
      fillPrice: last.fillPrice,
      filledAt: last.filledAt,
    });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("driver crashed:", err);
  process.exit(1);
});
