// Phase TT — pure per-order-type validation for the trade ticket.
//
// SAFETY:
//   * This is a pure function. It DOES NOT touch the DB, the bridge, or any
//     user state. It returns a structured result; callers (frontend live
//     preview, /me/pending-order-draft, /me/trades/open) all run it.
//   * It NEVER fabricates a current price. If `currentPrice` is missing,
//     entry/trigger checks are SKIPPED with `dataUnavailable: true` rather
//     than passed silently. The caller decides whether to block or preview.
//   * SL/TP rules follow the user spec exactly. Canonical MT5 stop-limit
//     relationship is enforced per direction (Buy: stopLimitPrice < trigger;
//     Sell: stopLimitPrice > trigger). See MetaTrader 5 docs:
//     ORDER_TYPE_BUY_STOP_LIMIT places a Buy Limit at stopLimit AFTER price
//     breaks ABOVE the trigger — so the limit naturally sits below the
//     trigger (waiting for the pullback fill). Mirror for sell.

import {
  type OrderType,
  isMarketOrder,
  isStopLimit,
  directionOf,
} from "./orderTypes.js";

export interface OrderTicketInput {
  orderType: OrderType;
  lotSize: number;
  currentPrice: number | null;        // bid/ask midpoint or last known price; null = no live data
  entryPrice: number | null;          // pending limit/stop entry (null for market)
  stopTriggerPrice: number | null;    // only for *_STOP_LIMIT
  stopLimitPrice: number | null;      // only for *_STOP_LIMIT
  stopLoss: number | null;
  takeProfit: number | null;
  symbolDigits?: number | null;       // for precision validation
  minStopDistance?: number | null;    // price-units distance (e.g. 0.0005 on EURUSD)
  minPendingDistance?: number | null;
  minLotSize?: number | null;
  maxLotSize?: number | null;
  requireStopLoss?: boolean;          // user/admin risk rule
  symbolPipSize?: number | null;      // for converting price-distance → pips (e.g. 0.0001)
}

export interface OrderTicketValidation {
  ok: boolean;
  errors: string[];                   // human-readable; first one is the primary block reason
  warnings: string[];                 // non-blocking advisories
  dataUnavailable: boolean;           // true if we skipped market-relative checks
  effectiveEntryPrice: number | null; // price used for risk math (limit/stop/limit price for stop-limit/current for market)
  riskReward: number | null;          // |TP-entry| / |SL-entry|; null when SL or TP missing
  slDistancePips: number | null;
  tpDistancePips: number | null;
  riskPriceUnits: number | null;      // |entry - SL| in price units
  rewardPriceUnits: number | null;    // |TP - entry| in price units
}

const fail = (acc: string[], msg: string) => { acc.push(msg); };

