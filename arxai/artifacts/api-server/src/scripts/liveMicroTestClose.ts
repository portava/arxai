// One-shot gated CLOSE of the open live micro-test position (task #399).
//
// WHY THIS EXISTS: the Live Test Cycle auto-close is one-shot — once a close
// command exists it never re-dispatches. The cycle's first close reached the EA
// with NO position ticket (a real Bridge v2 bug: createLiveOpsDraft stores the
// broker ticket in payload.brokerTicket but enqueueBridgedMt5Command only read
// the broker_ticket COLUMN, which is null for CLOSE), so the EA tried to close
// ticket 0 → POSITION_NOT_FOUND and the real position stayed open. The mirror
// now reads the ticket from column OR payload. This harness closes the genuinely
// open position through the SAME gated pipeline (createLiveOpsDraft → confirm →
// dispatch → 16-gate → EA mailbox) using the fixed code, then verifies a REAL
// fill. It re-implements no gate and fabricates nothing.
//
// SAFETY: closes exactly the ONE open micro-test position (EURUSD ticket
// 40804303282). Every gate, integrity check, and kill-switch re-check still
// runs. Run with --apply to actually dispatch; default prints intent only.

import { and, eq } from "drizzle-orm";
import { db, arxLiveCommandsTable, arxLivePositionsTable } from "@workspace/db";
import {
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
} from "../lib/live/liveCommandPipeline.js";

const USER_ID = 4;
const BROKER_TICKET = "40804303282";
const SYMBOL = "EURUSD";
const SIDE = "BUY" as const;
const VOLUME = 0.01;
const APPLY = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadPosition() {
  const [pos] = await db
    .select()
    .from(arxLivePositionsTable)
    .where(
      and(
        eq(arxLivePositionsTable.userId, USER_ID),
        eq(arxLivePositionsTable.brokerTicket, BROKER_TICKET),
      ),
    )
    .limit(1);
  return pos ?? null;
}

async function main() {
  console.log(`\n=== LIVE MICRO-TEST CLOSE (apply=${APPLY}) ===`);
  const before = await loadPosition();
  if (!before) {
    console.log(`Position ${BROKER_TICKET} not found for user ${USER_ID} — nothing to close.`);
    return;
  }
  console.log(
    `Open position: ticket=${before.brokerTicket} ${before.symbol} ${before.side} ` +
      `vol=${before.volume} entry=${before.entryPrice} floating=${before.floatingPl} ` +
      `closedAt=${before.closedAt ?? "NULL"} lastSynced=${before.lastSyncedAt?.toISOString() ?? "?"}`,
  );
  if (before.closedAt) {
    console.log("Position already has closed_at — nothing to do.");
    return;
  }
  if (!APPLY) {
    console.log("\nDRY RUN — would createLiveOpsDraft(CLOSE) → confirm → dispatch. Re-run with --apply.");
    return;
  }

  // 1. DRAFT
  const draft = await createLiveOpsDraft({
    userId: USER_ID,
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: BROKER_TICKET,
    symbol: SYMBOL,
    side: SIDE,
    volume: VOLUME,
    sourcePage: "CONTROLLED_LIVE_TEST",
  });
  if (!draft.ok) {
    console.log(`DRAFT FAILED: ${draft.reason}${draft.detail ? ` (${draft.detail})` : ""}`);
    return;
  }
  const commandId = draft.command.commandId;
  console.log(`DRAFT ok: commandId=${commandId}`);

  // 2. CONFIRM
  const conf = await confirmLiveCommand({ userId: USER_ID, commandId });
  if (!conf.ok) {
    console.log(`CONFIRM FAILED: ${(conf as { reason?: string }).reason}`);
    return;
  }
  console.log("CONFIRM ok");

  // 3. DISPATCH (16-gate + integrity + mirror into mt5_commands with positionTicket)
  const disp = (await dispatchLiveCommand({ userId: USER_ID, commandId })) as {
    ok?: boolean;
    primaryReason?: string;
  };
  if (disp.ok !== true) {
    console.log(`DISPATCH BLOCKED: ${disp.primaryReason ?? "UNKNOWN"}`);
    return;
  }
  console.log("DISPATCH ok — close command mirrored to EA mailbox. Polling for real fill…");

  // 4. POLL the close command + position until terminal (max 50 × 4s = 200s)
  for (let i = 1; i <= 50; i++) {
    await sleep(4000);
    const [cmd] = await db
      .select()
      .from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, commandId))
      .limit(1);
    const pos = await loadPosition();
    const cs = cmd?.status ?? "?";
    console.log(
      `  poll#${i} cmd=${cs} retcode=${cmd?.mt5Retcode ?? "-"} fill=${cmd?.fillPrice ?? "-"} ` +
        `brokerTicket=${cmd?.brokerTicket ?? "-"} reject=${cmd?.rejectionReason ?? "-"} ` +
        `posClosedAt=${pos?.closedAt?.toISOString() ?? "NULL"} posFloating=${pos?.floatingPl ?? "-"}`,
    );
    const terminal =
      cs === "LIVE_FILLED" || cs === "LIVE_REJECTED" || cs === "LIVE_FAILED" ||
      cs === "LIVE_BLOCKED" || cs === "LIVE_EXPIRED";
    if (terminal) {
      console.log(`\n=== CLOSE TERMINAL: ${cs} ===`);
      if (cmd) {
        console.log(JSON.stringify({
          commandId: cmd.commandId,
          status: cmd.status,
          brokerTicket: cmd.brokerTicket,
          fillPrice: cmd.fillPrice,
          mt5Retcode: cmd.mt5Retcode,
          brokerMessage: cmd.brokerMessage,
          rejectionReason: cmd.rejectionReason,
          filledAt: cmd.filledAt,
        }, null, 2));
      }
      const finalPos = await loadPosition();
      console.log(`Position closedAt=${finalPos?.closedAt?.toISOString() ?? "NULL"}`);
      return;
    }
  }
  console.log("\nPoll budget exhausted — close still not terminal. Check DB.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
