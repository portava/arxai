# Chart price-basis evidence correction — 1 November 2026

Base: `bdc4c58e37d92c4b1ace22419d26568875a44117`. Follow-up to accepted chart research source `4ad8a5ac`; not a deployment or broker-test receipt.

## Defect and boundary

`runCandleTruth` previously replaced the original provider basis with a symbol-family profile: EURUSD became MID. The direct normalizer separately assumed every MT5 candle was BID. Neither assumption proves the actual producer's chart mode. MetaQuotes documents that MT5 charts may use Bid or Last and exposes the selection through `SYMBOL_CHART_MODE`. [MetaQuotes: chart price types](https://www.mql5.com/en/book/automation/symbols/symbols_chart_mode)

The shipped v152/v154 candle batch builders send CopyRates OHLC and `tickVolume`, but no chart-mode declaration. No EA code is changed here. These legacy MT5 bars now carry UNKNOWN basis and unavailable basis evidence, so new research must hold instead of modeling them as MID or presumed BID.

## Existing authority extended

`lib/data/candlePriceBasisEvidence.ts` defines the additive `CandlePriceBasisEvidence` contract:

- `kind`: `producer_declared` or `unavailable`.
- `basis`: BID, MID, LAST, SYNTHETIC or null.
- `reason`: null for a qualified declaration; a reason for unavailable evidence.

Only original lower-case bid/mid/last declarations on authenticated MT5 candle ingestion qualify in this slice. The existing sync and history request declarations are retained in memory, and broker batch ingestion accepts the same optional declaration. ASK is unsupported by the current chart basis enum and remains unavailable. This is a producer declaration, not independent verification of the producer or a broker execution.

The raw Candle carries the declaration through existing provider memory into normalization. Each MT5 bar retains its own supported basis regardless of symbol-family profile. Mixed basis windows produce an aggregate UNKNOWN Truth result; per-bar evidence stays explicit so consumers can reject the mixed window. Numeric-only cache rows cannot regain a declaration from current account settings. No persisted schema, stored rows or database writes were changed or executed.

Deriv source semantics remain SYNTHETIC, never MID/BID. Other sources retain existing compatibility/profile labels, but their new evidence says unavailable. Consumers must require matching `producer_declared` evidence, not trust those compatibility labels. The optional OpenAPI field and generated client/Zod types preserve legacy wire compatibility.

Forming candles composed from ticks withdraw the original historical declaration, including same-bar replacement. The actual MT5 memory store's last-write-wins behavior also withdraws an earlier declaration when the replacement candle lacks one. Normal OHLC, finality and existing assessment/gate logic remain unchanged by declaration metadata; a focused regression checks this.

## Validation and limitations

Two initial fixtures failed against the original code: provider name incorrectly implied BID, and actual MT5 history ingestion through the mirror/normalizer/Truth path produced an inferred basis. The synthetic preservation fixture passed. After correction, a legacy fixture asserting the unsafe blanket MT5=BID rule failed and was updated to require UNKNOWN without a declaration.

Final focused pure/mocked tests: 117 passed, zero failed/skipped. They cover actual history ingestion, supported/ASK/missing declarations, synthetic/crypto/metals/stocks profile conflicts, mixed bases, numeric-only cache shape, malformed evidence, other-provider declaration rejection, assessment stability, actual memory-store metadata withdrawal, and forming-tip revocation. Persistence is mocked in history ingestion; direct sync HTTP and durable broker-batch integration were reviewed but not run against a database or live API.

OpenAPI regeneration, generated client/Zod/domain declaration builds and API typecheck passed. Parent owns the matching frontend capture/binder change and final combined validation; this backend commit alone does not enforce that frontend gate.

The schema does not authenticate declarations cryptographically, prove old account-era metadata, add real traded volume, or support ASK execution modeling. Existing provider contracts still need explicit original basis before their compatibility labels can support research. Existing database migrations, broker tests, deployment, API activation and trading remain untouched.

## Combined consumer acceptance

Application source `5507f14802b5704e493ff9f6feaeee5b69782292`; test-only correction `4cbd6169` (no runtime changes). The client now requires matching original producer-declared BID/MID evidence on every selected candle, retains it in version 2 frozen snapshots, rejects legacy/tampered snapshots, and rechecks current evidence before showing ledger markers or explanations. The old profile label alone cannot qualify research. Seven new consumer regressions failed before the correction; 66 focused consumer tests pass afterward.

At application5507f148: frontend 2,963 pass / 11 skipped; all four typecheck units, both builds, 87 guards and 7 bindings pass. Targeted backend lanes passed 47 Truth + 150 research/Profit Mission + 54 shape/producer + 52 Truth fixture tests. The initial forming lane passed17/18: its source-text assertion incorrectly treated the new metadata ternary as an append gate. Test-only4cbd6169 inspects actual conditional guards; all18 pass. A deliberately restored broker-only append gate fails the corrected suite, preserving its original protection. Total targeted backend acceptance is321 passing tests, composed across the application run and this test-only rerun; this is not a claim of full root CI on4cbd6169.

Actual Scanner production fixture `fd938a14c3f48ce3`: desktop24/24, CPU4x24/24, phone26/26 assertions pass. These74 are repeated scenario assertions, not74 unique features. They confirm qualified synthetic source-shaped history can run, exact ledger markers remain anchored, basis-only withdrawal clears markers/current explanation while candles remain, the frozen result is clearly marked inspectable, and rerunning without evidence is refused. No page exceptions. All API mutations/broker requests were blocked;40–41 unavailable API requests and44–45 console errors per session are retained. No live API or broker acceptance is implied.

Twelve repeated research samples per case retain every value/outlier. Desktop/slowed/phone warm completion p95:39.7/55.0/22.5ms; feedback-frame p95:14.9/11.0/14.6ms. Cold completion24.3/71.4/22.6ms. These are synthetic175-bar local Worker measurements; frame callbacks follow a status DOM change, not measured pixel paint. They do not establish production first-navigation speed or a speed improvement. The initial restricted local-server startup failed before any browser assertions and is retained separately.

Independent combined read-only review found no blocker. Raw logs, scripts, all timings/screenshots and mutation failure are in `/Users/areyouok/arx-tier1-release/chart-research-basis-20261101/`. No source changes were made by the reviewer. Earlier first-navigation and large-workload performance gaps remain open.

Replit's earlier4ad8a5ac import is still busy at the last read attempt; the connector did not deliver or queue the follow-up question. This correction is not yet imported there. The running API remains unchanged. Until an explicitly authorized producer/API upgrade supplies evidence, existing MT5 historical research is intentionally unavailable. Charts continue displaying candles. No release-green, deployment, broker or overall-completion claim is made.
