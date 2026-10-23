// R4-S5 / R5 — Deriv runtime symbol discovery: parse + report-only validation.
//
// Proves the audit-deriv.md G1 gap closes the honest way:
//   - `active_symbols` payloads are parsed and RETAINED (not reduced to a
//     count), timestamped, and exposed via getLastDiscovery();
//   - the static DERIV_SYNTHETIC_SYMBOLS map is validated against discovery,
//     and the known live drift (static BOOM500/CRASH500 vs a venue reporting
//     BOOM500N/CRASH500N) is REPORTED — never auto-corrected. Guessing venue
//     ids is forbidden; fixing a map is a deliberate, reviewed change.
//
// Offline determinism: fixture payloads only — no Deriv network, no DB. The
// WS client is the process-local singleton; its private discovery entry point
// is invoked directly (established __qa__ private-state pattern) so no socket
// ever opens. logger.warn is instance-patched to count warnings.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/providers/__qa__/derivSymbolDiscovery.test.ts
// (--test-force-exit: the pino-pretty transport worker keeps the loop alive.)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseActiveSymbols,
  validateKnownMap,
  type DerivDiscoverySnapshot,
  type DerivMapValidation,
} from "../derivSymbolDiscovery.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../derivProvider.js";
import { getDerivWsClient } from "../derivWsClient.js";
import { logger } from "../../../logger.js";

// Raw venue-shaped entry (snake_case keys exactly as active_symbols sends them).
const venueEntry = (
  symbol: string,
  displayName: string,
  market = "synthetic_index",
  open: 0 | 1 | boolean = 1,
) => ({
  symbol,
  display_name: displayName,
  market,
  submarket: "random_index",
  exchange_is_open: open,
});

// Drift fixture: the venue reports every static id EXCEPT BOOM500/CRASH500,
// and reports BOOM500N/CRASH500N instead — the exact live drift the audit
// found between derivProvider.ts and lib/markets/src/universe.ts. A non-
// synthetic market entry proves unknownAtVenue scoping.
const DRIFT_VENUE_FIXTURE = [
  ...DERIV_SYNTHETIC_SYMBOLS
    .filter((s) => s.derivId !== "BOOM500" && s.derivId !== "CRASH500")
    .map((s) => venueEntry(s.derivId, s.displayName)),
  venueEntry("BOOM500N", "Boom 500 Index"),
  venueEntry("CRASH500N", "Crash 500 Index"),
  venueEntry("frxEURUSD", "EUR/USD", "forex"),
];

test("parseActiveSymbols retains id, display name, market, submarket, exchange_is_open", () => {
  const parsed = parseActiveSymbols([
    venueEntry("R_75", "Volatility 75 Index", "synthetic_index", 1),
    venueEntry("frxEURUSD", "EUR/USD", "forex", true),
    venueEntry("OTC_SPC", "US 500", "indices", 0),
  ]);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], {
    symbol: "R_75",
    displayName: "Volatility 75 Index",
    market: "synthetic_index",
    submarket: "random_index",
    exchangeIsOpen: true,
  });
  assert.equal(parsed[1].exchangeIsOpen, true); // boolean form tolerated
  assert.equal(parsed[2].exchangeIsOpen, false); // 0 → closed
});

test("parseActiveSymbols skips malformed entries and never fabricates", () => {
  const parsed = parseActiveSymbols([
    null,
    42,
    "R_75",
    { display_name: "no id at all" },
    { symbol: "" },
    { symbol: "R_50" }, // minimal but has an id — kept, missing fields empty
  ]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    symbol: "R_50",
    displayName: "",
    market: "",
    submarket: "",
    exchangeIsOpen: false, // absent open-flag reads closed, never assumed open
  });
  // Non-array payloads yield empty — an empty result, never an invented one.
  assert.deepEqual(parseActiveSymbols(undefined), []);
  assert.deepEqual(parseActiveSymbols({ active_symbols: [] }), []);
});

test("a fully aligned venue matches every static id with no mismatches", () => {
  const aligned = parseActiveSymbols(
    DERIV_SYNTHETIC_SYMBOLS.map((s) => venueEntry(s.derivId, s.displayName)),
  );
  const v = validateKnownMap(aligned, DERIV_SYNTHETIC_SYMBOLS);
  assert.equal(v.matched.length, DERIV_SYNTHETIC_SYMBOLS.length);
  assert.deepEqual(v.missingFromVenue, []);
  assert.deepEqual(v.unknownAtVenue, []);
});

