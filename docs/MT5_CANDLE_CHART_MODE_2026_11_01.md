# Original MT5 chart-mode declaration (offline candidate)

This change adds an optional original producer declaration to existing candle payloads. It does not attest the broker, certify historical records, enable a feed, or grant execution permission. No terminal was launched or modified, no broker or application API was contacted, and no existing database was changed.

## Source and meaning

MetaQuotes documents `SYMBOL_CHART_MODE` as the symbol bar construction mode, with `SYMBOL_CHART_MODE_BID` and `SYMBOL_CHART_MODE_LAST`. The boolean overload of `SymbolInfoInteger(symbol, property, value)` explicitly reports query failure. A numeric zero from a failed query must not be treated as BID.

Primary documentation consulted on 2026-11-01:

- https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants
- https://www.mql5.com/en/docs/marketinformation/symbolinfointeger
- https://www.mql5.com/en/book/automation/symbols/symbols_chart_mode

Each actual `CopyRates` call is bracketed by mode queries for the **same exact broker symbol**. Only matching successful BID/LAST observations produce `priceBasis: "bid" | "last"`. Missing, failed, unsupported or changed observations omit the property. The bar still follows its existing transport and validation behavior; this addition does not discard valid OHLC because metadata is unavailable. The before/after observations do not prove the mode never changed between calls, nor establish historical provenance beyond the terminal's declaration at read time.

No symbol-family guess, current quote side, default MID, `_Symbol` fallback, or synthetic-market relabeling supplies this declaration. No declarations are attached to TICK messages or server-built forming candles.

## Producer inventory

| Source under `mt5-bridge/` | Existing paths changed |
| --- | --- |
| `ARX_AI_Universal_Agent_v151.mq5` | Live closed history batch and each backfill page |
| `ARX_AI_Universal_Agent_v152.mq5` | Same batches; CopyRates-based closed CANDLE v2 stream |
| `ARX_AI_Universal_Agent_v154.mq5` | Same batches; CopyRates-based closed CANDLE v2 stream |
| `ARX_AI_Bridge_v2_Beta_Kernel.mq5` | CopyRates-based closed CANDLE v2 stream |

All other tracked `mt5-bridge/*.mq5` versions were searched: no other `CopyRates` candle producer exists. The packaged v1.31 read-only bridge has no candle exporter and remains unchanged. Historical `.mq5` copies under `attached_assets/` are archival inputs, not the repository's maintained source or bridge-package allowlist, and remain unchanged. Identical small helpers are inline in the four standalone source files so no new downloadable include dependency is required.

The batch body builder receives the captured basis for that exact CopyRates call; it does not query a later mode when serializing. Every backfill page captures its own value. Account, native symbol, timeframe, sequence, retry/deduplication, endpoints, volume fields, and trading gates are preserved.

## Consumer limits retained

Authenticated history ingestion already accepts lower-case `priceBasis` and passes it to the existing `mt5PriceBasisEvidence` authority. That path can retain a declaration in the memory mirror. Stored numeric-only candle cache records do not regain original metadata. LAST remains LAST: the diagnostic research consumer only supports explicit BID/MID and must continue to hold LAST.

The v2 route `artifacts/api-server/src/routes/bridgeV2.ts` uses `bridgeAuthPerUserOnly` and passes the resolved user/connection to `ingestBridgeV2Message`. However, `lib/domain/src/bridge-v2/messageContract.ts`'s existing candle schema does **not** retain the new optional field. `artifacts/api-server/src/lib/bridgeV2/ingest.ts` calls `feedMarketDataStore(messageType,payload,freshnessVerdict)` after accepted transaction commit, and constructs a candle using time/OHLC/generic volume only before `mergeCandleFromMT5`.

That stream mirror therefore remains unavailable as original price-basis evidence; this change does not expand its authority or modify its scoping. No claim of cross-account exposure is made here: effective consumer authorization requires a separate audit. A stream replacement may withdraw a prior batch declaration; the existing fail-closed metadata gates are intentional. Preserving scoped original declarations through that path requires a separate reviewed consumer change.

## Offline verification and remaining gaps

The new `mt5-bridge/tests/run_candle_chart_mode.py` extracts the actual MQL producer functions and executes them against `candle_chart_mode_test.cpp`'s deterministic fake terminal. Array declarations are mechanically translated to C++ vectors and one existing string conditional receives an explicit C++ string conversion; no price-basis algorithm is reimplemented. Fixtures cover BID, LAST, failed reads before/after, unsupported values, changing mode in both directions, mixed symbols, separate live/backfill modes, failed CopyRates, exact query ordering, original OHLC/tick counts/account/symbol fields, and existing transport names. It is wired into the existing `test:mt5-demo-ea` offline lane.

This harness is not MetaEditor compilation. Native MQL compilation, terminal compatibility, account-specific runtime feeds and live/demo broker testing remain unverified and were not attempted. No existing binaries or prior compile hashes apply to these changed EA sources.

### Receipt summary

Source baseline: `77359a70`. Receipts: `/Users/areyouok/arx-tier1-release/mt5-candle-chart-mode-20261101/`.

- All four unchanged baseline producers fail the new assertions because the original basis read/declaration is absent.
- Candidate: 60 producer payload cases pass (v151 11, v152 20, v154 20, Kernel 9). Failed CopyRates additionally produces no payload in each supported lane.
- Six semantic mutations are caught: failed query's zero accepted as BID; LAST mislabeled BID; changed before/after mode accepted; backfill reuses live basis; query uses a fixed symbol; stream declaration omitted. Each final mutation is caught at runtime, not by a compiler error.
- Existing offline harnesses: 56 DEMO-core, 105 management-handler, 674 terminal-result assertions pass. These are fake-terminal assertions, not broker tests.
- Three initial C++ harness adaptation errors (existing literal-string concatenation and unused symbols across variants) were corrected and retained in failure logs. One initial wrong-symbol mutation triggered an unused-parameter compile error; the mutation was adjusted without changing production source and then caught at runtime. These are not counted as native compile evidence.