export function validateOrderTicket(input: OrderTicketInput): OrderTicketValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const {
    orderType, lotSize, currentPrice, entryPrice,
    stopTriggerPrice, stopLimitPrice, stopLoss, takeProfit,
    minStopDistance, minPendingDistance, minLotSize, maxLotSize,
    requireStopLoss, symbolPipSize,
  } = input;

  // ── 1. Lot size sanity ───────────────────────────────────────────────────
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    fail(errors, "Lot size must be a positive number.");
  } else {
    if (minLotSize != null && lotSize < minLotSize) {
      fail(errors, `Lot size below symbol minimum (${minLotSize}).`);
    }
    if (maxLotSize != null && lotSize > maxLotSize) {
      fail(errors, `Lot size above your account maximum (${maxLotSize}).`);
    }
  }

  // ── 2. Required SL gate (risk policy) ────────────────────────────────────
  if (requireStopLoss && (stopLoss == null || !Number.isFinite(stopLoss))) {
    fail(errors, "A Stop Loss is required by your risk settings.");
  }

  // ── 3. Determine the effective entry price for downstream math ──────────
  // For market orders we use currentPrice (if available). For limit/stop we
  // use entryPrice. For stop-limit we use stopLimitPrice (the actual fill
  // price once the trigger is hit).
  const dir = directionOf(orderType);
  const isMarket = isMarketOrder(orderType);
  const isSL = isStopLimit(orderType);

  let effectiveEntry: number | null = null;
  let dataUnavailable = false;

  if (isMarket) {
    if (currentPrice == null || !Number.isFinite(currentPrice)) {
      dataUnavailable = true;
      warnings.push("Live market price unavailable — SL/TP direction checks skipped (will re-validate at execution).");
    } else {
      effectiveEntry = currentPrice;
    }
  } else if (isSL) {
    if (stopTriggerPrice == null || !Number.isFinite(stopTriggerPrice)) {
      fail(errors, "Stop-limit orders require a Stop Trigger Price.");
    }
    if (stopLimitPrice == null || !Number.isFinite(stopLimitPrice)) {
      fail(errors, "Stop-limit orders require a Stop-Limit Price.");
    }
    effectiveEntry = stopLimitPrice ?? null;
  } else {
    // Plain LIMIT or STOP
    if (entryPrice == null || !Number.isFinite(entryPrice)) {
      fail(errors, "Pending orders require an Entry Price.");
    }
    effectiveEntry = entryPrice ?? null;
  }

  // ── 4. Pending order entry vs current market direction rules ────────────
  if (!isMarket && currentPrice != null && Number.isFinite(currentPrice)) {
    switch (orderType) {
      case "BUY_LIMIT":
        if (entryPrice != null && entryPrice >= currentPrice) {
          fail(errors, "Buy Limit entry must be BELOW the current market price.");
        }
        break;
      case "SELL_LIMIT":
        if (entryPrice != null && entryPrice <= currentPrice) {
          fail(errors, "Sell Limit entry must be ABOVE the current market price.");
        }
        break;
      case "BUY_STOP":
        if (entryPrice != null && entryPrice <= currentPrice) {
          fail(errors, "Buy Stop entry must be ABOVE the current market price.");
        }
        break;
      case "SELL_STOP":
        if (entryPrice != null && entryPrice >= currentPrice) {
          fail(errors, "Sell Stop entry must be BELOW the current market price.");
        }
        break;
      case "BUY_STOP_LIMIT":
        if (stopTriggerPrice != null && stopTriggerPrice <= currentPrice) {
          fail(errors, "Buy Stop-Limit trigger must be ABOVE the current ask.");
        }
        // Canonical MT5 rule (ORDER_TYPE_BUY_STOP_LIMIT): once price breaks
        // ABOVE the trigger, a Buy Limit is placed at stopLimitPrice. The
        // limit must therefore sit STRICTLY BELOW the trigger so the
        // resulting Buy Limit waits for a pullback. Equality is rejected —
        // MT5 brokers typically refuse stopLimit==trigger as an Invalid Stops
        // error. Hard error, never a warning.
        if (stopTriggerPrice != null && stopLimitPrice != null && stopLimitPrice >= stopTriggerPrice) {
          fail(errors, "Buy Stop-Limit limit price must be STRICTLY BELOW the trigger price (per MT5 ORDER_TYPE_BUY_STOP_LIMIT).");
        }
        break;
      case "SELL_STOP_LIMIT":
        if (stopTriggerPrice != null && stopTriggerPrice >= currentPrice) {
          fail(errors, "Sell Stop-Limit trigger must be BELOW the current bid.");
        }
        // Canonical MT5 rule (ORDER_TYPE_SELL_STOP_LIMIT): once price breaks
        // BELOW the trigger, a Sell Limit is placed at stopLimitPrice. The
        // limit must therefore sit STRICTLY ABOVE the trigger so the
        // resulting Sell Limit waits for a pullback. Equality is rejected.
        if (stopTriggerPrice != null && stopLimitPrice != null && stopLimitPrice <= stopTriggerPrice) {
          fail(errors, "Sell Stop-Limit limit price must be STRICTLY ABOVE the trigger price (per MT5 ORDER_TYPE_SELL_STOP_LIMIT).");
        }
        break;
    }
  } else if (!isMarket && currentPrice == null) {
    dataUnavailable = true;
    warnings.push("Live market price unavailable — pending-order placement checks skipped (will re-validate at execution).");
  }

  // ── 5. Minimum pending-order distance ───────────────────────────────────
  if (!isMarket && currentPrice != null && minPendingDistance != null) {
    const refPrice = isSL ? stopTriggerPrice : entryPrice;
    if (refPrice != null) {
      const dist = Math.abs(refPrice - currentPrice);
      if (dist < minPendingDistance) {
        fail(errors,
          `Pending order is too close to market (${dist.toFixed(5)} < min ${minPendingDistance.toFixed(5)}).`);
      }
    }
  }

  // ── 6. SL / TP direction relative to effective entry ────────────────────
  if (effectiveEntry != null) {
    if (stopLoss != null && Number.isFinite(stopLoss)) {
      if (dir === "BUY" && stopLoss >= effectiveEntry) {
        fail(errors, "Stop Loss must be BELOW the entry price for a BUY order.");
      }
      if (dir === "SELL" && stopLoss <= effectiveEntry) {
        fail(errors, "Stop Loss must be ABOVE the entry price for a SELL order.");
      }
    }
    if (takeProfit != null && Number.isFinite(takeProfit)) {
      if (dir === "BUY" && takeProfit <= effectiveEntry) {
        fail(errors, "Take Profit must be ABOVE the entry price for a BUY order.");
      }
      if (dir === "SELL" && takeProfit >= effectiveEntry) {
        fail(errors, "Take Profit must be BELOW the entry price for a SELL order.");
      }
    }
  }

  // ── 7. Minimum SL distance ───────────────────────────────────────────────
  let riskPriceUnits: number | null = null;
  let rewardPriceUnits: number | null = null;
  if (effectiveEntry != null && stopLoss != null && Number.isFinite(stopLoss)) {
    riskPriceUnits = Math.abs(effectiveEntry - stopLoss);
    if (minStopDistance != null && riskPriceUnits < minStopDistance) {
      fail(errors,
        `Stop Loss is too close to entry (${riskPriceUnits.toFixed(5)} < min ${minStopDistance.toFixed(5)}).`);
    }
  }
  if (effectiveEntry != null && takeProfit != null && Number.isFinite(takeProfit)) {
    rewardPriceUnits = Math.abs(takeProfit - effectiveEntry);
  }

  // ── 8. RR + pip distances (advisory; never blocks here) ─────────────────
  const riskReward = (riskPriceUnits != null && riskPriceUnits > 0 && rewardPriceUnits != null)
    ? Number((rewardPriceUnits / riskPriceUnits).toFixed(2))
    : null;
  const pip = symbolPipSize && symbolPipSize > 0 ? symbolPipSize : null;
  const slDistancePips = pip && riskPriceUnits != null ? Number((riskPriceUnits / pip).toFixed(1)) : null;
  const tpDistancePips = pip && rewardPriceUnits != null ? Number((rewardPriceUnits / pip).toFixed(1)) : null;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    dataUnavailable,
    effectiveEntryPrice: effectiveEntry,
    riskReward,
    slDistancePips,
    tpDistancePips,
    riskPriceUnits,
    rewardPriceUnits,
  };
}
