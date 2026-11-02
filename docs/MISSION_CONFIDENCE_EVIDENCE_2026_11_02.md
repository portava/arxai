# Profit Mission count-only confidence — 2 November 2026

Application: `a3f433fc8ff5b7e4f4dbb5557377ce6e1694efaf`.
Base: `69fc7502aa3b303b48499554ac30980c9248fdbe`.
Branch: `codex/mission-confidence-evidence-20261102`.

**Verdict: scoped confidence-evidence repair verified offline. All-engine accuracy, calibrated probabilities and release readiness remain unproven.**

## Failure and repair

`evaluateProbability` receives planning math and a sample count, but no historical outcomes, provenance or calibration. Previously, counts of 30 and 100 promoted confidence to medium/high; any positive count also removed the planning-only notice. None of those promotions was supported by the input contract.

All results from this engine now remain planning-only, retain a warning and keep the legacy low-confidence label. Positive counts are explicitly described as unverified. Non-finite, negative, fractional and unsafe-integer counts become zero; safe integer counts are diagnostic only. Zero/omitted-count behavior and exact existing notice are preserved. Projection arithmetic, trading gates and AI entry authorization are unchanged.

The frontend, API route and serializer currently pass zero. This is a latent API-contract correction, not proof that a deployed screenshot changed. Existing probability-like numbers are still heuristic planning calculations, not calibrated win probabilities. The retained low label does not establish calibration either.

## Exact validation

| Check on application above | Result |
|---|---|
| Mission engine suite | 76 pass, 0 fail, 0 skipped |
| Mission serializer | 4 pass, 0 fail, 0 skipped |
| Frontend honest-labelling suite | 18 pass |
| Library / API / dashboard type checks | Pass |
| Independent review | Clear; three final source hashes match; separate 76/76 engine rerun |
| Full CI, guards, builds, full frontend, browser and broker checks | Not run on this commit |

Before the implementation change, the strengthened engine suite had 65 pass / 11 fail. The failed cases are retained. These are test-case counts, not a claim of eleven separate bugs. Coverage includes former thresholds, maximum safe integer, malformed counts, JSON serialization and unchanged numerical projections as counts vary. The final validation runner retained a clean tree and unchanged application commit.

Raw receipts: `/Users/areyouok/arx-tier1-release/mission-confidence-evidence-20261102`.
Archive: `/Users/areyouok/arx-tier1-release/mission-confidence-evidence-20261102.tar.gz`.
SHA-256: `d87f097df1a08fccedc0bf06b5c07919e77be52b61ff79a495cfd36b4c4a9f83`.

## Remaining accuracy work

This closes the count-only promotion candidate identified in `ENGINE_ACCURACY_RISK_SIZING_2026_11_02.md`. Strategy-edge time handling remains a separate uncorrected candidate. Malformed planning/math inputs, legacy stored DTOs, runtime reachability and other confidence engines were not comprehensively audited here.

Every engine needs independent input and numerical evidence, not agreement alone: source/account/currency/symbol/timeframe/window/observation identity, expiry, conflicting evidence and incomplete data must be carried to its consumers. Broker money timing, confirmed-close reversal, chart/AI evidence reconciliation and all other engine-family gaps in the earlier audit remain open. No universal accuracy percentage, launch-ready verdict or TradingView/MT5 parity follows.

No deployment, main merge, existing database changes, worker/trading enablement or broker tests occurred.
