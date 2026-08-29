// Strict ISO-4217 forex-pair classification — VIEW over the Instrument
// Passport (D3b).
//
// The single definition of FIAT_CODES / splitForexPair / the FX standard lot
// now lives in `@workspace/domain/market` (instrumentPassport.ts), the
// canonical instrument registry, so the FX conventions and the passport's
// declared unit facts cannot drift: this file re-exports them VERBATIM.
// contractSize.ts in turn re-exports from here, so every historical importer
// keeps its API and there is still exactly one definition.
//
// WHY THE STRICT CLASSIFIER (unchanged)
//
// A loose `/^[A-Z]{6}$/` test calls XAUUSD, XAGUSD and BTCUSD "forex" and
// applies FX conventions to them — mis-sizing gold by 1,000× and silver by
// 20×. BOTH halves of the symbol must be real ISO-4217 fiat codes before any
// FX convention may be assumed.

export {
  FIAT_CODES,
  FX_STANDARD_LOT_UNITS,
  splitForexPair,
  isForexPair,
} from "@workspace/domain/market";
