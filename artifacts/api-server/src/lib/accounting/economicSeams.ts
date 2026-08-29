// Seam-level posting composers — the ONLY functions the execution seams call.
//
// Each composes @workspace/accounting builders into the journals one seam
// event produces, then persists them via the best-effort writer. All entry
// points are try/caught to nothing: a posting failure warns and returns; it
// can never disturb the settlement that invoked it.
//
// HONESTY RULES APPLIED HERE:
//   - MT5's EA result carries NO commission figure → the open posts an
//     EXPLICIT UNKNOWN fee journal (flagged zero), never a silent zero.
//   - The close's realized P&L comes from the position row's last-synced
//     floatingPl — a LOCAL_EXECUTION source, and it is labelled as such so
//     the reconciliation pass ranks it honestly below broker figures. When
//     it is null, the P&L journal is UNKNOWN-flagged.
//   - The account currency is read from the reporting bridge's connection
//     row. When it is absent, NO amount is claimed in a guessed currency:
//     the journal degrades to UNKNOWN-flagged legs with the reason recorded.
//   - Deriv guided demo fills are genuinely USD (guidedBuy pins currency
//     "USD") and post to the DEMO ledger partition — demo money never
//     touches the LIVE partition.

import { Money } from "@workspace/money";
import {
  buildTradeOpenJournals, buildTradeCloseJournals,
  type EconomicJournal,
} from "@workspace/accounting";
import { db, mt5ConnectionTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { writeEconomicJournals } from "./economicPostingWriter.js";

/** ISO-4217-shaped account currency from the bridge connection row, or null. */
async function bridgeAccountCurrency(bridgeConnectionId: number | null | undefined): Promise<string | null> {
  if (bridgeConnectionId == null) return null;
  try {
    const [row] = await db.select({ c: mt5ConnectionTable.accountCurrency })
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, bridgeConnectionId))
      .limit(1);
    const c = row?.c?.trim().toUpperCase();
    return c && /^[A-Z]{3}$/.test(c) ? c : null;
  } catch {
    return null; // honest null — the caller degrades to UNKNOWN, never guesses
  }
}

/**
 * Fill-confirmation seam (LIVE ledger): a PLACE order filled (fully or
 * partially). No cash moves at open on an MT5 margin account, and the EA
 * result carries no commission — so the ONLY honest journal is an explicit
 * UNKNOWN open-fee marker tying the fee obligation to the trade.
 */
export async function postLiveOpenFill(args: {
  userId: number;
  commandId: string;
  brokerTicket: string | null;
  bridgeConnectionId: number | null;
  strategyId?: string | null;
  filledAt: Date;
}): Promise<void> {
  try {
    const currency = (await bridgeAccountCurrency(args.bridgeConnectionId)) ?? "USD";
    // The UNKNOWN legs carry zero, so the currency here denominates NOTHING —
    // it is the shell for a flagged unknown, recorded as such in metadata.
    const journals = buildTradeOpenJournals({
      journalIdBase: `ej_${args.commandId}_open`,
      ledger: "LIVE",
      source: "BROKER_EVENT", // the fill itself is broker-confirmed (ticket present)
      effectiveAt: args.filledAt,
      knownAt: new Date(),
      userId: args.userId,
      strategyId: args.strategyId ?? null,
      commandId: args.commandId,
      brokerTicket: args.brokerTicket,
      currency,
      fee: null, // fee event exists, amount NOT reported by the EA result → explicit UNKNOWN
      metadata: { seam: "fill_confirmation", feeUnknownReason: "EA_RESULT_CARRIES_NO_COMMISSION" },
    });
    await writeEconomicJournals(journals);
  } catch (e) {
    logger.warn({
      event: "ECONOMIC_OPEN_POSTING_FAILED", commandId: args.commandId,
      error: e instanceof Error ? e.message : String(e),
    }, "open-fill economic posting failed — fill settlement unaffected");
  }
}

