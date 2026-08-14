---
name: Deriv synthetic feed — liveness signal & boot behavior
description: How to authoritatively confirm the Deriv synthetic WS is live, and why the DB mirror is not the signal.
---

The Deriv WebSocket **self-establishes on server boot** — `artifacts/api-server/src/index.ts`
has a non-blocking eager `getDerivWsClient().ensureConnection()` (gated on `DERIV_APP_ID`),
with lazy `ensureConnection()` as fallback. So after a restart it connects on its own,
**no kick needed** (observed: `connectedAt` ~6s after process start, eager warmup complete
~14s after start, `reconnectCount:0`). Warmup subscribes a core set only
(R_25, R_75, 1HZ25V, 1HZ75V, BOOM1000, CRASH1000); other indices subscribe on first request.

**Do NOT use the `market_candles source='deriv'` mirror as a liveness signal.** Direct reads
of `GET /api/market-data/deriv/candles` do NOT write that mirror (the mirror is written only on
the marketDataRouter path used by scanner/chart routes). A live, healthy feed can show ZERO
fresh `source='deriv'` rows. Trusting the mirror produced a false "feed may be down" alarm.

**Authoritative liveness = `GET /api/market-data/deriv/status`** (USER-gated, no admin needed).
Healthy looks like: `connected:true`, `feedReadinessState:"LIVE_FEED"`, `healthSummary:"healthy"`,
`hasRecentTick:true` with `lastTickAgeMs` in the tens-to-hundreds of ms, fresh `lastTickAt`/`lastCandleAt`.
`otpLastResult:"The token is invalid."` can appear even when healthy/live — it's a benign legacy
OTP-probe field, not a feed failure (the WS authorizes and streams regardless).
Per-index proof: `GET /api/market-data/deriv/candles?symbol=V10|V25|V50|V75|V100&granularity=M5`
returns `ok:true` + real OHLC. Admin-only equivalents: `GET /api/admin/deriv-status` (+ `/check`, `/probe`).

EURUSD/EA broker feed is independent: it's gated by forex market hours. On weekends the EA
re-POSTs Friday's already-present bars (`acceptedBars>0` but `broker_candles.received_at` does
NOT advance because the upsert is a no-op) — that's expected, not a stale feed.

**"Chart frozen / Historical only" reports with a healthy WS — check the UI verdict layer, not the transport:**
- Keep-alive "already subscribed" warnings (JD25/50/75/100) PROVE the WS is connected — Deriv answered.
  It's a self-perpetuating loop: `subscribeTicks` throws before `subscribedSymbols.add()`, so the local
  set never learns and every 20s cycle re-warns AND skips those symbols' keep-alive `getCandles`. Cosmetic.
- The scanner Selected Market panel's `SUPPORTED_SYMBOLS` whitelist (`scannerSelected/symbolNormalize.ts`)
  contains ZERO synthetics — every V75/synthetic `selected-market` read returns `SYMBOL_NOT_SUPPORTED`
  (`ok:false` on every poll) even with a perfect live Deriv feed. Pre-existing, not a feed outage.
- `/api/market-data/deriv/status` is auth-gated; a browser 401 fail-softs the panel to `{configured:false}`
  → misleading "Deriv feed not configured" badge while the feed is live. Distinguish 401 from unconfigured.
- A default 100-bar M15 window spans ~25h — the leftmost visible bar lands at roughly "yesterday same
  hour", which users can misread as "frozen since ~<that hour>".
- Read-only authed probe pattern: mint an ephemeral `auth_user_sessions` row (sha256 token →
  `arx_user_session` cookie), curl the status/candles surfaces, delete the row.