test("the BOOM500/CRASH500 drift fires as missingFromVenue + unknownAtVenue", () => {
  const discovered = parseActiveSymbols(DRIFT_VENUE_FIXTURE);
  const v = validateKnownMap(discovered, DERIV_SYNTHETIC_SYMBOLS);
  assert.deepEqual(
    v.missingFromVenue.map((m) => m.derivId).sort(),
    ["BOOM500", "CRASH500"],
  );
  // The mismatch report carries enough identity for an operator to act on.
  const boom = v.missingFromVenue.find((m) => m.derivId === "BOOM500");
  assert.deepEqual(boom, {
    arxSymbol: "BOOM500",
    derivId: "BOOM500",
    displayName: "Boom 500 Index",
  });
  // Venue-only synthetic ids surface; the forex entry is scoped OUT.
  assert.deepEqual([...v.unknownAtVenue].sort(), ["BOOM500N", "CRASH500N"]);
  // Everything else still matches (spot-check exact ids incl. casing).
  assert.ok(v.matched.includes("R_75"));
  assert.ok(v.matched.includes("stpRNG"));
  assert.equal(v.matched.length, DERIV_SYNTHETIC_SYMBOLS.length - 2);
});

test("validation is report-only: no correction fields, no input mutation", () => {
  const discovered = parseActiveSymbols(DRIFT_VENUE_FIXTURE);
  const staticBefore = JSON.stringify(DERIV_SYNTHETIC_SYMBOLS);
  const discoveredBefore = JSON.stringify(discovered);
  const v = validateKnownMap(discovered, DERIV_SYNTHETIC_SYMBOLS);
  // Exactly the three report keys — no suggestedId / correctedMap / similar.
  assert.deepEqual(
    Object.keys(v).sort(),
    ["matched", "missingFromVenue", "unknownAtVenue"],
  );
  assert.deepEqual(
    Object.keys(v.missingFromVenue[0]).sort(),
    ["arxSymbol", "derivId", "displayName"],
  );
  assert.equal(JSON.stringify(DERIV_SYNTHETIC_SYMBOLS), staticBefore);
  assert.equal(JSON.stringify(discovered), discoveredBefore);
});

// ---------------------------------------------------------------------------
// WS-client retention: the singleton's private retainDiscovery entry point is
// driven directly with fixtures — no socket, no network.
// ---------------------------------------------------------------------------

const client = getDerivWsClient() as unknown as {
  retainDiscovery: (raw: unknown) => void;
  discoveryMismatchWarnedThisConnect: boolean;
  getLastDiscovery: () => DerivDiscoverySnapshot | null;
  getLastDiscoveryValidation: () => DerivMapValidation | null;
  getLastDiscoveryAgeMs: () => number | null;
};

/** Instance-patch logger.warn, run fn, restore; returns the warn count. */
function countWarns(fn: () => void): number {
  let warns = 0;
  const original = logger.warn;
  (logger as unknown as { warn: unknown }).warn = () => { warns += 1; };
  try {
    fn();
  } finally {
    (logger as unknown as { warn: unknown }).warn = original;
  }
  return warns;
}

test("retainDiscovery keeps the timestamped payload and warns once per connect", () => {
  client.discoveryMismatchWarnedThisConnect = false;
  const before = Date.now();

  // 2 missingFromVenue warns + 1 aggregated unknownAtVenue warn.
  assert.equal(countWarns(() => client.retainDiscovery(DRIFT_VENUE_FIXTURE)), 3);

  const snap = client.getLastDiscovery();
  assert.ok(snap, "discovery snapshot retained");
  assert.equal(snap!.symbols.length, DRIFT_VENUE_FIXTURE.length);
  assert.ok(snap!.symbols.some((s) => s.symbol === "BOOM500N"));
  assert.equal(new Date(snap!.fetchedAt).getTime(), snap!.fetchedAtMs);
  assert.ok(snap!.fetchedAtMs >= before && snap!.fetchedAtMs <= Date.now());
  const age = client.getLastDiscoveryAgeMs();
  assert.ok(age != null && age >= 0 && age < 60_000);

  const v = client.getLastDiscoveryValidation();
  assert.ok(v, "validation retained");
  assert.deepEqual(
    v!.missingFromVenue.map((m) => m.derivId).sort(),
    ["BOOM500", "CRASH500"],
  );

  // Same connect session → mismatch warnings are deduped to the first report.
  assert.equal(countWarns(() => client.retainDiscovery(DRIFT_VENUE_FIXTURE)), 0);

  // A reconnect (open handler resets the flag) may warn once again.
  client.discoveryMismatchWarnedThisConnect = false;
  assert.equal(countWarns(() => client.retainDiscovery(DRIFT_VENUE_FIXTURE)), 3);
});

test("an empty payload is retained but never claims the venue lacks our ids", () => {
  client.discoveryMismatchWarnedThisConnect = false;
  const warns = countWarns(() => client.retainDiscovery([]));
  assert.equal(warns, 0); // no false "22 symbols missing" storm
  const snap = client.getLastDiscovery();
  assert.ok(snap && snap.symbols.length === 0, "empty snapshot still timestamped");
  assert.equal(client.getLastDiscoveryValidation(), null);
});
