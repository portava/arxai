// Idempotent reconciliation for phantom "Waiting for MT5 sync" cards in the
// Shared Master path.
//
// PROBLEM:
//   shared_trade_attribution rows can be left in status 'open' or 'pending'
//   with NO mt5_position_ticket (the broker never confirmed an MT5 execution).
//   The old GET /me/trades/open rendered status='open' rows as live position
//   cards regardless of whether a real broker ticket existed, so these
//   unconfirmed/orphan rows showed forever as "Waiting for MT5 sync".
//
// WHAT THIS DOES:
//   Moves *proven-terminal* orphan attribution rows (no broker ticket) into a
//   terminal 'reconciled' status with an explicit rejection_reason. This is a
//   LEDGER correction, not a broker action.
//
// ELIGIBILITY (narrow on purpose — never reconcile an in-flight command):
//   - status='open'  + no ticket  → ALWAYS eligible. A row cannot be "open" at
//     the broker without a position ticket, so this is definitionally phantom.
//   - status='pending' + no ticket → eligible ONLY when the order is no longer
//     in flight, i.e. ANY of:
//        * no linked trade command (tradeCommandId IS NULL), or
//        * the linked mt5_commands row no longer exists, or
//        * the linked command status is NOT in the in-flight set
//          (PENDING / DELIVERED / DEMO_APPROVED / SENT_TO_MT5_DEMO /
//           SENT_TO_MT5_LIVE), i.e. it is terminal (REJECTED/FAILED/EXPIRED/
//           EA_READ_ONLY_MODE_ACTIVE/…), or
//        * the row is older than STALE_MINUTES (stuck regardless of status).
//     A recent pending row whose command is still in flight is NEVER touched.
//
// SAFETY:
//   - Touches ONLY shared_trade_attribution rows with no broker ticket.
//     A row carrying a real mt5_position_ticket is NEVER touched.
//   - Sends NO command to any broker / EA. No position is closed at the broker
//     because none ever existed (there is no ticket to close).
//   - Preserves history: the row is kept (never deleted); only status and
//     rejection_reason change, and a fail-closed admin_action_audit_log row is
//     written in the SAME transaction.
//   - DRY-RUN by default: prints what it WOULD do. Pass `--apply` to mutate.
//   - Optional scope: `--user=<id>` limits the sweep to one user.
//   - Re-runnable: after a successful apply the eligibility filter matches none.
//
// USAGE:
//   pnpm --filter @workspace/scripts run reconcile:orphan-attributions            # dry-run, all users
//   pnpm --filter @workspace/scripts run reconcile:orphan-attributions -- --apply # mutate, all users
//   pnpm --filter @workspace/scripts run reconcile:orphan-attributions -- --apply --user=4

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db, sharedTradeAttributionTable, mt5CommandsTable, adminActionAuditLogTable,
} from "@workspace/db";

export const STALE_MINUTES = 30;
export const IN_FLIGHT_COMMAND_STATUSES = new Set([
  "PENDING", "DELIVERED", "DEMO_APPROVED", "SENT_TO_MT5_DEMO", "SENT_TO_MT5_LIVE",
]);

// Pure eligibility for a no-ticket pending attribution row. `cmdStatus` is the
// linked mt5_commands status, or null (no command), or "MISSING" (command row
// gone). A pending row is reconcilable when its order is no longer in flight,
// or it is stale regardless. A recent, still-in-flight command is protected.
export function isPendingReconcilable(
  cmdStatus: string | null | "MISSING", ageMs: number,
): boolean {
  const inFlight = typeof cmdStatus === "string" && cmdStatus !== "MISSING"
    && IN_FLIGHT_COMMAND_STATUSES.has(cmdStatus);
  if (!inFlight) return true;
  return ageMs > STALE_MINUTES * 60_000;
}

const RECONCILE_REASON =
  "RECONCILED_NO_BROKER_POSITION: no MT5 position ticket was ever confirmed " +
  "for this attribution (unconfirmed open). Closed to ledger as reconciled; " +
  "no broker close was sent because no real position exists.";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const userArg = args.find((a) => a.startsWith("--user="));
  let userId: number | null = null;
  if (userArg) {
    const raw = userArg.split("=")[1];
    userId = Number(raw);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`Invalid --user value: ${JSON.stringify(raw)} (must be a positive integer)`);
    }
  }
  return { apply, userId };
}

function hasNoTicket(t: string | null | undefined): boolean {
  return t == null || t === "";
}

async function commandStatusFor(commandId: number | null): Promise<string | null | "MISSING"> {
  if (commandId == null) return null;
  const [cmd] = await db.select({ status: mt5CommandsTable.status })
    .from(mt5CommandsTable).where(eq(mt5CommandsTable.id, commandId)).limit(1);
  return cmd ? cmd.status : "MISSING";
}

