// Task #412 — Ruby typed-symbol resolution gated to the approved Top 250.
//
// Ruby may resolve real names, nicknames, abbreviations, and broker aliases —
// but ONLY into an approved Top 250 market. This wraps the pure
// @workspace/markets resolver and adds the user-safe copy + a downstream
// (backend-resolvable) symbol form for the existing read-only data machinery.
//
// SAFETY: This is a READ-ONLY resolution/visibility layer. It never touches
// live execution routing, the trade-command parser, or any safety gate. When a
// named market is outside the universe, or approved but has no data, Ruby says
// so honestly — it never guesses and never fabricates a market.

import {
  resolveUserMarketInput,
  ARX_MARKET_COPY,
  type ArxMarket,
  type MarketResolveStatus,
} from "@workspace/markets";
import { resolveArxMarket, ARX_FOCUS_RUBY_LOCKED_REPLY } from "@workspace/domain/market";

export interface AssistantMarketCandidate {
  standardSymbol: string;
  displayName: string;
}

export interface AssistantMarketResolution {
  status: MarketResolveStatus | "empty";
  /** The approved market when uniquely resolved. */
  market: ArxMarket | null;
  /** Backend-resolvable symbol form for read-only data fetch (chart/candles).
   *  Synthetics use their short provider code (e.g. V75) which the existing
   *  Deriv / broker resolver understands; everything else uses the standard
   *  symbol. Null unless uniquely resolved. */
  downstreamSymbol: string | null;
  /** Top-250-scoped clarifying options when the input is ambiguous. */
  candidates: AssistantMarketCandidate[];
  /** Plain-English, user-safe message Ruby can speak. Null when resolved. */
  userMessage: string | null;
}

/** Pick a backend-resolvable symbol for an approved market. */
function downstreamSymbolFor(m: ArxMarket): string {
  if (m.assetClass === "synthetic") {
    const short = m.providerSymbols.find((p) =>
      /^(V\d|BOOM|CRASH|STEP|JUMP|R_|1HZ|JD)/i.test(p),
    );
    if (short) return short;
  }
  return m.standardSymbol;
}

/**
 * Resolve a user-typed / spoken market name into the approved Top 250.
 *
 * - resolved → market + downstreamSymbol, no message.
 * - ambiguous → Top-250-scoped candidates + a short clarifying question.
 * - not_in_universe → "That market is not available in ARX right now."
 * - empty → null (caller falls back to its existing default symbol context).
 */
export function resolveAssistantMarket(input: string): AssistantMarketResolution {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { status: "empty", market: null, downstreamSymbol: null, candidates: [], userMessage: null };
  }

  // Task #558 — the ARX Focus registry is the SOLE authority for what Ruby may
  // resolve, analyze, or mention. Wired at the resolver boundary so the lock
  // holds for EVERY phrasing (not prompt text). Anything that does not resolve
  // to an approved Focus market gets the EXACT locked reply and no market data —
  // no candidates, no "I can also check X". This is a read-only visibility layer
  // and touches no execution path or safety gate.
  if (!resolveArxMarket(raw)) {
    return {
      status: "not_in_universe",
      market: null,
      downstreamSymbol: null,
      candidates: [],
      userMessage: ARX_FOCUS_RUBY_LOCKED_REPLY,
    };
  }

  const r = resolveUserMarketInput(raw);

  if (r.status === "resolved" && r.market) {
    return {
      status: "resolved",
      market: r.market,
      downstreamSymbol: downstreamSymbolFor(r.market),
      candidates: [],
      userMessage: null,
    };
  }

  if (r.status === "ambiguous") {
    // The registry already resolved `raw` to a single approved market, but keep
    // any ambiguity scoped to APPROVED markets only (never surface an unapproved
    // candidate). If every candidate is filtered out, fall through to the
    // registry-canonical resolution below.
    const candidates = r.candidates
      .filter((c) => resolveArxMarket(c.standardSymbol) != null)
      .map((c) => ({ standardSymbol: c.standardSymbol, displayName: c.displayName }));
    if (candidates.length > 1) {
      const names = candidates.map((c) => c.displayName).join(" or ");
      return {
        status: "ambiguous",
        market: null,
        downstreamSymbol: null,
        candidates,
        userMessage: `Did you mean ${names}?`,
      };
    }
  }

  // Approved by the registry but @workspace/markets did not uniquely resolve it.
  // Trust the registry (the source of truth): resolve to its canonical symbol so
  // the read-only data machinery can fetch it.
  const focus = resolveArxMarket(raw)!;
  return {
    status: "resolved",
    market: null,
    downstreamSymbol: focus.canonicalSymbol,
    candidates: [],
    userMessage: null,
  };
}

/** Convenience: the honest "approved but no data yet" line for a resolved
 *  market whose data the caller found unavailable. */
export function approvedNoDataMessage(): string {
  return ARX_MARKET_COPY.approvedNoData;
}
