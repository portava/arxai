// Macro Engine — honest not-connected state.
//
// FABRICATION REMOVAL (R7 step 1d). This module previously fabricated
// fundamentals from static tables baked into source:
//
//   - `CURRENCY_MACRO` hardcoded per-currency strength/rate-bias/inflation/
//     jobs/GDP opinions (USD 72/Hawkish, EUR 38/Dovish/Contracting, ...) and
//     published them as live macro readings;
//   - `SECTOR_MACRO` + `STOCK_SECTOR` did the same for equity sectors;
//   - `getGlobalMacro()` invented a 10Y yield (4.45), a VIX estimate (15.2),
//     a Fed bias and a dollar-strength label.
//
// Those stale opinions fed `macroBias` into the market brain's direction
// logic and `macroScore` into its confluence confidence. No macro/fundamental
// data provider is wired in this repo (the economic-calendar seam serves
// EVENTS, not fundamentals — it is consumed by the news engine, not here).
// Until a real fundamentals provider exists, this engine follows the restored
// forexIntelligence pattern exactly: `providerConnected: false`, empty data,
// a safetyNote, and a NEUTRAL bias that cannot push direction.
//
// The synthetic-category read is retained: "synthetic indices are not
// news-driven" is a fact about the instrument class, not a market reading.

export type SyntheticMacroAnalysis = {
  type: "synthetic";
  macroBias: "Not news-driven";
  /** Fixed neutral placeholder (confluence formula requires a number; 50 is
   *  the documented neutral center, not a market reading). */
  macroScore: number;
  notes: string[];
};

export type UnavailableMacroAnalysis = {
  type: "unavailable";
  /** False until a real macro/fundamentals provider is configured. Never true today. */
  providerConnected: false;
  /** User-safe explanation of why macro data is withheld. */
  safetyNote: string;
  /** NEUTRAL by construction — an unavailable macro read must never push direction. */
  macroBias: "Neutral";
  /** Fixed neutral placeholder (confluence formula requires a number; 50 is
   *  the documented neutral center, not a market reading). */
  macroScore: number;
  notes: string[];
};

export type MacroAnalysis = SyntheticMacroAnalysis | UnavailableMacroAnalysis;

export const MACRO_PROVIDER_NOT_CONNECTED_NOTE =
  "No live macro/fundamentals provider is connected. ARX does not display fabricated " +
  "market data, so currency strength, rate bias, sector bias and macro confidence are " +
  "withheld rather than estimated. Macro bias is fixed to Neutral and contributes only " +
  "the neutral center to confluence scoring.";

/** The neutral center of the 0–100 macro scale. NOT a reading — the value an
 *  unavailable macro input contributes so it can neither raise nor lower the
 *  confluence score relative to "no macro opinion". */
export const NEUTRAL_MACRO_SCORE = 50;

export function analyzeMacro(
  symbol: string,
  category: "forex" | "indices" | "stocks" | "synthetic",
): MacroAnalysis {
  if (category === "synthetic") {
    return {
      type: "synthetic",
      macroBias: "Not news-driven",
      macroScore: NEUTRAL_MACRO_SCORE,
      notes: [
        "Synthetic volatility indices are not affected by economic news or macro events.",
        "No macro filter applied — rely entirely on technical engine output.",
      ],
    };
  }

  return {
    type: "unavailable",
    providerConnected: false,
    safetyNote: MACRO_PROVIDER_NOT_CONNECTED_NOTE,
    macroBias: "Neutral",
    macroScore: NEUTRAL_MACRO_SCORE,
    notes: [
      `Macro fundamentals for ${symbol} are withheld — no provider is connected.`,
      MACRO_PROVIDER_NOT_CONNECTED_NOTE,
    ],
  };
}
