// Unified symbol resolver for the user-facing symbol pickers.
//
// PROBLEM this solves: the symbol picker used to read ONLY the EA-enumerated
// directory (arx_symbol_specs via listSymbolsForUser). When enumeration has not
// run yet that list is empty, so the picker showed "No enumerated symbols yet"
// even when the user has live candles for an approved market (e.g. EURUSD).
//
// FIX: merge multiple symbol sources behind ONE resolver. The approved trading
// universe is the ARX Focus market registry (the locked 36/43-market truth) —
// so approved markets (EURUSD, V75, …) are ALWAYS visible for viewing/scanning,
// enriched with the broker's enumerated metadata when it exists.
//
// SAFETY — this is DISPLAY/SCANNER only and changes NO execution behaviour:
//   - It never invents an instrument: every row comes from ARX_FOCUS_MARKETS
//     (the approved universe) and the broker's own enumerated directory. A
//     broker symbol that is NOT in the approved universe stays invisible (the
//     36-market lock is preserved).
//   - It never fakes tradeability: `tradeable` is true ONLY when the broker has
//     enumerated the instrument AND reported it tradable. Everything else is
//     flagged `executionRequiresBrokerConfirmation: true`.
//   - Execution is unaffected: orders still resolve the exact broker symbol via
//     resolveBrokerSymbol and run the full preflight + 18-gate dispatch. A
//     symbol shown here as not-yet-tradable is honestly refused at execution.

import {
  ARX_FOCUS_MARKETS,
  resolveArxMarket,
  type ArxMarketCategory,
} from "@workspace/domain/market";
import {
  listSymbolsForUser,
  resolveEffectiveSymbolOwnerId,
  type SymbolView,
  type SymbolFreshness,
} from "./symbolDirectory.js";

export type ResolvedSymbolSource = "shared_bridge" | "enumerated" | "default";

export interface ResolvedSymbol {
  /** Canonical ARX routing key (e.g. "EURUSD", "V75"). */
  symbol: string;
  displayName: string;
  /** Exact broker string when the EA has enumerated it, else null. */
  brokerSymbol: string | null;
  /** Coarse asset class: forex / synthetic / metal / index / crypto. */
  market: string;
  /** Display group heading for the picker. */
  category: string;
  source: ResolvedSymbolSource;
  tradeable: boolean;
  scannerEnabled: boolean;
  candlesEnabled: boolean;
  executionRequiresBrokerConfirmation: boolean;
  /** Freshness of the enumerated overlay (MISSING when not enumerated). */
  freshness: SymbolFreshness;
}

export interface ResolveSymbolsResult {
  ok: true;
  symbols: ResolvedSymbol[];
  sourceSummary: {
    sharedBridge: number;
    enumerated: number;
    defaults: number;
  };
  warnings: string[];
  enumerationStatus: {
    available: boolean;
    count: number;
    lastEnumeratedAt: string | null;
  };
}


/** Coarse asset class for the spec's `market` field. */
function coarseMarket(category: ArxMarketCategory): string {
  switch (category) {
    case "forex_major":
    case "forex_minor":
      return "forex";
    case "metal":
      return "metal";
    case "index":
      return "index";
    case "crypto":
      return "crypto";
    case "synthetic":
    default:
      return "synthetic";
  }
}

/** User-facing display group heading (matches deriveSymbolCategory groups). */
function displayCategory(category: ArxMarketCategory): string {
  switch (category) {
    case "forex_major":
      return "Forex Majors";
    case "forex_minor":
      return "Forex Minors";
    case "metal":
      return "Metals";
    case "index":
      return "Indices";
    case "crypto":
      return "Crypto";
    case "synthetic":
    default:
      return "Synthetics";
  }
}

/**
 * Resolve the full approved symbol universe for a user, merged with whatever the
 * broker has enumerated. Always returns the approved markets (never an empty
 * list) so the picker cannot go dark just because enumeration has not run.
 */
export async function resolveSymbolsForUser(
  userId: number,
): Promise<ResolveSymbolsResult> {
  // 1. Resolve the effective enumerated directory (own EA, or the shared master
  //    directory for an APPROVED shared-bridge user). Read-only, fail-soft.
  let viaSharedMaster = false;
  let enumerated: SymbolView[] = [];
  try {
    const owner = await resolveEffectiveSymbolOwnerId(userId);
    viaSharedMaster = owner.viaSharedMaster;
    enumerated = await listSymbolsForUser(owner.ownerId, { includeStale: true });
  } catch {
    enumerated = [];
  }

  // 2. Index enumerated rows by their approved canonical symbol. Non-approved
  //    broker rows are dropped here (the 36-market lock keeps them invisible).
  const enumByCanonical = new Map<string, SymbolView>();
  let lastEnumeratedAt: string | null = null;
  for (const v of enumerated) {
    if (v.lastSeenAt && (!lastEnumeratedAt || v.lastSeenAt > lastEnumeratedAt)) {
      lastEnumeratedAt = v.lastSeenAt;
    }
    const market =
      resolveArxMarket(v.brokerSymbol ?? v.symbol) ??
      (v.displaySymbol ? resolveArxMarket(v.displaySymbol) : null);
    if (!market) continue;
    const key = market.canonicalSymbol;
    const prev = enumByCanonical.get(key);
    // Prefer a tradable + fresher row when the same market enumerates twice.
    if (
      !prev ||
      (v.tradable === true && prev.tradable !== true) ||
      (v.freshness === "FRESH" && prev.freshness !== "FRESH")
    ) {
      enumByCanonical.set(key, v);
    }
  }

  const summary = {
    sharedBridge: 0,
    enumerated: 0,
    defaults: 0,
  };

  // 3. Build the merged list from the approved universe, overlaying enumerated
  //    metadata. Approved order (tier/category) is preserved from the registry.
  const symbols: ResolvedSymbol[] = ARX_FOCUS_MARKETS.map((mk) => {
    const en = enumByCanonical.get(mk.canonicalSymbol) ?? null;
    const tradeable = !!(en && en.tradable === true && en.brokerSymbol);

    // Source is reported honestly from the broker's enumerated directory only —
    // an approved market with no enumerated row is "default" (broker confirmation
    // still pending). We never infer a richer source from chart selection alone.
    let source: ResolvedSymbolSource;
    if (en) {
      source = viaSharedMaster ? "shared_bridge" : "enumerated";
    } else {
      source = "default";
    }

    switch (source) {
      case "enumerated":
        summary.enumerated += 1;
        break;
      case "shared_bridge":
        summary.sharedBridge += 1;
        break;
      default:
        summary.defaults += 1;
        break;
    }

    return {
      symbol: mk.canonicalSymbol,
      displayName: mk.displayName,
      brokerSymbol: en?.brokerSymbol ?? null,
      market: coarseMarket(mk.category),
      category: displayCategory(mk.category),
      source,
      tradeable,
      scannerEnabled: mk.enabledForScanner,
      candlesEnabled: mk.enabledForChart,
      executionRequiresBrokerConfirmation: !tradeable,
      freshness: en?.freshness ?? "MISSING",
    };
  });

  const warnings: string[] = [];
  if (enumByCanonical.size === 0) warnings.push("BROKER_ENUMERATION_PENDING");

  return {
    ok: true,
    symbols,
    sourceSummary: summary,
    warnings,
    enumerationStatus: {
      available: enumByCanonical.size > 0,
      count: enumByCanonical.size,
      lastEnumeratedAt,
    },
  };
}
