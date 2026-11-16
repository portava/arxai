# COMMAND — VERIFY GOLD/FOREX CANDLES AFTER THE CandleSymbols EA CONFIG CHANGE (read-only)

Read this entire command before doing anything. This is a **READ-ONLY VERIFICATION** task. Do NOT edit code, do NOT change EA config (that's done on the MT5 terminal by the operator), do NOT run migrations. The operator has (or is about to) set the MT5 EA's `CandleSymbols` input to include gold/forex symbols. A prior read-only diagnosis already confirmed the root cause is CONFIG-ONLY: only `EURUSD` was arriving in `broker_candles` (643 bars/hr, fresh), zero gold ever, zero ingestion rejects, backend healthy. Your job now is to re-run the same windowed query to CONFIRM the newly-added symbols are arriving — and if any are NOT, determine whether it's a symbol-name mismatch (not the pipeline).

## CONTEXT (already established, don't re-litigate)
- The candle table is `broker_candles`; ingestion is healthy (accepts EURUSD ticks+candles now, zero rejects).
- Before the change: DISTINCT symbols in `broker_candles` = only `EURUSD` (+ three old `QC*` test symbols from June 16). Gold never arrived under any suffix variant.
- The EA's `CandleSymbols` input controls which symbols it streams; it was streaming only EURUSD. The operator is extending it to include gold/forex (e.g. `EURUSD,XAUUSD,GBPUSD,XAGUSD` — exact broker names).

## WHAT TO CHECK (read-only queries)

### 1. Distinct symbols now arriving (the decisive query)
Query `broker_candles` for DISTINCT symbols received in the last **10 minutes, 1 hour, and 6 hours**, with per-symbol: row count, newest bar timestamp (UTC), and how fresh (seconds/minutes ago).
- Report the full distinct-symbol list per window.
- Specifically flag which of the operator's newly-added symbols (ask/confirm the exact list they set, or check against the common set: XAUUSD, XAGUSD, GBPUSD, USDJPY, etc.) are NOW present vs still absent.

### 2. Freshness of the new symbols
For each newly-arriving symbol, confirm the newest bar is RECENT (within the last few minutes), not a one-off stale insert — i.e. it's actively streaming, not a single test row. Report newest-bar age per symbol.

### 3. Ingestion health for the new symbols
- Check the ingestion trace/logs (last 30-60 min) for any CANDLE messages for the new symbols: accepted vs rejected, and any `reject_reason` / parse error / validation failure / DB insert failure.
- Confirm: are the new symbols being accepted cleanly (like EURUSD was), or are there NEW rejects/errors that appeared after the config change? (A reject_reason mentioning a symbol = that symbol posted but failed — different from never-arriving.)

### 4. Suffix-variant check (the symbol-name failure mode)
If an expected symbol (e.g. XAUUSD) is NOT arriving, check whether it's arriving under a SUFFIXED name instead (`XAUUSD.r`, `XAUUSD.m`, `XAUUSD.pro`, `GOLD`, etc.) — query for `XAU%`, `%GOLD%`, and any `<expected>%` pattern. If gold rows appear under a suffixed name, that IS gold — the operator's `CandleSymbols` string just needs to match the broker's exact name.

## CLASSIFY THE RESULT
- **SUCCESS:** all newly-added symbols are arriving fresh in `broker_candles` with clean ingestion (no rejects). → Report done; gold/forex now have MT5 history and will escape the Polygon fallback cap. Note the operator can now confirm the chart shows LIVE (not historical) for those symbols.
- **PARTIAL / NAME MISMATCH:** some symbols arrive, others are silent — AND the silent ones don't appear under any suffix variant either. → The silent symbols' names in `CandleSymbols` likely don't match the broker's exact strings. Report WHICH symbols are silent, and instruct the operator to re-check those specific symbols' exact names in MT5 Market Watch (right-click → Symbols) and correct the `CandleSymbols` string. The pipeline is proven working (other symbols arrived), so it's the string, not the system.
- **SUFFIX FOUND:** an expected symbol is arriving under a suffixed name (e.g. `XAUUSD.r`). → Tell the operator the broker's actual symbol string so they can align `CandleSymbols` (or confirm it's already correct and just displays suffixed).
- **STILL NONE / NEW REJECTS:** if NO new symbols arrive at all, or new reject/error rows appear → report it clearly; this would mean either the EA config didn't take (operator should confirm they reattached the EA and the input saved) or a genuine issue emerged — do NOT assume, report the evidence and flag for further diagnosis.

## NON-NEGOTIABLE
- READ-ONLY. No code change, no EA config change, no migration. Only DB queries + log reads.
- Do not assume the config change worked or didn't — report what the DATA shows, per symbol.
- If runtime data/logs are unavailable, say so clearly rather than guessing.

## FINAL REPORT
- The distinct-symbol query results (10min/1h/6h) with per-symbol row count + newest-bar freshness.
- Which newly-added symbols are arriving vs silent.
- Ingestion health for the new symbols (accepted vs any rejects/errors).
- Suffix-variant findings if any expected symbol is arriving under a different name.
- The classification (SUCCESS / PARTIAL-NAME-MISMATCH / SUFFIX-FOUND / STILL-NONE) with the exact next action for the operator if anything is still silent.

## COMPLETION STANDARD
- The `broker_candles` distinct-symbol query is re-run and reported per window, showing whether the operator's newly-added gold/forex symbols are now arriving fresh.
- Ingestion health for the new symbols is confirmed (clean accept vs rejects).
- A clear classification is given, and if any symbol is still silent, the operator is told exactly which one and whether it's a name-string issue (pipeline proven working) vs something to investigate.
- NO code / config / migration change — read-only verification only.
