# EA Candle Push — Post-EA Verification Checklist

**Prerequisite:** The EA has been configured to push candles via `POST /api/mt5/sync-candles`
and at least one push has been received (check `GET /api/admin/market-data/mt5-feed`).

**Rule:** MT5 becomes a contributing provider for a symbol+timeframe ONLY after it passes
this checklist. Until then the router falls through to Deriv / the assistant composite.

---

## Step 1 — Confirm the EA is pushing

```
GET /api/admin/market-data/mt5-feed?symbol=EURUSD&timeframe=M5
```

Expected response:
```json
{
  "feedActive": true,
  "series": [{ "symbol": "EURUSD", "timeframe": "M5", "status": "contributing", "barCount": 150 }]
}
```

If `status` is `"non-contributing"` the EA has not pushed yet. If `"stale"`, the
last push was > 5 minutes ago. Resolve those before continuing.

---

## Step 2 — Pick one non-synthetic, broker-supported symbol

Recommended first-pass symbol: **EURUSD M5** (highly liquid, clean data, broker
always has it).

Do NOT use synthetic symbols (V75, Boom, Crash, etc.) for the first MT5 candle
verification — they come from Deriv, not the MT5 broker, and a mix would make
comparison impossible.

---

## Step 3 — Compare latest candle time

**ARX side** — call:
```
GET /api/data/candles?symbol=EURUSD&timeframe=M5&limit=1
```

Read `candles[0].time` from the response. Confirm:
- `feedStatus.provider` equals `"mt5_broker"` (not `"assistant_real"` or `"deriv"`)
- The timestamp is within the current or last closed M5 bar (within 5 minutes of wall-clock)

**MT5 terminal side** — in the MT5 Charts window for EURUSD M5, hover over the
most recent bar. Read its timestamp and OHLC from the tooltip.

**Pass:** The ARX candle time matches the terminal to within one M5 bar interval (≤ 5 min).
**Fail:** More than one bar behind → the EA push cadence is too slow; re-check the EA interval.

---

## Step 4 — Compare OHLC values

Take the last **3 closed** bars from both sources.

| Field | ARX (`candles[].{open,high,low,close}`) | MT5 terminal |
|-------|------------------------------------------|--------------|
| open  | must match to 5 decimal places           |              |
| high  | must match to 5 decimal places           |              |
| low   | must match to 5 decimal places           |              |
| close | must match to 5 decimal places           |              |

**Pass:** All four fields match across all 3 bars.
**Fail:** Any mismatch → check `priceBasis` (broker may use Bid bars; set `priceBasis:"bid"` in the EA payload).

---

## Step 5 — Check for missing or duplicated bars

From ARX:
```
GET /api/data/candles?symbol=EURUSD&timeframe=M5&limit=50
```

Walk the returned `candles` array and verify:

1. **No gaps** — consecutive bar timestamps are exactly 5 minutes apart (for M5).
   Gaps indicate the EA dropped bars; increase the push window size.
2. **No duplicates** — each timestamp appears exactly once. Duplicates are de-duped
   server-side (last-write-wins) so this should always pass unless the EA sends
   overlapping windows from two different connections.
3. **Bar count** — the response should have the requested `limit` (or as many bars
   as the EA has pushed if fewer than `limit`). Fewer bars than expected means the
   EA pushed a shorter window; increase the CopyRates count.

---

## Step 6 — Confirm chart source label

Open the ARX Scanner chart for EURUSD. The feed-confidence chip should read
**"MT5"** (not "TwelveData", "Polygon", or "Deriv"). If it still shows a
third-party provider, the push cadence is too slow (> 5 min TTL) or the symbol
key doesn't match.

---

## Step 7 — Repeat for each planned symbol+timeframe

Repeat Steps 1–6 for each additional symbol and timeframe before marking that
combination as verified.

---

## Pass/Fail Criteria

| Check | Pass criterion |
|-------|---------------|
| Feed active | `status: "contributing"` in mt5-feed endpoint |
| Latest bar time | Within one bar interval of wall clock |
| OHLC match | 5dp match vs terminal, 3 closed bars |
| No gaps | All intervals exactly 1 × timeframe duration |
| No duplicates | Each timestamp unique |
| Chart source label | Shows "MT5" for the verified symbol |

All six must pass before MT5 is considered a verified contributing provider for
that symbol+timeframe. Non-synthetic markets not yet verified continue to use
the third-party composite (TwelveData → Polygon → AlphaVantage) without any
change to chart behavior.

---

## Non-Synthetic Markets Before Verification

Until a symbol+timeframe pair passes this checklist:

- The market data router returns `MT5_BROKER_FEED_NOT_ACTIVE` for the mt5_broker slot
  and falls through to the next provider in the chain.
- The chart shows the third-party provider name in the feed-confidence chip.
- No data is fabricated. If no provider is configured for a symbol, the chart
  shows an honest empty state.

**MT5 will never be marked as a contributing provider for a symbol it has not
pushed real verified data for.**
