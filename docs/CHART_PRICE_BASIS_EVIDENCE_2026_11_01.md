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
