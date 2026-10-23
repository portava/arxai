---
name: Scanner vs chart confidence provenance
description: How the scanner row truth-cap actually differentiates data sources, and why read-chart "VERIFIED/Mirror synced" is not the same as live broker-quote alignment.
---

# Scanner row truth-cap differentiates live-vs-not, NOT broker-vs-fallback

The scanner's per-row `dataSource` tags BOTH a broker-clean feed (`mt5_broker`)
AND a fresh provider-fallback (`assistant_real:polygon`, TwelveData, etc.) as
`LIVE_FEED`. Both are therefore eligible for the same final-confidence ceiling.

The row-level truth-cap only **floors non-live** rows:
- `SIMULATOR` → `LOW` + `analysisOnly` + non-selectable + `WAIT_FOR_CONFIRMATION`
- `AWAITING_FEED` / `HISTORY_READY_AWAITING_LIVE_TICK` → not selectable

It does **not** rank a fresh provider-fallback below a broker-clean feed at the
LOW/MEDIUM/HIGH label.

**Where broker-vs-fallback DOES surface:**
- `feedProvider` string (`mt5_broker` vs `assistant_real:polygon`)
- Timeframe coverage — free-tier fallback (Polygon forex) serves only intraday
  + D1, so higher TFs (H1/H4) fall to `SIMULATOR`/`LOW` while broker-clean stays
  live across all TFs.
- `chartConfirmed` (chart-confirmation cap) and the read-chart VERIFIED-basis gate.

**Why (live evidence, all-universe scan 2026-06-11):** EURUSD all 5 TFs
`mt5_broker` → `MEDIUM`/selectable; GBPUSD/USDJPY/XAUUSD intraday
`assistant_real:polygon` → also `MEDIUM`/selectable; their H1/H4 → `SIMULATOR`/`LOW`;
BTCUSDT/ETHUSDT/AAPL/TSLA → all `SIMULATOR`/`LOW` (no broker, no free-tier
fallback). 0 truth-cap violations (no non-live row reached HIGH or actionable).

**How to apply:** When verifying "simulator never leaks as actionable", trust the
row truth-cap. When asked whether fallback ranks below broker-clean, look at
`feedProvider` + TF coverage — NOT the confidence label (a fresh fallback ties a
broker-clean feed at MEDIUM). A verification expectation worded as "fallback must
render capped below broker-clean" does not hold at the final-confidence label.

# read-chart "VERIFIED / Mirror synced" ≠ live broker-quote alignment

read-chart's `trustLine` ("Verified <tf> candles · Live feed · Mirror synced ·
AACI verified") and `basis: VERIFIED` reflect **candle-mirror integrity + clean
broker series + AACI**, NOT that the chart price equals the current broker quote.

The live-quote price-alignment check lives only in chart-intelligence
(`brokerAlignment.aligned` → `gateOutput.tradeConfirmationAllowed`). When it
fails, chart-intelligence `chartTruthScore` is penalized (observed 91.3 with
primaryConcern "Broker deviation FAILED") while read-chart still returned 96.1
`VERIFIED` for the same bar/timeframe.

**How to apply:** Don't equate the two surfaces' "verified"/truth wording. A
read-chart VERIFIED basis does not imply the live-quote alignment gate passed;
that gate (and the "Chart price is syncing with broker — please wait" block) is
chart-intelligence-only and fails safe by blocking chart-based trade confirmation.
