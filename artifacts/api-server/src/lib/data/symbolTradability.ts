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
//   - With a userId, the stored refusals the order path applies to every
//     live order on the symbol are read too, and only ever downgrade:
//       · owner/admin governance (getEffectiveTradingGovernance, as the live
//         pipeline reads it): under Owner Live Control Mode the pipeline
//         applies the governance blocklist / allowlist INSTEAD of the live
//         market list, so the list is then not named — except that a
//         synthetic the user has not put on their own list is "unknown":
//         the pipeline's synthetic floor (owner-unrestricted profile, Deriv
//         master broker, live tick) decides it and is not read here;
//       · the Risk Governor's limits in force (loadEffectiveLimits): account
//         limited to demo, symbol off the operator's instruments, symbol
//         switched off in the trader's limits (preTrade max_position_size).
//     Either read failing makes the verdict "unknown", never "yes".
//   - liveExecutionAllowed is a strict floor only: mt5Tradable === "yes".
//     The actual 16-gate evaluation still runs at dispatch time; this
//     flag only governs whether the UI offers the live-submit affordance.
//     The live pipeline reads only assetClass / dataProvider from here.
//   - Nothing here checks the MT5 bridge connection, the broker's symbol
//     list, lot / loss limits or the other live gates; the copy says so
//     instead of implying it.
//
// This module never throws. All callers can rely on a populated result.
import { classifySymbol, type AssetClass } from "./marketDataRouter.js";
import { ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS } from "../live/liveArming.js";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { getOrCreateUserSettings } from "../live/liveCommandPipeline.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import { getEffectiveTradingGovernance, type EffectiveTradingGovernance } from "../governance/effectiveGovernance.js";
import { loadEffectiveLimits } from "../riskGovernor/limitSettings.js";
import type { EffectiveLimits } from "../riskGovernor/preTrade.js";

export type TradabilityState = "yes" | "no" | "unknown";
export type DataProviderLabel = "deriv" | "external" | "unknown";
export type ExecutionProvider = "mt5" | "none";

