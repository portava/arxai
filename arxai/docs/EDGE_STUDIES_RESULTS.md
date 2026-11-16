# Edge studies on stored MT5 history (2026-11-16)

Two pre-registered studies, run once, reported as measured. Code:
`scripts/src/research/edgeStudies.ts` (pure, tested by
`scripts/src/edgeStudiesTest.ts`: no lookahead, planted-trend positive control,
random-walk negative control, cost arithmetic, scanner R arithmetic, edge rule)
and `scripts/src/research/runEdgeStudies.ts` (read-only runner).

**Data.** A read-only export of the production `broker_candles` table, loaded
into a disposable local database and compacted (lossless, verified bar for bar).
Newest 50,000 closed bars per symbol at M1/M5/M15/H1, and up to 200,000 at
H4/D1. 43 symbols, of which 22 are Deriv synthetics. The broker's D1/H4
history for EURUSD, USDJPY and USDCHF starts in 1971. EURUSD before 1999 can
only be a spliced proxy, so pre-1990s results are weak evidence.

**Costs are assumed, not measured.** The scanner study uses half-spreads of
fx 0.5 bp, metal 0.5 bp, index 1 bp, crypto 5 bp and synthetic 1 bp per side.
The trend study charges fx 1 bp, metal 5 bp, index 2 bp and crypto 10 bp per
unit of turnover, plus 2%/yr financing on the position held.

## 1. Scanner expectancy after costs

Every scanner call is replayed from closed bars only, using the exact scanner
row. Calls never overlap. Each resolves on the first touch of its stop or
target within 60 bars, with the stop checked first inside a bar. A target
scores +reward/risk, a stop scores −1, and the round-trip spread is subtracted
in R. A cell has an edge only if two things hold. First, net expectancy must be
above zero at the Bonferroni bound over the 16 real-market cells (z = 2.96).
Second, the later half must also be positive on its own. Synthetics are the
negative control.

| cell | calls | hit | gross R | net R | net lower bound | net, 2nd half | edge |
|---|---:|---:|---:|---:|---:|---:|---|
| crypto/D1 | 506 | 0.387 | +0.162 | +0.148 | −0.044 | +0.150 | no |
| crypto/H1 | 2,774 | 0.347 | +0.040 | −0.060 | −0.140 | −0.032 | no |
| crypto/H4 | 2,889 | 0.366 | +0.099 | +0.059 | −0.021 | +0.045 | no |
| crypto/M15 | 2,846 | 0.336 | +0.008 | −0.277 | −0.356 | −0.224 | no |
| fx/D1 | 13,356 | 0.346 | +0.038 | +0.014 | −0.022 | +0.004 | no |
| fx/H1 | 23,678 | 0.326 | −0.022 | −0.077 | −0.104 | −0.067 | no |
| fx/H4 | 26,101 | 0.328 | −0.016 | −0.040 | −0.066 | −0.041 | no |
| fx/M15 | 20,716 | 0.314 | −0.057 | −0.186 | −0.215 | −0.180 | no |
| index/D1 | 235 | 0.277 | −0.170 | −0.183 | −0.442 | −0.226 | no |
| index/H1 | 4,206 | 0.328 | −0.017 | −0.089 | −0.153 | −0.100 | no |
| index/H4 | 1,368 | 0.339 | +0.018 | −0.020 | −0.134 | −0.029 | no |
| index/M15 | 5,194 | 0.336 | +0.007 | −0.158 | −0.216 | −0.146 | no |
| metal/D1 | 537 | 0.365 | +0.095 | +0.090 | −0.094 | +0.143 | no |
| metal/H1 | 2,884 | 0.342 | +0.026 | +0.008 | −0.071 | +0.038 | no |
| metal/H4 | 2,509 | 0.355 | +0.065 | +0.054 | −0.031 | +0.056 | no |
| metal/M15 | 2,958 | 0.335 | +0.004 | −0.020 | −0.097 | −0.022 | no |
| synthetic/D1 (control) | 3,517 | 0.326 | −0.021 | −0.026 | −0.096 | −0.024 | no |
| synthetic/H1 (control) | 29,601 | 0.337 | +0.012 | −0.013 | −0.038 | −0.021 | no |
| synthetic/H4 (control) | 21,588 | 0.329 | −0.012 | −0.024 | −0.053 | −0.021 | no |
| synthetic/M15 (control) | 32,153 | 0.339 | +0.018 | −0.038 | −0.061 | −0.028 | no |

