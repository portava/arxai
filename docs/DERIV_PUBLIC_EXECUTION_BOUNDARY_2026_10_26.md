# Deriv public-data execution boundary

The credential-free public market-data transport uses the exact routed source / primary-provider discriminator `deriv_public`. It may supply fresh candles and ticks for charts and analysis. It does not prove a private account, an execution connection, or permission to open exposure.

The existing feed pre-gate runs before bridge selection and therefore passes no execution bridge identity to `evaluateLiveEntryFeedGate`. Previously, `isBrokerConfirmedLive` accepted every Deriv-backed LIVE verdict. The new explicit exclusion returns false for `source === "deriv_public"` before the existing Deriv allowance. Thus a fresh public feed remains LIVE in the shared analysis verdict while its execution-feed evidence is false. The unbound ENTRY pre-gate returns `BROKER_FEED_NOT_CONFIRMED`; unified live readiness also retains that blocker even when every other account/bridge check passes.

Legacy/authenticated `deriv`, MT5 and other existing provider behavior remains unchanged. CLOSE, REDUCE and MODIFY retain the existing exemption because they manage exposure. The existing explicit owner override for the feed gate also remains unchanged: it can make a refusal observe-only, but it cannot change `feedConfirmed: false` or erase the reported violation. No override or runtime setting was changed by this work. Arm, stop, governor, guardian, account and symbol controls are untouched.

## Integration contract

The public adapter and router must emit and preserve `deriv_public` through cached results and provenance. Do not collapse it to `deriv`, invent a bridge/account identity, or report private authorization from public connection success. Keep the broader Deriv-backed classification for per-symbol market freshness, and preserve synthetic-symbol/zero-volume semantics in analysis normalization. The public transport and this companion refusal must be integrated before the public data path is enabled.

This is not a general account-binding migration. The existing live pre-gate still lacks a selected execution bridge at its call site; that separate limitation remains explicit.

## Offline validation

57 focused tests pass in the broker-confirmed-feed and Wave 4 pre-gate suites. Added regressions construct recent public candles and ticks with no private account, derive the real LIVE market-data verdict, and prove ENTRY refusal even without bridge binding or with an asserted matching bridge. They also cover protective commands, explicit override observability, readiness with otherwise-valid authority, and retained arm/kill/symbol blockers. API typecheck passes.

Tests used an empty environment with a deliberately unusable loopback database URL; no database query, socket/broker test, order, deployment or settings mutation was performed. Evidence: `/Users/areyouok/arx-tier1-release/deriv-public-feed-boundary-20261026/`.
