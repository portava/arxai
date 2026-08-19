// Deriv `active_symbols` runtime discovery — pure parse + report-only validation.
//
// Closes audit-deriv.md gap G1 (spec §10:751-757): venue symbol ids must be
// discovered at runtime and the hard-coded maps verified against discovery —
// never trusted blind. Both `active_symbols` call sites previously reduced the
// payload to `arr.length`, so drift like BOOM500/CRASH500 vs BOOM500N/CRASH500N
// (derivProvider.ts vs lib/markets universe) could never be detected.
//
// HONESTY DOCTRINE (inviolable):
//   - Report-only. validateKnownMap NEVER auto-corrects, renames, or suggests
//     replacement ids — a guessed venue id must fail loudly, not be silently
//     rewritten. Fixing the static maps is a deliberate, reviewed change.
//   - parseActiveSymbols skips malformed entries rather than fabricating
//     fields; a non-array payload yields an empty result, never an invented one.
//
// Pure module: no I/O, no logging, no imports beyond types. Callers own
// retention, timestamps, and warning policy (see derivWsClient.retainDiscovery).

/** One symbol as reported by the venue's `active_symbols` (brief) response. */
export interface DiscoveredDerivSymbol {
  symbol: string;         // Deriv WS id, e.g. "R_75", "BOOM500N"
  displayName: string;    // venue display name, e.g. "Volatility 75 Index"
  market: string;         // venue market key, e.g. "synthetic_index"
  submarket: string;      // venue submarket key, e.g. "random_index"
  exchangeIsOpen: boolean;
}

/** Timestamped retention envelope for the most recent discovery. */
export interface DerivDiscoverySnapshot {
  fetchedAt: string;      // ISO timestamp of the discovery round-trip
  fetchedAtMs: number;    // same instant as epoch ms, for age computation
  symbols: DiscoveredDerivSymbol[];
}

/** Minimal shape of a static-map entry to validate (see DERIV_SYNTHETIC_SYMBOLS). */
export interface KnownDerivMapEntry {
  symbol: string;         // ARX-internal label, e.g. "BOOM500"
  derivId: string;        // the hard-coded venue id under validation
  displayName: string;
}

/** A static-map entry the venue did not report — a hard-coded id that cannot
 *  be confirmed at the venue (possibly guessed/drifted). */
export interface DerivMapMismatch {
  arxSymbol: string;
  derivId: string;
  displayName: string;
}

export interface DerivMapValidation {
  /** Static-map deriv ids confirmed present at the venue. */
  matched: string[];
  /** Static-map entries absent from the venue payload (drift candidates). */
  missingFromVenue: DerivMapMismatch[];
  /** Venue synthetic-index ids absent from the static map. Scoped to the
   *  synthetic-index market so unrelated asset classes (forex, crypto, ...)
   *  do not flood the report. */
  unknownAtVenue: string[];
}

// Deriv's market key for synthetic indices in `active_symbols` responses.
const SYNTHETIC_MARKET_KEY = "synthetic_index";

/** Parse a raw `active_symbols` array into typed entries. Malformed entries
 *  (no string `symbol`) are skipped — fields are never guessed or invented. */
export function parseActiveSymbols(raw: unknown): DiscoveredDerivSymbol[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredDerivSymbol[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.symbol !== "string" || rec.symbol.length === 0) continue;
    out.push({
      symbol: rec.symbol,
      displayName: typeof rec.display_name === "string" ? rec.display_name : "",
      market: typeof rec.market === "string" ? rec.market : "",
      submarket: typeof rec.submarket === "string" ? rec.submarket : "",
      // Venue sends 0/1; tolerate a boolean. Anything else reads as closed —
      // never assume an exchange is open without evidence.
      exchangeIsOpen: rec.exchange_is_open === 1 || rec.exchange_is_open === true,
    });
  }
  return out;
}

/** Compare a static symbol map against a discovery payload. Report-only:
 *  returns the diff and mutates neither input. Id comparison is exact and
 *  case-sensitive — venue ids are opaque identifiers, not text. */
export function validateKnownMap(
  discovered: readonly DiscoveredDerivSymbol[],
  staticMap: readonly KnownDerivMapEntry[],
): DerivMapValidation {
  const venueIds = new Set(discovered.map((d) => d.symbol));
  const knownIds = new Set(staticMap.map((k) => k.derivId));
  const matched: string[] = [];
  const missingFromVenue: DerivMapMismatch[] = [];
  for (const k of staticMap) {
    if (venueIds.has(k.derivId)) {
      matched.push(k.derivId);
    } else {
      missingFromVenue.push({
        arxSymbol: k.symbol,
        derivId: k.derivId,
        displayName: k.displayName,
      });
    }
  }
  const unknownAtVenue = discovered
    .filter((d) => d.market === SYNTHETIC_MARKET_KEY && !knownIds.has(d.symbol))
    .map((d) => d.symbol);
  return { matched, missingFromVenue, unknownAtVenue };
}
