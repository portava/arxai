# Higher-timeframe chart evidence — 2 November 2026

Application commit: `871f2cb789fcc75784f61f36a77e768d998655e8`.
Base: `bdeb965fa21cc01ae342d8e0ae56903443cad4c1`.
Branch: `codex/ruby-htf-source-binding-20261102`.
Status: scoped offline checks pass; **not release-green**.

## Behavior

Ruby previously admitted higher-timeframe candles using feed usability/freshness alone. Independently fetched bars could therefore influence primary-chart bias despite another provider, account provenance, market or interval.

The existing context now qualifies the higher-timeframe observation before exposing its bars to bias and pivot consumers: canonical market, requested interval, matching provider and cross-interval venue identity, affirmative usability/non-staleness, original UTC evidence on every closed bar, matching last closed time, and recomputed closed-analysis digest. Forming bars remain excluded. A mismatch withholds only the higher-timeframe analysis input; observed status/provenance remains available for diagnostics and primary history is unchanged. It does not grant execution permission.

## Evidence

Logs: `/Users/areyouok/arx-tier1-release/ruby-htf-source-binding-20261102/`.

- Baseline integration regressions: 7 pass / 14 fail. Same cases after fix: 21 pass / 0 fail.
- Existing captured-input backend lane: 96 pass / 0 fail / 0 skipped.
- API typecheck and build pass; whitespace check passes.
- Guards: 85/87. The same 43 normalized failure lines remain in `risky-wording-frontend` and `no-internal-names-user-ui`; three supplemental guards pass.
- Independent static review: no scoped blocker; exact file hashes in `independent-review.json`. Reviewer did not rerun tests.

## Remaining gaps

This validates a captured HTF input, not continuing freshness of a displayed assessment. HTF-only updates still do not invalidate completed reads. Separate captures are not atomic. Public-provider venue equality does not prove the selected broker account. A real qualified-provider propagation/browser acceptance check remains outstanding. The existing frontend contract binds primary closed history only; quote/account revisions remain separate work.

No full root CI, database integration, frontend/browser acceptance, Replit source verification, or performance measurements were run for this backend-only change. No TradingView/MT5 parity claim. No main merge, deployment, Replit sync, existing database changes, workers or broker/live/demo tests.
