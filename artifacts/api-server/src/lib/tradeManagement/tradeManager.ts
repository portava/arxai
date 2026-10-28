import type { Trade } from "@workspace/db";
import { getLatestQuote } from "../data/dataManager.js";
import { decideContractSize, resolveContractSize, type ResolvedContractSize } from "../mt5/contractSize.js";
import { paperPnl } from "../paperExecution/paperPnl.js";
import { PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE, PNL_DATA_QUALITY_MISSING_FX } from "../live/realizedPnl.js";

export type SnapshotPnlDataQualityFlag = typeof PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE | typeof PNL_DATA_QUALITY_MISSING_FX;
import { tradeHealthScore, type TradeHealth } from "./monitoring/tradeHealthScore.js";
import { breakEvenSuggestion } from "./rules/breakEvenRules.js";
import { trailingStopSuggestion } from "./rules/trailingStopRules.js";
import { partialCloseSuggestion } from "./rules/partialCloseRules.js";
import { earlyExitSuggestion } from "./rules/earlyExitRules.js";

// Truth rule: Current / R / P&L / Health are only reported when a real quote
// was observed. With no quote they are null and `priceUnavailableReason` says
// why — never the entry price, $0.00 and 0.00R as if the trade were flat.
export interface TradeManagementSnapshot {
  tradeId: number;
  /** Last price from the market-data router; null when no quote was available. */
  currentPrice: number | null;
  /** Timestamp of the quote `currentPrice` came from; null when there is no quote. */
  quoteAt: string | null;
  /** Why currentPrice (and everything derived from it) is null; null when priced. */
  priceUnavailableReason: string | null;
  rMultiple: number | null;
  /**
   * Floating P&L in USD, contract-size aware (price move x lots x contract
   * size x quote->USD factor, the rule in lib/mt5/contractSize.ts). Null when
   * there is no price or the contract size / FX factor cannot be established.
   */
  floatingPnl: number | null;
  /** Why floatingPnl is null; null when it was sized. */
  pnlUnavailableReason: string | null;
  /** Which input was missing when a priced trade's P&L could not be sized. */
  pnlDataQualityFlag: SnapshotPnlDataQualityFlag | null;
  health: TradeHealth | null;
  suggestions: {
    breakEven: ReturnType<typeof breakEvenSuggestion>;
    trail: ReturnType<typeof trailingStopSuggestion>;
    partial: ReturnType<typeof partialCloseSuggestion>;
    earlyExit: ReturnType<typeof earlyExitSuggestion>;
  };
  primarySuggestion: string;
  invalidated: boolean;
}

function isPrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

