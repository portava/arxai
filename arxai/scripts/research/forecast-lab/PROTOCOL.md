# Forecast library comparison, frozen 2026-11-17 before execution

Purpose: compare two external statistical baselines with ARX's adopted seasonal
50% range, and test a drift diagnostic. This is offline research, not a Python
trading service. No model is automatically promoted.

Data: existing hash-verified real-markets-v1, all 14 markets × M15/H1. This data
was used in earlier ARX research: the chronological tail is NOT an untouched
external validation sample. No claim of independent trading edge is permitted.

Origins: every 60 bars after the first 40%; futures 60 bars. Parameters use only
bars already closed at the origin. Score checkpoints 15/30/60, interval score
width + 4 × misses (nominal 50%), endpoint coverage, per-market normalized gain.
Report first/last halves separately and all per-series results. Report failures;
never silently drop difficult origins. The current production band is exported
by the existing TypeScript implementation, with its six walk-forward fits.

Candidates fixed before results: ARCH zero-mean normal GARCH(1,1), last 1260
closed returns, refit at every origin; StatsForecast Naive on log closes, 20
prior non-overlapping 60-bar conformal windows, last 1261 bars. Neither candidate
claims a directional edge. River ADWIN(delta=.002) observes endpoint misses
only after each future has completed; drift alerts are diagnostics, not forecast
probabilities or a replacement for ARX's existing model brake.

No tuning after results. Include deterministic hierarchical bootstrap over
series then contiguous blocks of 8 origins (2,000 replicates, seed 20261117).
Pooled positive mean alone is not adoption evidence. Any candidate needs a fresh
pre-registered prospective dataset and production parity/causality tests before
activation. All Python dependencies remain isolated from production Node runtime.
