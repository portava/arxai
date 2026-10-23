// QA — R4 slice 6: canonical symbol resolution + classifySymbol delegation
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §4.1/§4.2;
//  replit-command-arx-R4-marketdata-provenance.md slice 6).
//
// Locks the contracts:
//   1. UNIVERSE SWEEP: every one of the 250 approved @workspace/markets
//      entries resolves — by standard symbol AND display name — to its own
//      market id, with family === the universe assetClass and the router
//      bucket exactly ROUTER_CLASS_BY_FAMILY[family]; none is "unknown".
//   2. LEGACY PARITY: every symbol the pre-slice-6 classifier knew (the
//      router's old FOREX_PAIRS/METALS/INDICES sets, the crypto regexes,
//      plain-letter stocks, and EVERY Deriv-map identifier) keeps its exact
//      previous class through the delegated classifySymbol.
//   3. UNKNOWN ISOLATION: inputs neither registry knows return an EXPLICIT
//      "unknown" (assetClass AND family) — never the deprecated types.ts
//      synthetic default, whose foot-gun behavior is pinned here as
//      deprecated-and-quarantined so a silent "fix" or a new consumer trips
//      review.
//   4. DELEGATION: classifySymbol(x) === resolveCanonicalSymbol(x).assetClass.
//   5. DOCUMENTED TRUTH-DIRECTION CHANGES (deliberate, from the module
//      header): GOLD→metals, NASDAQ/DAX→indices, PEPEUSD→crypto,
//      COPPER→stocks(commodity), R75→synthetic, USOIL keeps stocks with
//      family energy; ambiguity ("oil") never guesses a market.
//
// Offline by construction (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts): dummy unroutable
// DATABASE_URL satisfies @workspace/db init transitively pulled in by
// marketDataRouter; provider env keys are cleared BEFORE module load; no
// query and no network I/O is ever issued — resolution is pure data.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/__qa__/symbolResolution.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.TWELVEDATA_API_KEY;
delete process.env.POLYGON_API_KEY;
delete process.env.FINNHUB_API_KEY;
delete process.env.ALPHA_VANTAGE_API_KEY;
delete process.env.NEWSAPI_API_KEY;
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARX_TOP_250 } from "@workspace/markets";

// Dynamic imports so the env setup above runs before any module init
// (static imports hoist; @workspace/db throws without DATABASE_URL).
const { resolveCanonicalSymbol, ROUTER_CLASS_BY_FAMILY } =
  await import("../symbolResolution.js");
const { classifySymbol } = await import("../marketDataRouter.js");
const { DERIV_SYNTHETIC_SYMBOLS } = await import("../providers/derivProvider.js");
const { getMarketType } = await import("../types.js");

// ── 1. Universe sweep ────────────────────────────────────────────────────────

test("every approved universe entry resolves to itself with a non-unknown class", () => {
  assert.equal(ARX_TOP_250.length, 250, "approved universe is exactly 250 markets");
  for (const m of ARX_TOP_250) {
    const r = resolveCanonicalSymbol(m.standardSymbol);
    assert.equal(r.universeStatus, "resolved", `${m.standardSymbol} resolves`);
    assert.equal(r.canonicalKey, m.id, `${m.standardSymbol} → own id`);
    assert.equal(r.displaySymbol, m.standardSymbol, `${m.standardSymbol} display`);
    assert.equal(r.family, m.assetClass, `${m.standardSymbol} family`);
    assert.equal(
      r.assetClass,
      ROUTER_CLASS_BY_FAMILY[m.assetClass],
      `${m.standardSymbol} router bucket`,
    );
    assert.notEqual(r.assetClass, "unknown", `${m.standardSymbol} never unknown`);
    // Delegation holds over the whole universe.
    assert.equal(classifySymbol(m.standardSymbol), r.assetClass, `${m.standardSymbol} delegation`);
  }
});

test("every approved universe entry also resolves by display name", () => {
  for (const m of ARX_TOP_250) {
    const r = resolveCanonicalSymbol(m.displayName);
    assert.equal(r.universeStatus, "resolved", `${m.displayName} resolves`);
    assert.equal(r.canonicalKey, m.id, `${m.displayName} → own id`);
  }
});

// ── 2. Legacy parity (behavior preservation) ────────────────────────────────

// The router's pre-slice-6 sets, verbatim — the parity contract.
const LEGACY_FOREX = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD",
  "EURJPY", "GBPJPY", "EURGBP", "EURCHF", "AUDJPY", "CADJPY", "CHFJPY",
  "NZDJPY", "AUDNZD", "EURAUD", "EURCAD", "EURNZD", "GBPAUD", "GBPCAD",
  "GBPCHF", "GBPNZD",
];
const LEGACY_METALS = ["XAUUSD", "XAGUSD", "XPTUSD", "XPDUSD"];
const LEGACY_INDICES = [
  "US30", "NAS100", "SPX500", "GER40", "UK100", "JP225",
  "FRA40", "AUS200", "HK50", "EU50", "DXY", "GER30",
];

test("legacy forex/metals/indices sets keep their classes", () => {
  for (const s of LEGACY_FOREX) assert.equal(classifySymbol(s), "forex", s);
  for (const s of LEGACY_METALS) assert.equal(classifySymbol(s), "metals", s);
  for (const s of LEGACY_INDICES) assert.equal(classifySymbol(s), "indices", s);
});

