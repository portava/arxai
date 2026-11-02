# Higher-timeframe assessment revision binding — 2 November 2026

Application commit: `ff25250f3b9eb670f3ac1f5d5510b720c04ef849`.
Base: `4929fff8f87640155ae90856d436282be28f058f`.
Branch: `codex/ruby-htf-revision-20261102`.
Status: scoped offline checks pass; **not release-green**.

## Change

An assessment could remain displayed, or a pending request could finish, after only its higher-timeframe history changed. Two rendered regression cases failed before this fix (39 pass / 2 fail).

The server now freezes a higher-timeframe observation key alongside primary assessment evidence. This key includes the independently captured provider, venue, closed-window revision, status and envelope identity. The frontend observes the same comparison interval and 120-bar analysis view using a shared query, enabled only for assessment panels. Existing plan/evidence binding withdraws completed reads and removes pending request authority before aborting on an observed change. The shared header summary inherits that restriction.

The existing candles API adds optional `view=analysis`; its default remains display with forming tips. Analysis queries use a separate cache key and omit forming-tip upgrades, matching server assessment acquisition. OpenAPI and generated parameter schemas/types were regenerated. Pre-existing unrelated generated drift was recorded and excluded, not silently installed.

Wrong envelope/feed/candle ownership withholds observation. A correctly owned empty unavailable HTF response remains an explicit absence, allowing primary-only analysis. Network failures and pending dependency observations cannot preserve an old positive read. Backend eligibility still independently determines whether HTF bars may influence bias.

## Evidence

Receipts: `/Users/areyouok/arx-tier1-release/ruby-htf-revision-20261102/`.

- Full frontend suite on final source: 4,776 pass / 12 skip / 0 fail.
- Captured-input backend suite: 101 pass / 0 skip / 0 fail, including real route-handler validation with mocked providers.
- All four typecheck units pass; API and dashboard builds pass. Existing chunk-size warnings remain.
- Source guards: 85/87, same 43 normalized failure lines in `risky-wording-frontend` and `no-internal-names-user-ui`. Three supplemental guards pass.
- Independent static review found and closed ownership and analysis/display-view gaps. Final exact hashes recorded; reviewer did not rerun tests.
- Tests cover completed/pending HTF-only revision withdrawal, shared-summary restriction, observation deduplication, failed refresh, six ownership mismatches, explicit unavailable HTF, and default/display/analysis/invalid route modes.

## Limits and next steps

Default observation polling is 15 seconds. Invalidation is immediate upon observing a revision, not a claim of real-time provider push. Independent captures remain non-atomic. Additional FVG timeframe inputs, quote changes and selected broker-account revisions remain unbound. No new confidence or expiry policy was invented. Frontend/backend protocol updates must be installed together; legacy positive responses lacking this dependency are refused.

No full root CI, database integration, browser acceptance, Replit running-source verification or performance measurement was performed. No TradingView/MT5 parity claim. No main merge, deployment, Replit sync, existing database changes, workers, trading or broker/live/demo tests. Architecture and competitive chart goals remain unfinished.
