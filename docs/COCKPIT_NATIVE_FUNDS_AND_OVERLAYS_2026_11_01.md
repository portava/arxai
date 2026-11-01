# Cockpit monetary source alignment and native chart overlays

Development only; not deployed, not release-green and not proof of instantaneous MT5 matching. The architecture and competitive-chart goal remain active.

## Personal monetary source correction

The non-admin Cockpit previously displayed stored balance/equity from the connection with the most recent account sync, while the MT5 Bridge page read the selected active connection's native report. New native reports did not update those legacy scalars. The Cockpit also displayed the allocation master's broker identity beneath the personal amounts and assumed dollars/two decimals. These were source and identity errors, not merely refresh delay.

The Cockpit now reuses the existing authenticated `/mt5/status` query, key, bounded no-store reader and `NativeAccountReport` component. Personal balance, equity, account profit, credit, used margin and free margin preserve the report's currency and decimal text. Zero equity stays zero. Missing/rejected reports or failed reads never revive legacy scalars, master money or allocation figures. Personal broker identity is separate from the allocation connection. Allocations and supplied-position P/L remain separately labelled, without invented dollar denomination or claims of account-wide reconciliation.

The Dashboard's existing shared stream refreshes that canonical query. No new event stream, endpoint, account selector, execution gate or money engine was added. The five-second poll and existing trailing-read/recovery behavior remain. An actual-component integration test with the real QueryClient, generated HTTP reader and simulated SSE verifies one shared stream/read for two mounted consumers, report replacement before polling, failed-read withholding/recovery and connection-removal clearing. This is a synthetic frontend test, not terminal-to-screen latency measurement.

Independent review found an additional existing transition gap: a cached privileged summary could remain displayed after a fresher mode response removed admin access or entered user preview. The follow-up requires affirmative current admin capability without preview/loading/error, and withholds the whole privileged presentation on conflict. It cannot become ordinary-user allocation or personal-account fallback data. This is display protection; backend authorization and trading policy were unchanged.

## Ongoing chart migration preserved

The isolated ARX native Canvas viewport now renders existing structural lines/events, focused Smart Chart annotations, position/pending/research overlays and revocable Scanner price-line/marker handles. Independent channels clear independently. Analysis focus hides analysis/studies/drawings while retaining separate position/research/Scanner layers. Focus proof requires a successfully completed matching paint; queued, failed, empty or superseded frames cannot certify presentation.

The current chart primitive delegates to the same extracted ARX annotation painter. Cloned inputs prevent later caller mutation. Native exact historical anchors never manufacture new candle timestamps. Research and focused annotations with unavailable required anchors are withheld; optional absent guides may be omitted individually. Canonical price mapping survives Heikin Ashi/log/percentage/indexed/inverted displays. Old Scanner leases cannot create or remove replacement-context objects.

The native viewport is still a laboratory implementation, not the registered Scanner adapter. This does not remove the existing renderer from the app or certify an all-chart migration.

## Source and validation

- Native overlay application: `6a611d45`; initial combined Cockpit source: `c9466fada0a00e9cd6c4cdbecab9e11d9bd07a8e`.
- Browser QA driver: `7c96c848`; final monetary capability correction: `aadecaa9fab3243c28aec4385bb43a276ec03900`.
- Final combined `aadecaa9` frontend: **4,338 pass, 12 skipped, zero failed**, with 249 passing files and two skipped. Dashboard typecheck and production build pass; existing bundle warnings and the synthetic DOM navigation warning remain in the logs. Guards: **85/87**, retaining the same 38 wording and three internal-name findings as `d09c82eb` after normalizing file counts/line numbers. The two failing guards remain failures. Initial combined `c9466fad` results (4,333 pass, 12 skipped, typecheck/build pass) are retained separately.
- Independent focused checks include 40 annotation tests, 33 Scanner-layer tests, 20 viewport overlay tests and eight focus-proof tests; these overlap combined suites. Monetary review: 56 final Cockpit checks pass, including three actual-query integration cases. Broader focused runs also overlap; do not add them as unique coverage totals.
- Native browser: nine groups pass with zero page errors or external requests. Desktop/mobile actual pixels, exact-anchor suppression, focus, lease replacement/reset and PNG export were checked. The corrected mobile capture verifies DPR2 before and after capture, a 732×1,000 Canvas and 780×1,688 page image. The original screenshots unexpectedly captured DPR1 and remain preserved separately. All 27 browser bundle input hashes match `c9466fad`; those chart inputs are unchanged by `aadecaa9`.

Fail-before receipts remain: annotation defensive-input failures, eight focus-proof failures, 14 initial monetary cases, three actual-query integration failures and five cached-master transition failures. These are assertions/new-contract cases, not a count of independent bugs. Initial wrong-directory/launcher failures and the incorrect screenshot capture are retained distinctly.

## Limits and next work

1. MT5 capture still defaults to one second; synchronous terminal work, network, persistence and coalescing can add delay. Notification delivery remains process-local, with three-second reconciliation and five-second polling fallbacks. Server-side stalled reads, distributed delivery and actual terminal-to-screen timing remain open. No new latency or universal equality claim follows from this slice.
2. Native reports remain explicitly current-unverified: clock, report continuity and competing-producer ordering are not certified. A receipt or heartbeat cannot prove present account state. Account totals, ARX allocations, paper performance and supplied-position totals are different scopes and must not be made equal by relabelling or arithmetic.
3. Remaining monetary surfaces still need audit/migration. The audit identifies Analytics' nonexistent top-level summary fields/constant account-status indicator, legacy fallback observation binding and allocation-currency assumptions. No broad all-surface completion is claimed.
4. Native structural-event markers retain the existing containing-bar snapping policy, including its prehistory clamp limitation. Exact line endpoints are stricter than the old series-based renderer. Source/account/timeframe/freshness qualification remains caller-owned. Full adapter, replay/linked views, live affordances and actual Scanner migration remain pending.
5. Long raw price labels preserve digits but are squeezed into the mobile gutter; premium readability is not accepted. No new performance measurements were run. Prior slow-device Scanner first-click, study initialization and full-history costs remain; no TradingView/MT5 parity is claimed.
6. No full root/backend/database suite, authenticated deployed-app acceptance or live/demo broker test was performed. No main merge, deployment/Replit update, existing database operation, worker/trading activation or order occurred.

Raw evidence: `/Users/areyouok/arx-tier1-release/native-chart-overlays-20261101/`. Repository archive: `docs/validation/native-chart-overlays-20261101/receipts.tar.gz`, with source/result hashes in `manifest.json`.