export type BadgeLabel =
  // On the live market list (or not refused by governance), an ARX Focus
  // market, and not refused by the trader's risk limits — nothing more is checked.
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
  const arxFocus = isApprovedArxMarket(symbol);

  // Governance and the Risk Governor's limits in force, read as the order
  // path reads them (DB only). A failed read is "unreadable", never "allows".
  let gov: EffectiveTradingGovernance | "unreadable" | null = null;
  let limits: EffectiveLimits | "unreadable" | null = null;
  if (userId != null) {
    [gov, limits] = await Promise.all([
      getEffectiveTradingGovernance(userId, "LIVE_SHARED_BRIDGE").catch(() => "unreadable" as const),
      loadEffectiveLimits(userId).catch(() => "unreadable" as const),
    ]);
  }
  // Under Owner Live Control Mode the live pipeline applies the governance
  // symbol lists and does not read the live market list.
  const useGovernance = gov != null && gov !== "unreadable" && gov.isPrivileged && gov.ownerLiveControlMode;
  const govRefusal = !useGovernance || gov == null || gov === "unreadable" ? null
    : gov.blockedSymbols.includes(symbol)
      ? `${symbol} is on your governance blocklist, so live orders for it are refused. You can still analyze it.`
      : gov.enforceSymbolAllowlist && gov.allowedSymbols != null && !gov.allowedSymbols.includes(symbol)
        ? `${symbol} is not on your governance symbol allowlist, so live orders for it are refused. You can still analyze it.`
        : null;
  const onList = useGovernance ? govRefusal == null : allowed.includes(symbol);
  // The live pipeline's synthetic floor (evaluateSyntheticLiveFloor) refuses
  // every synthetic order unless the account has the owner-unrestricted risk
  // profile, the master broker is Deriv and the symbol has a live tick; none
  // of that is read here. Under governance the live market list is not read
  // by the pipeline either, so a synthetic the user has not put on their own
  // list is not offered as live-allowed: whether it can go live is decided
  // only by the floor at submit time. (Display only: the pipeline reads just
  // assetClass / dataProvider from this module.)
  const syntheticFloor = assetClass === "synthetic" || dataProvider === "deriv";
  const govSyntheticUnchecked = useGovernance && syntheticFloor
    && (listSource === "unreadable" || !allowed.includes(symbol));
  // The governor's symbol-level refusals (preTrade max_position_size), in its order.
  const limitsRefusal = limits == null || limits === "unreadable" ? null
    : limits.liveAllowed === false
      ? `Your operator limited your account to demo trading, so the Risk Governor refuses every live order, ${symbol} included. You can still analyze it.`
      : limits.allowedSymbols && !limits.allowedSymbols.includes(symbol)
        ? `${symbol} is not on the instruments your operator allowed for your account, so the Risk Governor refuses live orders for it. You can still analyze it.`
        : limits.symbolLimits?.[symbol]?.blocked
          ? `Trading ${symbol} is switched off in your risk limits, so the Risk Governor refuses live orders for it. You can still analyze it.`
          : null;

  // Synthetic asset class is never marked MT5-tradable in the default
  // path because the v1.27 EA + standard MT5 brokers do not route Deriv
  // volatility indices. If an operator explicitly adds a synthetic to
  // a user's allowedSymbols we honour that (Deriv MT5 setups exist).
  // A known refusal wins over a read that failed; a failed read wins over "yes".
  let mt5Tradable: TradabilityState;
  if (assetClass === "unknown" || gov === "unreadable" || (!useGovernance && listSource === "unreadable")) {
    mt5Tradable = "unknown";
  } else if (!onList || !arxFocus || limitsRefusal != null) {
    mt5Tradable = "no";
  } else if (limits === "unreadable" || govSyntheticUnchecked) {
    mt5Tradable = "unknown";
  } else {
    mt5Tradable = "yes";
  }

  const executionProvider: ExecutionProvider = mt5Tradable === "yes" ? "mt5" : "none";
  const liveExecutionAllowed = mt5Tradable === "yes";

  // Badge truthfully reflects WHY a market is analysis-only (not on the
  // list, outside ARX Focus, or refused by governance / the trader's risk
  // limits) and stays provider-neutral: nothing here observes which feed
  // served the data.
  let badgeLabel: BadgeLabel;
  let userMessage: string;
  if (mt5Tradable === "yes") {
    badgeLabel = "Allowed for MT5 live";
    const checked = [
      useGovernance ? "is not refused by your governance symbol rules" : `is on ${listName}`,
      "is an ARX Focus market",
      ...(limits != null ? ["is not refused by your risk limits"] : []),
    ];
    const unchecked = [
      "The MT5 bridge connection",
      "the broker's symbol list",
      ...(syntheticFloor ? ["the synthetic-index requirements (an owner-unrestricted risk profile, a Deriv master broker and a live tick)"] : []),
      ...(limits == null ? ["your risk limits"] : ["lot and loss limits"]),
      ...(gov == null ? ["governance rules"] : []),
    ];
    userMessage = `${symbol} ${checked.slice(0, -1).join(", ")} and ${checked.at(-1)} — that is all this label checks. `
      + `${unchecked.join(", ")} and every other live safety gate are checked only when an order is submitted.`;
  } else if (mt5Tradable === "no") {
    badgeLabel = "Analysis only";
    if (govRefusal != null) {
      userMessage = govRefusal;
    } else if (!onList && assetClass === "synthetic") {
      // Never name the data source here: `dataProvider` is a route label
      // derived from the asset class, and the router may serve synthetics
      // from the MT5 broker before Deriv.
      userMessage = `${symbol} is a synthetic index that is not on ${listName}, so live orders for it are refused. ${DEFAULT_ASSISTANT_NAME} can still analyze it.`;
    } else if (!onList) {
      userMessage = `${symbol} is not on ${listName}, so live orders for it are refused. You can still analyze it.`;
    } else if (!arxFocus) {
      userMessage = useGovernance
        ? `${symbol} is not one of the ARX Focus markets, so new live orders for it are refused.`
        : `${symbol} is on ${listName} but is not one of the ARX Focus markets, so new live orders for it are refused.`;
    } else {
      userMessage = limitsRefusal ?? `Live orders for ${symbol} are refused. You can still analyze it.`;
    }
  } else if (gov === "unreadable" && assetClass !== "unknown") {
    badgeLabel = "Tradability not verified";
    userMessage = `Your governance settings could not be loaded, so whether ${symbol} can be traded live was not checked. Live order submit is disabled until it is.`;
  } else if (govSyntheticUnchecked && limits !== "unreadable") {
    badgeLabel = "Tradability not verified";
    userMessage = `${symbol} is a synthetic index. Live orders for synthetic indices are refused unless your account has the owner-unrestricted risk profile, the master broker is Deriv and ${symbol} has a live tick right now. This label checks none of those, so it does not offer live order submit for ${symbol}; they are checked only when an order is submitted. You can still analyze it.`;
  } else if (listSource === "unreadable" && assetClass !== "unknown") {
    badgeLabel = "Tradability not verified";
    userMessage = `Your live market list could not be loaded, so whether ${symbol} can be traded live was not checked. Live order submit is disabled until it is.`;
  } else if (limits === "unreadable" && assetClass !== "unknown") {
    badgeLabel = "Tradability not verified";
    userMessage = `Your risk limits could not be loaded, so whether ${symbol} can be traded live was not checked. Live order submit is disabled until it is.`;
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
