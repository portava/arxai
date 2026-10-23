// Single source of truth for "where does this symbol's data come from"
// and "can the user actually place a live trade on it via MT5?".
//
// Resolution rules (intentionally conservative — over-blocking is safe):
//   - dataProvider is derived from the unified market data router's chain.
//     Synthetic → deriv. Forex/metals/indices/crypto/stocks → external
//     (TwelveData / yahoo / assistant provider — anonymized as "external").
//   - mt5Tradable is resolved against the same allowedSymbols list the
//     16-gate Phase B evaluator uses (gate 13: SYMBOL_NOT_ALLOWED). If a
//     userId is provided we read that user's settings; otherwise we fall
//     back to ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS. Synthetic symbols are
//     never marked tradable here because the connected MT5 bridge does
//     not route Deriv synthetics through standard brokers.
//   - liveExecutionAllowed is a strict floor only: mt5Tradable === "yes".
//     The actual 16-gate evaluation still runs at dispatch time; this
//     flag only governs whether the UI offers the live-submit affordance.
//
// This module never throws. All callers can rely on a populated result.
import { classifySymbol, type AssetClass } from "./marketDataRouter.js";
import { ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS } from "../live/liveArming.js";
import { getOrCreateUserSettings } from "../live/liveCommandPipeline.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type TradabilityState = "yes" | "no" | "unknown";
export type DataProviderLabel = "deriv" | "external" | "unknown";
export type ExecutionProvider = "mt5" | "none";

export type BadgeLabel =
  | "Tradable via MT5"
  | "Data-only via Deriv"
  | "Analysis only"
  | "Tradability not verified";

export interface SymbolTradability {
  symbol: string;
  assetClass: AssetClass;
  dataProvider: DataProviderLabel;
  dataAvailable: boolean;
  mt5Tradable: TradabilityState;
  executionProvider: ExecutionProvider;
  liveExecutionAllowed: boolean;
  badgeLabel: BadgeLabel;
  userMessage: string;
}

function dataProviderForClass(cls: AssetClass): DataProviderLabel {
  if (cls === "synthetic") return "deriv";
  if (cls === "unknown") return "unknown";
  return "external";
}

function dataAvailableForClass(cls: AssetClass): boolean {
  return cls !== "unknown";
}

export async function getSymbolTradability(
  rawSymbol: string,
  userId?: number,
): Promise<SymbolTradability> {
  const symbol = (rawSymbol ?? "").trim().toUpperCase();
  const assetClass = classifySymbol(symbol);
  const dataProvider = dataProviderForClass(assetClass);
  const dataAvailable = dataAvailableForClass(assetClass);

  // Resolve the user's allowedSymbols (or fall back to default).
  let allowed: string[] = [...ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS];
  if (userId != null) {
    try {
      const s = await getOrCreateUserSettings(userId);
      const fromSettings = (s.allowedSymbols as string[] | null) ?? null;
      if (Array.isArray(fromSettings) && fromSettings.length > 0) {
        allowed = fromSettings;
      }
    } catch {
      // honest fall-through: keep default list
    }
  }

  // Synthetic asset class is never marked MT5-tradable in the default
  // path because the v1.27 EA + standard MT5 brokers do not route Deriv
  // volatility indices. If an operator explicitly adds a synthetic to
  // a user's allowedSymbols we honour that (Deriv MT5 setups exist).
  let mt5Tradable: TradabilityState;
  if (assetClass === "unknown") {
    mt5Tradable = "unknown";
  } else if (allowed.includes(symbol)) {
    mt5Tradable = "yes";
  } else {
    mt5Tradable = "no";
  }

  const executionProvider: ExecutionProvider = mt5Tradable === "yes" ? "mt5" : "none";
  const liveExecutionAllowed = mt5Tradable === "yes";

  // Badge truthfully reflects WHY a market is data-only: Deriv-specific
  // copy only when the data actually comes from Deriv (synthetics);
  // for non-synthetic data-only markets (e.g. user hasn't added a forex
  // pair to allowedSymbols) we use a provider-neutral "Analysis only"
  // label so we never imply the data path that isn't real.
  let badgeLabel: BadgeLabel;
  let userMessage: string;
  if (mt5Tradable === "yes") {
    badgeLabel = "Tradable via MT5";
    userMessage = "This market can be traded through the connected MT5 bridge if all live safety gates pass.";
  } else if (mt5Tradable === "no") {
    if (dataProvider === "deriv") {
      badgeLabel = "Data-only via Deriv";
      userMessage = `${DEFAULT_ASSISTANT_NAME} can analyze this market, but live execution is not available through the current MT5 bridge.`;
    } else {
      badgeLabel = "Analysis only";
      userMessage = "This market is available for analysis only. It is not in your live-tradable list, so live execution is disabled.";
    }
  } else {
    badgeLabel = "Tradability not verified";
    userMessage = "Tradability for this market has not been confirmed. Live order submit is disabled until it is.";
  }

  return {
    symbol,
    assetClass,
    dataProvider,
    dataAvailable,
    mt5Tradable,
    executionProvider,
    liveExecutionAllowed,
    badgeLabel,
    userMessage,
  };
}
