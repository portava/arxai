// Single source of truth for "where does this symbol's data come from"
// and "can the user actually place a live trade on it via MT5?".
//
// Resolution rules (intentionally conservative — over-blocking is safe):
//   - dataProvider is a route label derived from the ASSET CLASS only
//     (synthetic → deriv; forex/metals/indices/crypto/stocks → external),
//     not the provider that actually served the data — the router tries the
//     MT5 broker first for every class. The live pipeline's synthetic floor
//     reads it as a classification, so it stays; user-facing copy must not
//     name a data source from it.
//   - mt5Tradable is resolved against the same allowedSymbols list the
//     16-gate Phase B evaluator uses (gate 13: SYMBOL_NOT_ALLOWED). If a
//     userId is provided we read that user's settings; otherwise we fall
//     back to ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS. Synthetic symbols are
//     never marked tradable here because the connected MT5 bridge does
//     not route Deriv synthetics through standard brokers.
//   - A symbol on the list but outside the ARX Focus registry is "no":
//     the live pipeline refuses every new entry on it
//     (SYMBOL_NOT_IN_ARX_FOCUS, same isApprovedArxMarket helper).
//   - If the user's list cannot be read the verdict is "unknown" — the
//     default list is never silently presented as theirs.
//   - liveExecutionAllowed is a strict floor only: mt5Tradable === "yes".
//     The actual 16-gate evaluation still runs at dispatch time; this
//     flag only governs whether the UI offers the live-submit affordance.
//   - Nothing here checks the MT5 bridge connection, the broker's symbol
//     list or governance rules; the copy says so instead of implying it.
//
// This module never throws. All callers can rely on a populated result.
import { classifySymbol, type AssetClass } from "./marketDataRouter.js";
import { ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS } from "../live/liveArming.js";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { getOrCreateUserSettings } from "../live/liveCommandPipeline.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type TradabilityState = "yes" | "no" | "unknown";
export type DataProviderLabel = "deriv" | "external" | "unknown";
export type ExecutionProvider = "mt5" | "none";

export type BadgeLabel =
  // On the live market list and an ARX Focus market — nothing more is checked.
  | "Allowed for MT5 live"
  // No longer produced; kept so older clients still parse.
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

  // Resolve the user's allowedSymbols. An empty/absent list means the
  // default list (the live pipeline does the same); a list that could not
  // be read is "unreadable" — never silently replaced by the default.
  let allowed: string[] = [...ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS];
  let listSource: "user" | "default" | "unreadable" = "default";
  if (userId != null) {
    try {
      const s = await getOrCreateUserSettings(userId);
      const fromSettings = (s.allowedSymbols as string[] | null) ?? null;
      if (Array.isArray(fromSettings) && fromSettings.length > 0) {
        allowed = fromSettings;
        listSource = "user";
      }
    } catch {
      listSource = "unreadable";
    }
  }
  const listName = listSource === "user"
    ? "your live market list"
    : userId != null
      ? "the default live market list (you have not set your own)"
      : "the default live market list";
  const onList = allowed.includes(symbol);
  const arxFocus = isApprovedArxMarket(symbol);

  // Synthetic asset class is never marked MT5-tradable in the default
  // path because the v1.27 EA + standard MT5 brokers do not route Deriv
  // volatility indices. If an operator explicitly adds a synthetic to
  // a user's allowedSymbols we honour that (Deriv MT5 setups exist).
  let mt5Tradable: TradabilityState;
  if (assetClass === "unknown" || listSource === "unreadable") {
    mt5Tradable = "unknown";
  } else if (onList && arxFocus) {
    mt5Tradable = "yes";
  } else {
    mt5Tradable = "no";
  }

  const executionProvider: ExecutionProvider = mt5Tradable === "yes" ? "mt5" : "none";
  const liveExecutionAllowed = mt5Tradable === "yes";

  // Badge truthfully reflects WHY a market is analysis-only (not on the
  // list, or outside ARX Focus) and stays provider-neutral: nothing here
  // observes which feed served the data.
  let badgeLabel: BadgeLabel;
  let userMessage: string;
  if (mt5Tradable === "yes") {
    badgeLabel = "Allowed for MT5 live";
    userMessage = `${symbol} is on ${listName} and is an ARX Focus market — that is all this label checks. The MT5 bridge connection, the broker's symbol list, governance rules and every live safety gate are checked only when an order is submitted.`;
  } else if (mt5Tradable === "no") {
    if (onList && !arxFocus) {
      badgeLabel = "Analysis only";
      userMessage = `${symbol} is on ${listName} but is not one of the ARX Focus markets, so new live orders for it are refused.`;
    } else if (assetClass === "synthetic") {
      // Never name the data source here: `dataProvider` is a route label
      // derived from the asset class, and the router may serve synthetics
      // from the MT5 broker before Deriv.
      badgeLabel = "Analysis only";
      userMessage = `${symbol} is a synthetic index that is not on ${listName}, so live orders for it are refused. ${DEFAULT_ASSISTANT_NAME} can still analyze it.`;
    } else {
      badgeLabel = "Analysis only";
      userMessage = `${symbol} is not on ${listName}, so live orders for it are refused. You can still analyze it.`;
    }
  } else if (listSource === "unreadable" && assetClass !== "unknown") {
    badgeLabel = "Tradability not verified";
    userMessage = `Your live market list could not be loaded, so whether ${symbol} can be traded live was not checked. Live order submit is disabled until it is.`;
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
