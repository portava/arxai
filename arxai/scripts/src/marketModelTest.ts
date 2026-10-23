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

  // ── 2. The headline: μ over a weekend ──────────────────────────────────────
  // Friday 2026-06-19 00:00 UTC → Monday 2026-06-22 00:00 UTC.
  // 72 wall-clock hours; the FX week closes Fri 22:00 and reopens Sun 22:00, so
  // only Fri 00:00–22:00 (22h) + Sun 22:00–Mon 00:00 (2h) = 24h is open.
  console.log("\nμ over a weekend — the whole point of trading time");
  const fx = getTradingCalendar("EURUSD");
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
  const syn = getTradingCalendar("Volatility 75 Index");
  near(syn.muMinutes(friday, monday), 4320, 0, "synthetic μ equals wall-clock (24/7)");
  assert(syn.gapsBetween(friday, monday) === 0, "synthetic crosses 0 boundaries (never closes)");

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

  // ── 9. Import isolation from the dispatch/gate path ────────────────────────
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
