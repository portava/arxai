// Test: the market model — trading calendar (μ) + expected-move engine.
//
// Two claims are worth more than the rest of this file:
//
//   1. μ IS NOT WALL-CLOCK TIME. A Friday-evening FX horizon that spans the
//      weekend has 4320 wall-clock minutes and only 1440 of open market. A model
//      that scales risk by √(wall clock) sizes that position as though the
//      market were about to move for three days, when it is shut for two of them
//      and the whole move arrives as one Sunday-open gap. The test pins the
//      exact numbers: mu = 1440 < 4320, with 1 gap counted.
//
//   2. EXPECTED RANGE IS NOT EXPECTED NET. E[max−min] is exactly twice
//      E[|end−start|] for a driftless walk. A stop sized off the net figure gets
//      taken out by ordinary noise on a path that ends up going nowhere.
//
// The synthetic σ is the one volatility number in ARX with no estimation error:
// a Deriv "Volatility N Index" is DEFINED to target N% annualised, so
// σ_1min = (N/100)/√(365·1440) is a closed form and round-trips as an exact
// identity. The test asserts that identity to 1e-12 rather than to a rounded
// decimal, because the identity is the reason the number can be trusted.
//
// Pure unit test — no DB, no network, no clock reads. Offline CI lane.

import {
  getTradingCalendar,
  venueOf,
  isSyntheticInstrument,
  wallClockMinutes,
  synthSigma1min,
  synthVolIndex,
  varOverHorizon,
  sigmaOverHorizon,
  expectedRange,
  expectedNet,
  band,
  annualiseFromMinute,
  expectedMoveOverHorizon,
  resolveSigma1min,
  RANGE_COEFF,
  NET_COEFF,
  MINUTES_PER_YEAR,
} from "@workspace/markets";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }
  function near(actual: number, expected: number, tol: number, label: string) {
    const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
    assert(ok, `${label} (got ${actual}, expected ${expected} ±${tol})`);
  }

  console.log("marketModelTest");
  console.log("===============\n");

  // ── 1. Venue classification ────────────────────────────────────────────────
  console.log("Venue classification");
  for (const s of ["Volatility 75 Index", "Boom 500 Index", "Crash 300 Index", "Step Index", "R_100"]) {
    assert(isSyntheticInstrument(s) && venueOf(s) === "DERIV_SYNTHETIC", `${s} → DERIV_SYNTHETIC`);
  }
  for (const s of ["EURUSD", "XAUUSD", "GBPJPY"]) {
    assert(!isSyntheticInstrument(s) && venueOf(s) === "FX", `${s} → FX`);
  }
  // Crypto trades 24/7 — the old FX default said a weekend BTC position had
  // μ = 0 while the market was diffusing the whole time.
  for (const s of ["BTCUSD", "ETHUSD", "btcusd"]) {
    assert(venueOf(s) === "CRYPTO_24_7", `${s} → CRYPTO_24_7`);
  }
  // Exchange-traded stocks/indices have per-exchange RTH schedules this module
  // does not hold — they classify as EQUITY_RTH and get NO calendar (honest
  // refusal), never the silently-wrong FX 24×5 window.
  for (const s of ["AAPL", "US30", "US500", "TSLA"]) {
    assert(venueOf(s) === "EQUITY_RTH", `${s} → EQUITY_RTH`);
    assert(getTradingCalendar(s) === null, `${s} has no honest calendar → null, not a guess`);
  }
  // An unknown symbol keeps the long-standing FX default.
  assert(venueOf("ZZZUNKNOWN") === "FX", "unknown symbol keeps the FX default");

  // ── 2. The headline: μ over a weekend ──────────────────────────────────────
  // Friday 2026-06-19 00:00 UTC → Monday 2026-06-22 00:00 UTC.
  // 72 wall-clock hours; the FX week closes Fri 22:00 and reopens Sun 22:00, so
  // only Fri 00:00–22:00 (22h) + Sun 22:00–Mon 00:00 (2h) = 24h is open.
  console.log("\nμ over a weekend — the whole point of trading time");
  const fx = getTradingCalendar("EURUSD")!;
  const friday = Date.UTC(2026, 5, 19, 0, 0, 0);
  const monday = Date.UTC(2026, 5, 22, 0, 0, 0);

  near(wallClockMinutes(friday, monday), 4320, 0, "wall-clock elapsed is 4320 min (3 days)");
  near(fx.muMinutes(friday, monday), 1440, 0, "FX μ is 1440 min (1 day of open market)");
  assert(
    fx.muMinutes(friday, monday) < wallClockMinutes(friday, monday),
    "μ is STRICTLY less than wall-clock across a weekend",
  );
  assert(fx.gapsBetween(friday, monday) === 1, "exactly 1 session boundary crossed");

  // Synthetics never close: μ IS wall clock, and there is no gap to cross.
  const syn = getTradingCalendar("Volatility 75 Index")!;
  near(syn.muMinutes(friday, monday), 4320, 0, "synthetic μ equals wall-clock (24/7)");
  assert(syn.gapsBetween(friday, monday) === 0, "synthetic crosses 0 boundaries (never closes)");

  // Crypto too: a weekend BTC horizon is pure diffusion, no gap.
  const btc = getTradingCalendar("BTCUSD")!;
  near(btc.muMinutes(friday, monday), 4320, 0, "crypto μ equals wall-clock across a weekend");
  assert(btc.gapsBetween(friday, monday) === 0, "crypto crosses 0 boundaries (24/7)");
  assert(btc.venue === "CRYPTO_24_7", "the crypto calendar carries its own venue tag");

  // ── 3. Calendar mechanics ──────────────────────────────────────────────────
  console.log("\nCalendar mechanics");
  const satNoon = Date.UTC(2026, 5, 20, 12, 0, 0);
  assert(!fx.isOpen(satNoon), "FX is shut on Saturday");
  assert(fx.sessionOf(satNoon) === null, "no session while shut");
  assert(syn.isOpen(satNoon), "synthetic is open on Saturday");
  assert(syn.sessionOf(satNoon) === "CONTINUOUS", "synthetic session is CONTINUOUS");

  const wedNoon = Date.UTC(2026, 5, 17, 12, 30, 0);
  assert(fx.isOpen(wedNoon), "FX is open midweek");
  assert(fx.sessionOf(wedNoon) === "LONDON_NY_OVERLAP", "12:30 UTC is the London/NY overlap");
  assert(fx.sessionOf(Date.UTC(2026, 5, 17, 2, 0, 0)) === "ASIA", "02:00 UTC is ASIA");
  assert(fx.sessionOf(Date.UTC(2026, 5, 17, 9, 0, 0)) === "LONDON", "09:00 UTC is LONDON");
  assert(fx.sessionOf(Date.UTC(2026, 5, 17, 18, 0, 0)) === "NEW_YORK", "18:00 UTC is NEW_YORK");

  assert(
    fx.nextOpen(satNoon) === Date.UTC(2026, 5, 21, 22, 0, 0),
    "nextOpen from Saturday is Sunday 22:00 UTC",
  );
  assert(
    fx.prevClose(satNoon) === Date.UTC(2026, 5, 19, 22, 0, 0),
    "prevClose from Saturday is Friday 22:00 UTC",
  );
  assert(syn.nextOpen(satNoon) === null && syn.prevClose(satNoon) === null,
    "a venue that never closes has no open/close transitions");

  // μ is additive over adjacent intervals and zero on an empty/reversed one.
  const mid = Date.UTC(2026, 5, 20, 6, 0, 0);
  near(
    fx.muMinutes(friday, mid) + fx.muMinutes(mid, monday),
    fx.muMinutes(friday, monday),
    1e-9,
    "μ is additive across a split",
  );
  assert(fx.muMinutes(monday, friday) === 0, "μ of a reversed interval is 0");
  assert(fx.muMinutes(friday, friday) === 0, "μ of an empty interval is 0");

  // A full week contains exactly 5 trading days, and each week adds one gap.
  const weekStart = Date.UTC(2026, 5, 14, 0, 0, 0); // a Sunday
  near(fx.muMinutes(weekStart, weekStart + 7 * 1440 * 60_000), 7200, 1e-9,
    "one calendar week is 7200 open minutes (24×5)");
  assert(fx.gapsBetween(weekStart, weekStart + 21 * 1440 * 60_000) === 3,
    "three weeks cross three weekly closes");

  // ── 4. The synthetic σ identity ────────────────────────────────────────────
  console.log("\nSynthetic σ — exact by construction, not estimated");
  const v75 = synthSigma1min(75);
  near(v75, 0.75 / Math.sqrt(MINUTES_PER_YEAR), 0, "V75 σ_1min matches the closed form exactly");
  near(v75, 0.0010345, 1e-6, "V75 σ_1min ≈ 0.0010345 (0.10345% per minute)");
  // The identity, to 1e-12: annualising must return exactly the definition.
  near(annualiseFromMinute(v75), 0.75, 1e-12, "V75 annualises back to exactly 0.75 (75%)");
  near(annualiseFromMinute(synthSigma1min(100)), 1.0, 1e-12, "V100 annualises to exactly 1.00");
  near(annualiseFromMinute(synthSigma1min(10)), 0.10, 1e-12, "V10 annualises to exactly 0.10");
  assert(synthSigma1min(150) > synthSigma1min(75), "V150 is more volatile than V75");
  near(synthSigma1min(150) / synthSigma1min(75), 2, 1e-12, "σ is linear in N");

  console.log("\nSynthetic index parsing — null, never a guess");
  assert(synthVolIndex("Volatility 75 Index") === 75, 'parses "Volatility 75 Index" → 75');
  assert(synthVolIndex("volatility 100 index") === 100, "parsing is case-insensitive");
  assert(synthVolIndex("R_50") === 50, 'parses the short form "R_50" → 50');
  for (const s of ["EURUSD", "Boom 500 Index", "XAUUSD", "", "Volatility Index"]) {
    assert(synthVolIndex(s) === null, `${JSON.stringify(s)} has no N → null (never a default)`);
  }

  // ── 5. √-time scaling ──────────────────────────────────────────────────────
  console.log("\n√-time scaling");
  const sig1h = sigmaOverHorizon(v75, 60, 0, 0);
  const sig1d = sigmaOverHorizon(v75, 1440, 0, 0);
  near(sig1h / v75, Math.sqrt(60), 1e-12, "1h σ is √60 ≈ 7.746 × the 1min σ");
  near(Math.sqrt(60), 7.745966, 1e-6, "√60 ≈ 7.745966");
  near(sig1d / v75, Math.sqrt(1440), 1e-12, "1d σ is √1440 ≈ 37.95 × the 1min σ");
  near(Math.sqrt(1440), 37.947332, 1e-6, "√1440 ≈ 37.947332");

  // ── 6. Variance adds; standard deviations do not ───────────────────────────
  console.log("\nDiffusion + gap variance");
  const sigmaGap = 0.004;
  const withGap = varOverHorizon(v75, 1440, 1, sigmaGap);
  const noGap = varOverHorizon(v75, 1440, 0, sigmaGap);
  near(withGap - noGap, sigmaGap * sigmaGap, 1e-18, "one gap adds exactly σ_gap² of variance");
  assert(withGap > noGap, "crossing a boundary raises variance");
  near(varOverHorizon(v75, 1440, 3, sigmaGap) - noGap, 3 * sigmaGap * sigmaGap, 1e-18,
    "gap variance is linear in the number of gaps");

  // The reason to add in variance rather than in σ.
  const sd = Math.sqrt(withGap);
  const sumOfSds = Math.sqrt(noGap) + sigmaGap;
  assert(sd < sumOfSds, "σ_total < σ_diffusion + σ_gap (adding σs would overstate risk)");
  near(sd, Math.sqrt(noGap + sigmaGap * sigmaGap), 1e-18, "σ_total is the √ of summed variances");

  // Degenerate inputs return 0 rather than NaN.
  near(varOverHorizon(v75, 0, 0, 0), 0, 0, "zero horizon and no gaps → zero variance");

  // ── 7. Range vs net displacement ───────────────────────────────────────────
  console.log("\nExpected range vs expected net — not the same number");
  near(RANGE_COEFF, 1.5957691, 1e-6, "range coefficient is 2√(2/π) ≈ 1.5957691");
  near(NET_COEFF, 0.7978845, 1e-6, "net coefficient is √(2/π) ≈ 0.7978845");
  near(RANGE_COEFF / NET_COEFF, 2, 1e-12, "a driftless path TRAVELS exactly twice how far it ENDS");

  const price = 1000;
  const r = expectedRange(sig1d, price);
  const n = expectedNet(sig1d, price);
  assert(r > n, "expected range exceeds expected net displacement");
  near(r / n, 2, 1e-12, "…by exactly 2×, at any σ and price");
  near(band(sig1d, price, 1), sig1d * price, 1e-12, "a 1σ band is σ_τ · price");
  near(band(sig1d, price, 2), 2 * sig1d * price, 1e-12, "a 2σ band is twice the 1σ band");
  near(band(sig1d, price), band(sig1d, price, 1), 0, "band defaults to k = 1");

  // Everything is linear in price: doubling the price doubles the move.
  near(expectedRange(sig1d, 2 * price), 2 * r, 1e-9, "expected range is linear in price");

  // ── 8. Worked example: V75 over one trading day ────────────────────────────
  // 24/7 instrument, so μ = 1440 wall-clock minutes and no gap term.
  console.log("\nWorked example — V75 over 24h at price 1000");
  const v75Day = sigmaOverHorizon(v75, syn.muMinutes(friday, friday + 1440 * 60_000), 0, 0);
  near(v75Day, v75 * Math.sqrt(1440), 1e-15, "σ_24h = σ_1min · √1440");
  near(v75Day, 0.03925, 5e-5, "σ_24h ≈ 3.93%");
  near(expectedRange(v75Day, 1000), 62.63, 0.05, "expected 24h range ≈ 62.6 price units");
  near(expectedNet(v75Day, 1000), 31.32, 0.05, "expected 24h net move ≈ 31.3 price units");

  // ── 9. ExpectedMoveService — the horizon-level composition ─────────────────
  // The spec's V75 worked example (§3, price 100 000): expected RANGE per
  // horizon. These are the numbers a stop must survive; pinning the table pins
  // the σ closed form, the √t scaling and the 1.596 coefficient at once.
  console.log("\nExpectedMoveService — V75 horizon table @ P = 100 000");
  const P0 = 100_000;
  const anchor = Date.UTC(2026, 5, 17, 12, 0, 0); // midweek Wednesday
  const v75Table: Array<[label: string, minutes: number, range: number]> = [
    ["1 minute", 1, 165],
    ["1 hour", 60, 1279],
    ["4 hours", 240, 2557],
    ["daily", 1440, 6264],
    ["weekly", 10_080, 16_570],
  ];
  for (const [label, minutes, want] of v75Table) {
    const em = expectedMoveOverHorizon({
      instrument: "Volatility 75 Index",
      nowMs: anchor,
      horizonMinutes: minutes,
      price: P0,
    });
    assert(em.available, `V75 ${label}: available (closed form, zero external data)`);
    if (em.available) {
      near(em.value, want, want * 0.001, `V75 ${label} expected range ≈ ${want}`);
      near(em.expectedRange / em.expectedNet, 2, 1e-12, `V75 ${label}: range = 2 × net`);
      near(em.muMinutes, minutes, 0, `V75 ${label}: μ is wall-clock (24/7)`);
      assert(em.gaps === 0, `V75 ${label}: no session boundary`);
      assert(em.provenance === "ANALYTIC", `V75 ${label}: provenance ANALYTIC`);
      near(em.bandTwoSigma, 2 * em.bandOneSigma, 1e-9, `V75 ${label}: 2σ band is twice 1σ`);
    }
  }

  // Flavor selection: value carries the flavor-selected number.
  {
    const range = expectedMoveOverHorizon({ instrument: "R_75", nowMs: anchor, horizonMinutes: 60, price: P0 });
    const net = expectedMoveOverHorizon({ instrument: "R_75", nowMs: anchor, horizonMinutes: 60, price: P0, flavor: "net" });
    const sig = expectedMoveOverHorizon({ instrument: "R_75", nowMs: anchor, horizonMinutes: 60, price: P0, flavor: "sigma" });
    assert(range.available && net.available && sig.available, "all three flavors resolve for R_75");
    if (range.available && net.available && sig.available) {
      near(range.value / net.value, 2, 1e-12, "flavor range = 2 × flavor net");
      near(range.value / sig.value, RANGE_COEFF, 1e-12, "flavor range = 1.596 × flavor sigma");
    }
  }

  console.log("\nExpectedMoveService — honest refusals (never a guessed number)");
  // A non-synthetic with no measured σ refuses — σ cannot be guessed.
  {
    const em = expectedMoveOverHorizon({ instrument: "EURUSD", nowMs: anchor, horizonMinutes: 60, price: 1.1 });
    assert(!em.available && em.reason === "SIGMA_UNAVAILABLE", "EURUSD without measured σ → SIGMA_UNAVAILABLE");
  }
  // A stock/index has no honest calendar — refuse, never borrow FX's window.
  {
    const em = expectedMoveOverHorizon({ instrument: "US500", nowMs: anchor, horizonMinutes: 60, price: 5000, sigma1min: 0.0002 });
    assert(!em.available && em.reason === "CALENDAR_UNAVAILABLE", "US500 → CALENDAR_UNAVAILABLE (no RTH calendar yet)");
  }
  // Degenerate inputs refuse rather than emit NaN.
  {
    const em = expectedMoveOverHorizon({ instrument: "R_75", nowMs: anchor, horizonMinutes: 0, price: P0 });
    assert(!em.available && em.reason === "INVALID_INPUT", "zero horizon → INVALID_INPUT");
  }

  console.log("\nExpectedMoveService — FX measured path + the weekend gap term");
  const sigmaFx = 0.0002; // a measured per-minute σ the caller supplies
  // Intraday midweek: no boundary crossed, no σ_gap needed.
  {
    const em = expectedMoveOverHorizon({ instrument: "EURUSD", nowMs: anchor, horizonMinutes: 240, price: 1.1, sigma1min: sigmaFx });
    assert(em.available, "midweek 4h FX horizon resolves from measured σ alone");
    if (em.available) {
      assert(em.provenance === "MEASURED", "measured σ carries MEASURED provenance");
      near(em.muMinutes, 240, 0, "midweek μ = wall-clock inside the session");
      assert(em.gaps === 0, "no boundary crossed midweek");
      near(em.sigmaTau, sigmaFx * Math.sqrt(240), 1e-15, "σ_τ = σ_1min·√μ with no gap term");
    }
  }
  // Friday 12:00 + 24h crosses the weekly close: the gap term is REQUIRED.
  const friNoon = Date.UTC(2026, 5, 19, 12, 0, 0);
  {
    const refused = expectedMoveOverHorizon({ instrument: "EURUSD", nowMs: friNoon, horizonMinutes: 1440, price: 1.1, sigma1min: sigmaFx });
    assert(
      !refused.available && refused.reason === "GAP_SIGMA_UNAVAILABLE",
      "weekend-crossing horizon without σ_gap REFUSES (dropping the gap would understate risk)",
    );
    const withGap = expectedMoveOverHorizon({ instrument: "EURUSD", nowMs: friNoon, horizonMinutes: 1440, price: 1.1, sigma1min: sigmaFx, sigmaGap: 0.004 });
    assert(withGap.available, "the same horizon WITH a measured σ_gap resolves");
    if (withGap.available) {
      assert(withGap.gaps === 1, "exactly 1 boundary crossed (forward anchoring from Friday noon)");
      near(withGap.muMinutes, 600, 0, "μ = Fri 12:00→22:00 only (10h open)");
      near(
        withGap.sigmaTau,
        Math.sqrt(sigmaFx * sigmaFx * 600 + 0.004 * 0.004),
        1e-15,
        "σ_τ composes diffusion + gap in VARIANCE",
      );
    }
    // Anchored just AFTER the weekend (Sunday 22:00), the same 24h horizon
    // crosses nothing — forward anchoring decides the gap count.
    const sunOpen = Date.UTC(2026, 5, 21, 22, 0, 0);
    const after = expectedMoveOverHorizon({ instrument: "EURUSD", nowMs: sunOpen, horizonMinutes: 1440, price: 1.1, sigma1min: sigmaFx });
    assert(after.available, "the same horizon anchored at the Sunday open needs no σ_gap");
    if (after.available) assert(after.gaps === 0, "…because it crosses 0 boundaries");
  }

  // σ resolution order: analytic beats a supplied estimate for a synthetic.
  {
    const r = resolveSigma1min("Volatility 75 Index", 0.123);
    assert(r !== null && r.provenance === "ANALYTIC", "synthetic σ resolution is ANALYTIC");
    near(r!.sigma1min, synthSigma1min(75), 0, "…and equals the closed form, never the estimate");
    assert(resolveSigma1min("EURUSD", null) === null, "no measured σ ⇒ null, never a default");
  }

  // ── 10. Import isolation from the dispatch/gate path ───────────────────────
  // Asserted here as a behavioural fact — the modules are pure arithmetic and
  // take every instant as an argument, so they cannot read a clock or a feed.
  // (The source-level import ban is enforced separately by ci:guards.)
  console.log("\nPurity");
  assert(
    fx.muMinutes(friday, monday) === fx.muMinutes(friday, monday),
    "μ is deterministic — same inputs, same answer",
  );
  assert(
    synthSigma1min(75) === synthSigma1min(75),
    "σ is deterministic — no clock, no randomness",
  );

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "marketModelTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[marketModelTest] FAILED:", err);
      process.exit(1);
    },
  );
}