async function main() {
  const { apply, userId } = parseArgs();
  const log = (...a: unknown[]) => console.log("[reconcileOrphanSharedAttributions]", ...a); // eslint-disable-line no-console

  log(apply ? "APPLY mode — will mutate." : "DRY-RUN — no writes. Pass --apply to mutate.");
  if (userId != null) log(`Scope: user_id=${userId}`);

  // Step 1: narrow to no-ticket rows in open/pending (cheap SQL prefilter).
  const baseWhere = and(
    inArray(sharedTradeAttributionTable.status, ["open", "pending"]),
    or(
      isNull(sharedTradeAttributionTable.mt5PositionTicket),
      eq(sharedTradeAttributionTable.mt5PositionTicket, ""),
    )!,
    ...(userId != null ? [eq(sharedTradeAttributionTable.userId, userId)] : []),
  );
  const candidates = await db.select().from(sharedTradeAttributionTable).where(baseWhere);

  // Step 2: per-row eligibility (protect in-flight pendings).
  const now = Date.now();
  const staleMs = STALE_MINUTES * 60_000;
  const eligible: { id: number; userId: number; symbol: string; side: string;
    lotSize: number; status: string; tradeCommandId: number | null;
    cmdStatus: string | null | "MISSING"; reason: string }[] = [];
  const skipped: { id: number; status: string; cmdStatus: string | null | "MISSING"; ageMin: number }[] = [];

  for (const r of candidates) {
    if (!hasNoTicket(r.mt5PositionTicket)) continue; // safety belt
    const ageMs = now - new Date(r.createdAt as unknown as string).getTime();
    const ageMin = Math.round(ageMs / 60_000);

    if (r.status === "open") {
      eligible.push({ id: r.id, userId: r.userId, symbol: r.symbol, side: r.side,
        lotSize: r.lotSize, status: r.status, tradeCommandId: r.tradeCommandId ?? null,
        cmdStatus: null, reason: "open_without_ticket" });
      continue;
    }

    // pending
    const cmdStatus = await commandStatusFor(r.tradeCommandId ?? null);
    if (isPendingReconcilable(cmdStatus, ageMs)) {
      const reason = ageMs > staleMs
        ? `pending_stale_${ageMin}m_cmd:${cmdStatus}`
        : cmdStatus == null ? "pending_no_command"
          : cmdStatus === "MISSING" ? "pending_command_missing"
            : `pending_command_terminal:${cmdStatus}`;
      eligible.push({ id: r.id, userId: r.userId, symbol: r.symbol, side: r.side,
        lotSize: r.lotSize, status: r.status, tradeCommandId: r.tradeCommandId ?? null,
        cmdStatus, reason });
    } else {
      skipped.push({ id: r.id, status: r.status, cmdStatus, ageMin });
    }
  }

  log(`Candidates(no-ticket open/pending): ${candidates.length} | eligible: ${eligible.length} | protected in-flight: ${skipped.length}`);
  for (const e of eligible) {
    log(`  ELIGIBLE id=${e.id} u=${e.userId} ${e.symbol} ${e.side} lot=${e.lotSize} status=${e.status} cmd=${e.tradeCommandId ?? "—"} → ${e.reason}`);
  }
  for (const s of skipped) {
    log(`  PROTECTED id=${s.id} status=${s.status} cmd=${s.cmdStatus} age=${s.ageMin}m (in-flight, recent)`);
  }

  if (!apply) { log("DRY-RUN complete. No rows changed."); return; }
  if (eligible.length === 0) { log("Nothing to reconcile. ✓"); return; }

  const nowDate = new Date();
  let reconciled = 0;
  for (const e of eligible) {
    await db.transaction(async (tx) => {
      // Guarded update: re-assert no-ticket + still open/pending at write time.
      const updated = await tx.update(sharedTradeAttributionTable).set({
        status: "reconciled",
        rejectionReason: RECONCILE_REASON,
        updatedAt: nowDate,
      }).where(and(
        eq(sharedTradeAttributionTable.id, e.id),
        inArray(sharedTradeAttributionTable.status, ["open", "pending"]),
        or(
          isNull(sharedTradeAttributionTable.mt5PositionTicket),
          eq(sharedTradeAttributionTable.mt5PositionTicket, ""),
        )!,
      )).returning({ id: sharedTradeAttributionTable.id });

      if (updated.length === 0) return; // changed under us — skip, no audit

      await tx.insert(adminActionAuditLogTable).values({
        adminId: null,
        adminRole: "SYSTEM",
        action: "RECONCILE_ORPHAN_ATTRIBUTION",
        targetUserId: e.userId,
        beforeState: {
          attributionId: e.id, status: e.status, symbol: e.symbol, side: e.side,
          lotSize: e.lotSize, tradeCommandId: e.tradeCommandId,
          linkedCommandStatus: e.cmdStatus, eligibilityReason: e.reason,
        },
        afterState: { attributionId: e.id, status: "reconciled", rejectionReason: RECONCILE_REASON },
        reason: RECONCILE_REASON,
      });
      reconciled += 1;
    });
  }
  log(`Reconciled ${reconciled} row(s). ✓`);
}

const invokedDirectly = process.argv[1]?.endsWith("reconcileOrphanSharedAttributions.ts");
if (invokedDirectly) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("[reconcileOrphanSharedAttributions] FAILED:", e); // eslint-disable-line no-console
    process.exit(1);
  });
}