test("legacy crypto and stock shapes keep their classes", () => {
  for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BTCUSD", "ETHUSD", "DOGEUSD", "DOTUSD"]) {
    assert.equal(classifySymbol(s), "crypto", s);
  }
  for (const s of ["AAPL", "TSLA", "MSFT", "NVDA", "GOOGL", "C", "V", "F", "SPY", "QQQ"]) {
    assert.equal(classifySymbol(s), "stocks", s);
  }
  // Energy/commodity tokens the old 1–5-letter regex bucketed as stocks stay
  // in the stocks routing bucket (no energy/commodity router lane exists);
  // the RESOLVER carries the true family.
  assert.equal(classifySymbol("USOIL"), "stocks");
  assert.equal(resolveCanonicalSymbol("USOIL").family, "energy");
  assert.equal(classifySymbol("CORN"), "stocks");
  assert.equal(resolveCanonicalSymbol("CORN").family, "commodity");
  assert.equal(resolveCanonicalSymbol("SPY").family, "etf");
});

test("EVERY Deriv-map identifier still classifies synthetic (boundary preserved)", () => {
  // The synthetic boundary is the class boundary with live-floor consequences;
  // it must not move in either direction. This sweeps the full deriv map:
  // short code, WS id, display name, and the compacted display form the deriv
  // resolver tolerates.
  for (const d of DERIV_SYNTHETIC_SYMBOLS) {
    assert.equal(classifySymbol(d.symbol), "synthetic", d.symbol);
    assert.equal(classifySymbol(d.derivId), "synthetic", d.derivId);
    assert.equal(classifySymbol(d.displayName), "synthetic", d.displayName);
    assert.equal(
      classifySymbol(d.displayName.toUpperCase().replace(/\s+/g, "")),
      "synthetic",
      `compact ${d.displayName}`,
    );
  }
  // Tolerant legacy forms.
  for (const s of ["V75", "V75_1S", "v75", "VOLATILITY 75", "BOOM500", "CRASH1000", "STEP", "JUMP25"]) {
    assert.equal(classifySymbol(s), "synthetic", s);
  }
});

// ── 3. Unknown isolation ─────────────────────────────────────────────────────

test("unknown inputs are EXPLICITLY unknown — never a silent synthetic default", () => {
  for (const s of ["ZZZZZ9", "TOTALLY_FAKE_123", "", "   ", "R_9999", "XXXYYYZZZ", "123456"]) {
    const r = resolveCanonicalSymbol(s);
    assert.equal(r.assetClass, "unknown", `assetClass(${JSON.stringify(s)})`);
    assert.equal(r.family, "unknown", `family(${JSON.stringify(s)})`);
    assert.equal(r.market, null, `market(${JSON.stringify(s)})`);
    assert.notEqual(r.universeStatus, "resolved");
    assert.equal(classifySymbol(s), "unknown", `classifySymbol(${JSON.stringify(s)})`);
  }
});

test("the deprecated getMarketType synthetic default is pinned as quarantined", () => {
  // types.ts getMarketType keeps its historical (buggy) synthetic default —
  // deprecation-notes-only scope this wave, zero importers verified. This pin
  // exists so EITHER a behavior change OR a deletion is a deliberate,
  // reviewed edit here, and so the contrast with the resolver stays proven.
  assert.equal(getMarketType("ZZZZZ9"), "synthetic");
  assert.equal(resolveCanonicalSymbol("ZZZZZ9").assetClass, "unknown");
});

// ── 4. Delegation + documented truth-direction changes ──────────────────────

test("classifySymbol delegates exactly to the resolver", () => {
  for (const s of ["EURUSD", "XAUUSD", "US30", "BTCUSD", "AAPL", "V75", "R_75", "USOIL", "ZZZZZ9", "gold", ""]) {
    assert.equal(classifySymbol(s), resolveCanonicalSymbol(s).assetClass, s);
  }
});

test("documented truth-direction changes (module header) hold", () => {
  // Universe tiers now classify these more truthfully than the old regexes:
  assert.equal(classifySymbol("GOLD"), "metals"); // alias → XAUUSD (was stocks)
  assert.equal(classifySymbol("CABLE"), "forex"); // alias → GBPUSD (was stocks)
  assert.equal(classifySymbol("NASDAQ"), "indices"); // alias → US100 (was unknown)
  assert.equal(classifySymbol("DAX"), "indices"); // provider → GER40 (was stocks)
  assert.equal(classifySymbol("PEPEUSD"), "crypto"); // universe crypto (was unknown)
  assert.equal(classifySymbol("XAUEUR"), "metals"); // universe metal (was unknown)
  assert.equal(classifySymbol("COPPER"), "stocks"); // commodity bucket (was unknown)
  assert.equal(classifySymbol("R75"), "synthetic"); // compact Deriv id R_75 (was unknown)
});

test("ambiguous alias never guesses a market; class falls back to legacy shape", () => {
  const r = resolveCanonicalSymbol("oil"); // USOIL vs UKOIL alias collision
  assert.equal(r.universeStatus, "ambiguous");
  assert.equal(r.market, null, "ambiguity is surfaced, not collapsed");
  assert.equal(r.family, "unknown");
  // Fallback classifies the TOKEN exactly as the old regex would ("OIL" →
  // 1–5 plain letters → stocks) so no caller sees a new class for old input.
  assert.equal(r.assetClass, "stocks");
});

test("unresolved canonicalKey is the normalized token (stable store keying)", () => {
  const r = resolveCanonicalSymbol("  ger30 ");
  assert.equal(r.universeStatus, "not_in_universe");
  assert.equal(r.canonicalKey, "GER30");
  assert.equal(r.assetClass, "indices"); // legacy set preserved via fallback
});