**Verdict: no edge in any cell.** Every call carries a fixed 2:1 target. The
hit rate stays close to ⅓, which is what a random entry would get with a 2R
target and a 1R stop, so gross expectancy is about zero. On M15 and H1, spread
alone makes it clearly negative. The only cells positive on both halves are
crypto D1/H4 and metal D1/H4. None of them reaches significance, so they are
candidates for a future pre-registered test, not findings.

## 2. Time-series momentum (trend following), vol-targeted

Position = sign(return over the lookback) × 10% / realised volatility over the
past 63 days, capped at 3×. It is decided at the prior close. The 21
non-synthetic symbols with enough history are equal-weighted. Lookbacks are
21/63/126/252 days plus their blend, on D1 and H4: 10 tests, Bonferroni
z = 2.81. An edge needs t above z AND a positive second half.

| test | Sharpe (net) | t | Sharpe (gross) | 1st half | 2nd half | edge |
|---|---:|---:|---:|---:|---:|---|
| D1 21d | 0.41 | 3.05 | 0.86 | 0.92 | −0.43 | no |
| D1 63d | 0.40 | 2.99 | 0.81 | 0.92 | −0.44 | no |
| D1 126d | 0.25 | 1.86 | 0.64 | 0.55 | −0.22 | no |
| D1 252d | 0.12 | 0.92 | 0.50 | 0.38 | −0.29 | no |
| D1 blend | 0.30 | 2.22 | 0.79 | 0.78 | −0.50 | no |
| H4 21d | −0.16 | −1.15 | 0.41 | 0.17 | −0.61 | no |
| H4 63d | −0.16 | −1.15 | 0.33 | 0.01 | −0.40 | no |
| H4 126d | −0.13 | −0.92 | 0.33 | 0.01 | −0.32 | no |
| H4 252d | −0.16 | −1.13 | 0.29 | −0.06 | −0.31 | no |
| H4 blend | −0.22 | −1.57 | 0.41 | −0.00 | −0.54 | no |

Sharpe by decade for D1 21d: 1970s 1.73, 1980s 1.14, 1990s −0.01, 2000s −0.30,
2010s −0.63, 2020s −0.46.

**Verdict: no edge.** D1 21d and 63d clear the corrected threshold on the
full sample. Their whole return comes from the 1970s–80s, when only three
pairs were trading and one of them was a spliced proxy. From the 1990s on,
trend following on this universe loses money after costs. H4 loses even
before financing at short lookbacks.

## 3. Strategy-family rerun on the same history

The existing real-data validation harness (`runRealDataValidation.ts --source
mt5_db`) was run with the assumed MT5 costs. It covered 43 symbols ×
M1/M5/M15/H1, using the newest 50,000 closed bars per series. All seven
strategy families and their walk-forward selections were tested under CPCV,
the deflated Sharpe ratio, PBO and family-wide FDR.

- 9,288 tests; Benjamini–Hochberg rejections at q = 0.05: **0**.
- Honesty checks: 2,580 CPCV splits, 6,020 walk-forward folds and 8,084
  lookahead variants, with 0 violations.
- **Survivors: none**, in every symbol × timeframe cell, synthetics included.
- Dataset hash `0c4047a9…`, params `c4f39416…`, result `b300ebaf…`.

## What this changes

- The scanner's direction calls stay uncalibrated. Nothing here supports
  showing them as having positive expectancy.
- Direction calls on random-by-design synthetics are now suppressed
  (`marketDataSufficiency`, reason `random_by_design`). This study's control
  supports that: synthetic cells sit at zero gross.
- The only measured real edge in the system is still the volatility forecast
  (`docs/VOLATILITY_FORECAST_RESULTS.md`).
