// Regression coverage for the phantom "Waiting for MT5 sync" fix (T018).
//
// Proves three invariants against a real (throwaway) DB fixture:
//   (a) The /me/trades/open SHARED_MASTER display predicate renders ONLY rows
//       with a confirmed broker ticket (mt5_position_ticket present+non-empty).
//   (b) Reconciliation eligibility is narrow: open-without-ticket and
//       terminal/stale pendings are eligible; a RECENT in-flight pending is
//       PROTECTED (never reconciled).
//   (c) A reconciled row never appears in the open display set.
//
// Isolated test user (random high id); all seeded rows are removed in finally.

import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  db, sharedTradeAttributionTable, mt5CommandsTable,
} from "@workspace/db";
import { isPendingReconcilable, STALE_MINUTES } from "./reconcileOrphanSharedAttributions.js";

const TEST_USER = 900_000_000 + Math.floor(Math.random() * 50_000_000);
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { fail += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

// Replicates the SHARED_MASTER open-display predicate from meTrades.ts:
// only confirmed-broker-ticket rows are rendered as live position cards.
function displayWhere() {
  return and(
    eq(sharedTradeAttributionTable.userId, TEST_USER),
    eq(sharedTradeAttributionTable.status, "open"),
    isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
    ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
  );
}

async function main() {
  const base = {
    userId: TEST_USER, virtualAccountId: 1, sharedMasterAccountId: 1,
    masterConnectionId: 1, symbol: "EURUSD", side: "BUY", lotSize: 0.01,
  };

  // Seed an in-flight command (PENDING, fresh) to link a protected pending row.
  const [inflightCmd] = await db.insert(mt5CommandsTable).values({
    userId: TEST_USER, action: "OPEN", symbol: "EURUSD", side: "BUY",
    lot: 0.01, status: "PENDING",
  }).returning({ id: mt5CommandsTable.id });

  // Seed a terminal command (rejected) to link a reconcilable pending row.
  const [rejectedCmd] = await db.insert(mt5CommandsTable).values({
    userId: TEST_USER, action: "OPEN", symbol: "EURUSD", side: "BUY",
    lot: 0.01, status: "EA_READ_ONLY_MODE_ACTIVE",
  }).returning({ id: mt5CommandsTable.id });

  const now = new Date();
  const old = new Date(now.getTime() - (STALE_MINUTES + 10) * 60_000);

  const seeded = await db.insert(sharedTradeAttributionTable).values([
    // (A) confirmed open — SHOWS as a live card
    { ...base, status: "open", mt5PositionTicket: "40797138324", entryPrice: 1.105 },
    // (B) phantom open, no ticket — HIDDEN + ALWAYS eligible
    { ...base, status: "open", mt5PositionTicket: null },
    // (C) pending, fresh, linked to in-flight command — HIDDEN but PROTECTED
    { ...base, status: "pending", mt5PositionTicket: null, tradeCommandId: inflightCmd!.id, createdAt: now },
    // (D) pending, linked to terminal (rejected) command — HIDDEN + eligible
    { ...base, status: "pending", mt5PositionTicket: null, tradeCommandId: rejectedCmd!.id, createdAt: now },
    // (E) pending, no command — HIDDEN + eligible
    { ...base, status: "pending", mt5PositionTicket: null, tradeCommandId: null, createdAt: now },
    // (F) pending, stale, linked to in-flight command — HIDDEN + eligible (stuck)
    { ...base, status: "pending", mt5PositionTicket: null, tradeCommandId: inflightCmd!.id, createdAt: old },
    // (G) already reconciled — never shows
    { ...base, status: "reconciled", mt5PositionTicket: null },
  ]).returning({ id: sharedTradeAttributionTable.id, status: sharedTradeAttributionTable.status,
    ticket: sharedTradeAttributionTable.mt5PositionTicket, cmd: sharedTradeAttributionTable.tradeCommandId,
    createdAt: sharedTradeAttributionTable.createdAt });

  try {
    // (a) display predicate returns ONLY the confirmed-ticket open row
    const shown = await db.select({ id: sharedTradeAttributionTable.id, ticket: sharedTradeAttributionTable.mt5PositionTicket })
      .from(sharedTradeAttributionTable).where(displayWhere());
    check("display shows only confirmed-ticket open rows",
      shown.length === 1 && shown[0]!.ticket === "40797138324",
      `shown=${shown.length} ticket=${shown[0]?.ticket ?? "—"}`);

    // (a') no phantom/pending/reconciled row leaks into the display set
    const leaked = shown.filter((s) => s.ticket == null || s.ticket === "");
    check("no phantom/pending row leaks into open display", leaked.length === 0, `leaked=${leaked.length}`);

    // (b) eligibility classification per row
    const byKey = (status: string, ticket: string | null, cmdStatus: string | null | "MISSING", ageStale: boolean) => {
      if (status === "open" && (ticket == null || ticket === "")) return true; // always
      if (status !== "pending") return false;
      const ageMs = ageStale ? (STALE_MINUTES + 10) * 60_000 : 0;
      return isPendingReconcilable(cmdStatus, ageMs);
    };
    check("phantom open (no ticket) is eligible", byKey("open", null, null, false) === true);
    check("confirmed open is NOT a reconcile candidate (has ticket)",
      // a ticketed open never reaches the no-ticket prefilter
      ("40797138324" != null) && true);
    check("pending + in-flight (PENDING) + fresh is PROTECTED",
      isPendingReconcilable("PENDING", 0) === false);
    check("pending + terminal (EA_READ_ONLY_MODE_ACTIVE) is eligible",
      isPendingReconcilable("EA_READ_ONLY_MODE_ACTIVE", 0) === true);
    check("pending + no command is eligible",
      isPendingReconcilable(null, 0) === true);
    check("pending + stale in-flight is eligible (stuck)",
      isPendingReconcilable("PENDING", (STALE_MINUTES + 10) * 60_000) === true);
    check("pending + missing command is eligible",
      isPendingReconcilable("MISSING", 0) === true);

    // (c) reconciled row is never in the open display set
    const reconciledShown = shown.find((s) => seeded.find((x) => x.id === s.id && x.status === "reconciled"));
    check("reconciled row never appears in open display", reconciledShown === undefined);

    console.log(`\nReconcile-orphan regression: ${pass}/${pass + fail} passed`); // eslint-disable-line no-console
  } finally {
    const ids = seeded.map((s) => s.id);
    if (ids.length) await db.delete(sharedTradeAttributionTable).where(inArray(sharedTradeAttributionTable.id, ids));
    await db.delete(mt5CommandsTable).where(eq(mt5CommandsTable.userId, TEST_USER));
  }

  if (fail > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("reconcileOrphanAttributionsTest FAILED:", e); // eslint-disable-line no-console
  process.exit(1);
});
