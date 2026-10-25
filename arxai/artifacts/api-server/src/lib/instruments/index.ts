// Instruments — the one authority for what an instrument is called.
//
// Every translation between a symbol token and an instrument goes through
// this module (Tier 1 step 9). It used to live in four places:
//   lib/data/symbolResolution.ts      → ./canonicalSymbol.ts   (universe identity + asset class)
//   lib/scannerSelected/symbolNormalize.ts → ./brokerDecoration.ts (broker suffixes, scanner support)
//   lib/mt5/brokerSymbolName.ts       → ./brokerSymbolName.ts  (exact MT5 broker name for dispatch)
//   brain/symbols/symbolRegistry.ts   → ./instrumentProfiles.ts (risk / session profile per instrument)
// Callers import from here only; ci guard instrument-mapping-single-source
// keeps the old paths from coming back and alias tables from growing
// elsewhere.
//
// `resolveInstrument` is the composed lookup: strip broker decoration, resolve
// the universe identity, attach the profile. Unknown stays unknown — nothing
// here guesses an instrument.

import { resolveCanonicalSymbol, type CanonicalSymbolResolution } from "./canonicalSymbol.js";
import { normalizeSymbol } from "./brokerDecoration.js";
import { SYMBOL_REGISTRY, type SymbolInfo } from "./instrumentProfiles.js";

export * from "./canonicalSymbol.js";
export * from "./brokerDecoration.js";
export * from "./brokerSymbolName.js";
export * from "./instrumentProfiles.js";

export interface InstrumentIdentity {
  /** The token as given. */
  input: string;
  /** Broker decoration removed ("EURUSDm" → "EURUSD", "XAUUSD.r" → "XAUUSD"). */
  undecorated: string;
  /** Universe identity and router asset class (unknown stays explicit). */
  canonical: CanonicalSymbolResolution;
  /** Risk / session profile, when ARX has one for this instrument. */
  profile: (SymbolInfo & { key: string }) | null;
}

/** Profile lookup by any spelling: exact key, then the universe's standard symbol or display name. */
function findProfile(undecorated: string, canonical: CanonicalSymbolResolution): (SymbolInfo & { key: string }) | null {
  const keys = [undecorated, canonical.displaySymbol, canonical.market?.displayName ?? ""].filter(Boolean);
  for (const k of keys) {
    const hit = SYMBOL_REGISTRY[k];
    if (hit) return { ...hit, key: k };
  }
  const want = new Set(keys.map((k) => k.toUpperCase().replace(/[\s()/_.-]/g, "")));
  for (const [key, info] of Object.entries(SYMBOL_REGISTRY)) {
    const names = [key, info.brokerSymbol].map((n) => n.toUpperCase().replace(/[\s()/_.-]/g, ""));
    if (names.some((n) => want.has(n))) return { ...info, key };
  }
  return null;
}

export function resolveInstrument(input: string): InstrumentIdentity {
  const undecorated = normalizeSymbol(input);
  const direct = resolveCanonicalSymbol(input);
  const canonical = direct.universeStatus === "resolved" || !undecorated ? direct : resolveCanonicalSymbol(undecorated);
  return { input, undecorated, canonical, profile: findProfile(undecorated, canonical) };
}