export async function evaluateTrade(trade: Trade): Promise<TradeManagementSnapshot> {
  const quote = await getLatestQuote(trade.symbol);
  if (!isPrice(quote.last)) {
    const reason = `No current quote for ${trade.symbol} from the market-data feed — price, P&L, R and health cannot be measured right now.`;
    const unavailable = { recommended: false as const, reason };
    return {
      tradeId: trade.id,
      currentPrice: null,
      quoteAt: null,
      priceUnavailableReason: reason,
      rMultiple: null,
      floatingPnl: null,
      pnlUnavailableReason: reason,
      pnlDataQualityFlag: null,
      health: null,
      suggestions: { breakEven: unavailable, trail: unavailable, partial: unavailable, earlyExit: unavailable },
      primarySuggestion: reason,
      invalidated: false,
    };
  }
  const currentPrice = quote.last;
  const risk = Math.abs(trade.entryPrice - trade.stopLoss) || 1e-6;
  const direction = trade.direction === "BUY" ? 1 : -1;
  const rMultiple = ((currentPrice - trade.entryPrice) * direction) / risk;
  // Contract size: the trader's broker-reported symbol spec when the trade
  // has an owner, else only a fiat FX pair (100,000 units per lot) is sizable.
  // A failed spec read withholds the figure rather than assuming a lot size.
  let contract: ResolvedContractSize | null = null;
  let pnlUnavailableReason: string | null = null;
  if (trade.userId != null) {
    try {
      contract = await resolveContractSize(trade.userId, trade.symbol);
    } catch {
      pnlUnavailableReason = `Could not read the broker symbol spec for ${trade.symbol}, so P&L cannot be sized right now.`;
    }
  } else {
    contract = decideContractSize({ symbol: trade.symbol, brokerContractSize: null, brokerProfitCurrency: null });
  }
  let floatingPnl: number | null = null;
  let pnlDataQualityFlag: SnapshotPnlDataQualityFlag | null = PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE;
  if (contract) {
    const pnl = paperPnl({
      symbol: trade.symbol, direction: trade.direction, lots: trade.lot,
      entry: trade.entryPrice, price: currentPrice, contract,
    });
    floatingPnl = pnl.amount;
    pnlUnavailableReason = pnl.unavailableReason == null ? null : `P&L unavailable: ${pnl.unavailableReason}.`;
    pnlDataQualityFlag = pnl.amount != null ? null
      : contract.contractSize == null ? PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE : PNL_DATA_QUALITY_MISSING_FX;
  }

  const health = tradeHealthScore(trade, currentPrice);
  const suggestions = {
    breakEven: breakEvenSuggestion(trade, currentPrice, rMultiple),
    trail: trailingStopSuggestion(trade, currentPrice, rMultiple),
    partial: partialCloseSuggestion(trade, currentPrice, rMultiple),
    earlyExit: earlyExitSuggestion(trade, currentPrice, rMultiple, health.score),
  };

  const ranked: Array<{ suggestion: string; priority: number }> = [];
  if (suggestions.earlyExit.recommended) ranked.push({ suggestion: suggestions.earlyExit.reason, priority: 4 });
  if (suggestions.partial.recommended) ranked.push({ suggestion: suggestions.partial.reason, priority: 3 });
  if (suggestions.trail.recommended) ranked.push({ suggestion: suggestions.trail.reason, priority: 2 });
  if (suggestions.breakEven.recommended) ranked.push({ suggestion: suggestions.breakEven.reason, priority: 1 });
  ranked.sort((a, b) => b.priority - a.priority);

  return {
    tradeId: trade.id,
    currentPrice,
    quoteAt: quote.timestamp,
    priceUnavailableReason: null,
    rMultiple,
    floatingPnl,
    pnlUnavailableReason,
    pnlDataQualityFlag,
    health,
    suggestions,
    primarySuggestion: ranked[0]?.suggestion ?? "Hold — no action recommended.",
    invalidated: suggestions.earlyExit.recommended,
  };
}

export type PaperCloseOutcome =
  | { ok: false; reason: string }
  | {
    ok: true;
    status: "CLOSED_WIN" | "CLOSED_LOSS";
    exitPrice: number;
    /** Rounded USD P&L; null when it could not be sized (pnlStatus UNKNOWN). */
    pnl: number | null;
    pnlStatus: "UNKNOWN" | null;
    dataQualityFlag: SnapshotPnlDataQualityFlag | null;
    /** Plain-English result for the alert / response message. */
    resultText: string;
  };

/**
 * What a manual close of a legacy simulated trade may record. Refuses when
 * there is no current price (the close would book the entry price and $0.00);
 * when the price is known but P&L cannot be sized, the close is recorded with
 * pnl null and pnlStatus UNKNOWN instead of a guessed dollar figure.
 */
export function paperCloseOutcome(trade: Pick<Trade, "direction" | "entryPrice">, snap: TradeManagementSnapshot): PaperCloseOutcome {
  if (snap.currentPrice == null) {
    return { ok: false, reason: snap.priceUnavailableReason ?? "No current quote — the trade cannot be closed at a known price." };
  }
  const exitPrice = snap.currentPrice;
  const move = (trade.direction === "BUY" ? 1 : -1) * (exitPrice - trade.entryPrice);
  const status: "CLOSED_WIN" | "CLOSED_LOSS" = move >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
  if (snap.floatingPnl == null) {
    return {
      ok: true, status, exitPrice, pnl: null, pnlStatus: "UNKNOWN",
      dataQualityFlag: snap.pnlDataQualityFlag ?? PNL_DATA_QUALITY_MISSING_CONTRACT_SIZE,
      resultText: `— ${snap.pnlUnavailableReason ?? "P&L unavailable."}`,
    };
  }
  const pnl = Number(snap.floatingPnl.toFixed(2));
  return {
    ok: true, status, exitPrice, pnl, pnlStatus: null, dataQualityFlag: null,
    resultText: `for ${pnl < 0 ? "-" : ""}$${Math.abs(pnl).toFixed(2)}`,
  };
}