/**
 * Close-reconciliation seam (LIVE ledger): a CLOSE command filled and the
 * position row was stamped closed. Posts the realized P&L journal (UNKNOWN-
 * flagged when the local record has no figure or the account currency is
 * unknown), plus an UNKNOWN close-fee marker for the same honesty reason as
 * the open.
 */
export async function postLiveClose(args: {
  userId: number;
  commandId: string;
  brokerTicket: string | null;
  bridgeConnectionId: number | null;
  strategyId?: string | null;
  /** Last-synced floating P/L captured at close, or null when unknown. */
  realizedPnl: number | null;
  closedAt: Date;
}): Promise<void> {
  try {
    const accountCurrency = await bridgeAccountCurrency(args.bridgeConnectionId);
    const currency = accountCurrency ?? "USD";
    const pnlKnown =
      accountCurrency != null
      && typeof args.realizedPnl === "number"
      && Number.isFinite(args.realizedPnl);
    const journals = buildTradeCloseJournals({
      journalIdBase: `ej_${args.commandId}_close`,
      ledger: "LIVE",
      // floatingPl is ARX's last-synced local record, NOT a broker statement.
      source: "LOCAL_EXECUTION",
      effectiveAt: args.closedAt,
      knownAt: new Date(),
      userId: args.userId,
      strategyId: args.strategyId ?? null,
      commandId: args.commandId,
      brokerTicket: args.brokerTicket,
      currency,
      realizedPnl: pnlKnown ? Money.of(args.realizedPnl as number, currency) : null,
      fee: null, // fee event exists at close, amount not reported → explicit UNKNOWN
      metadata: {
        seam: "close_reconciliation",
        ...(pnlKnown ? {} : {
          pnlUnknownReason: accountCurrency == null
            ? "ACCOUNT_CURRENCY_UNKNOWN"
            : "NO_LOCAL_PNL_RECORD",
        }),
        feeUnknownReason: "EA_RESULT_CARRIES_NO_COMMISSION",
      },
    });
    await writeEconomicJournals(journals);
  } catch (e) {
    logger.warn({
      event: "ECONOMIC_CLOSE_POSTING_FAILED", commandId: args.commandId,
      error: e instanceof Error ? e.message : String(e),
    }, "close economic posting failed — close settlement unaffected");
  }
}

/**
 * Guided demo settlement seam (DEMO ledger partition): the venue confirmed a
 * Deriv demo contract (venueContractRef present). The stake genuinely left
 * demo cash into the open contract — a real double-entry movement on the
 * DEMO partition. Currency is pinned USD by guidedBuy itself.
 */
export async function postDemoStakeFill(args: {
  userId: number;
  ticketId: string;
  venueContractRef: string;
  stakeUsd: number;
  filledAt: Date;
}): Promise<void> {
  try {
    if (!Number.isFinite(args.stakeUsd) || args.stakeUsd <= 0) {
      logger.warn({
        event: "ECONOMIC_DEMO_POSTING_SKIPPED", ticketId: args.ticketId, stakeUsd: args.stakeUsd,
      }, "demo stake posting skipped — stake is not a positive finite number; nothing fabricated");
      return;
    }
    const stake = Money.of(args.stakeUsd, "USD");
    const journals: EconomicJournal[] = buildTradeOpenJournals({
      journalIdBase: `ej_guided_${args.ticketId}`,
      ledger: "DEMO",
      source: "BROKER_EVENT", // venue-confirmed contract reference
      effectiveAt: args.filledAt,
      knownAt: new Date(),
      userId: args.userId,
      commandId: `gc_${args.ticketId}`,
      brokerTicket: args.venueContractRef,
      currency: "USD",
      stake,
      metadata: { seam: "guided_demo_settlement" },
    });
    await writeEconomicJournals(journals);
  } catch (e) {
    logger.warn({
      event: "ECONOMIC_DEMO_POSTING_FAILED", ticketId: args.ticketId,
      error: e instanceof Error ? e.message : String(e),
    }, "demo stake economic posting failed — guided settlement unaffected");
  }
}
