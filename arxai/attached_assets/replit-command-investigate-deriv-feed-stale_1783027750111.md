# COMMAND — INVESTIGATE STALE DERIV SYNTHETIC FEED (read-only diagnosis)

Read this entire command before doing anything. This is a **READ-ONLY** diagnosis. Do NOT edit code, do NOT restart services yet, do NOT change tokens/env, do NOT run migrations. The synthetic chart feed (V75 etc.) is frozen/"historical" in the ARX app — but the account has LIVE open positions on V75 (positions come via the MT5 bridge, which is healthy — EURUSD candles are flowing). So the MT5 bridge is UP; what's stale is specifically ARX's **Deriv API candle/tick provider** that feeds synthetic charts. Find out WHY it's stale so the right fix can be chosen. Report evidence; propose the fix but do NOT apply it in this task.

## THE SYMPTOM (established)
- ARX V75 chart: "Historical only / Live feed unavailable / Analysis only", candles stop ~21:00 UTC, last-known price static. Frozen.
- BUT V75 has 2 LIVE open positions with live entry/TP markers on the chart → the account/bridge is connected; synthetics ARE trading.
- Meaning: not a broker/account outage. The **Deriv provider** (the `deriv` entry in the market-data router's `synthetic: ["mt5_broker","deriv"]` chain) that supplies synthetic CANDLES/TICKS to ARX is not delivering fresh data.
- Separately (do NOT conflate): gold/forex historical is a different issue (EA `CandleSymbols` config) being fixed on the MT5 terminal. THIS task is only the Deriv synthetic feed.

## WHAT TO INVESTIGATE (read-only)

### 1. The Deriv provider + its liveness signal
- Locate the Deriv provider (`artifacts/api-server/src/lib/data/providers/derivProvider.ts`) and the tick-recency function `hasRecentDerivTickFor` (referenced by `symbolFeedVerdictForSymbol.ts`).
- Determine: how does ARX receive Deriv synthetic data — a websocket (WS) subscription, polling, or REST? Where is the connection established and maintained?
- Find `derivKeepAlive.ts` (or equivalent keep-alive) — is there a heartbeat/ping keeping the Deriv WS alive? When did it last run/succeed?

### 2. Connection state (the most likely cause)
- Is the Deriv WS currently CONNECTED or DROPPED? Look for connection-state tracking (connected flag, lastMessageAt, reconnect logic).
- When was the last Deriv tick/message received for any synthetic symbol? (This is the key datum — if it's ~21:00 UTC and now is later, the feed died then.)
- Is there auto-reconnect, and if so, is it failing (retry loop, backoff exhausted, error)? Check logs for Deriv WS disconnect/reconnect/error messages.

### 3. Auth / token
- Does the Deriv connection use an API token / app ID? Is it present in env (do NOT print the secret — just confirm presence/absence)?
- Any auth-failure / unauthorized / token-expired errors in recent Deriv-provider logs?

### 4. Rate-limit / subscription cap
- Deriv WS has subscription limits. How many symbols is ARX subscribing to? Any "rate limit", "max subscriptions", or throttle errors in logs?

### 5. Recent logs (the decisive evidence)
- Pull recent api-server logs filtered for Deriv: connection open/close, ping/pong, tick receipt, errors, reconnect attempts. Report the timeline around when the feed went stale (~21:00 UTC).
- Confirm whether the process is even TRYING to reconnect, or silently gave up.

## CLASSIFY THE CAUSE
- **WS DROPPED, RECONNECT FAILING/STOPPED:** the Deriv websocket disconnected and isn't recovering → fix is restart/repair the connection + ensure keep-alive/reconnect works.
- **KEEP-ALIVE DIED:** the heartbeat stopped, connection went idle and dropped → fix is the keep-alive.
- **TOKEN/AUTH EXPIRED:** Deriv rejected auth → fix is token refresh (operator).
- **RATE-LIMIT/CAP:** too many subscriptions → fix is reduce/stagger subscriptions.
- **PROCESS/SERVICE ISSUE:** the whole feed worker isn't running (e.g. after a restart it didn't re-subscribe) → fix is restart/re-init the Deriv subscription.
- **INCONCLUSIVE:** if logs/runtime state aren't accessible, say so and note what the operator must check.

## SAFETY / SCOPE
- READ-ONLY diagnosis. Do NOT restart the service, refresh tokens, change env, or edit code in THIS task — the point is to identify the cause first. (A restart might "fix" it transiently while masking a keep-alive/reconnect bug that will recur.)
- Do NOT touch the MT5 bridge, the EA, or the gold/forex `CandleSymbols` work — that's a separate, healthy path.
- Do NOT weaken the feed-freshness gate. The gate correctly marking the stale Deriv feed as "historical" is right — the goal is to restore the FEED, not silence the gate.
- Do NOT print secrets/tokens — confirm presence only.

## FINAL REPORT
- How ARX gets Deriv synthetic data (WS/poll/REST) + where the connection lives (file:line).
- Current connection state + timestamp of last Deriv message/tick received.
- Keep-alive status; reconnect logic status (working / failing / gave up).
- Auth/token presence (not value) + any auth errors.
- Subscription count + any rate-limit errors.
- The log timeline around when it went stale.
- The CLASSIFICATION (which cause) + the proposed fix — but NOT applied.
- Whether a simple service restart would likely restore it, AND whether a deeper fix (keep-alive/reconnect/token) is needed so it doesn't recur.

## COMPLETION STANDARD
- The cause of the stale Deriv synthetic feed is identified with evidence (connection state + last-message timestamp + logs), classified into one of the buckets above.
- The proposed fix is stated but NOT applied (read-only task); if it's a transient drop, note that a restart may restore it but flag whether reconnect/keep-alive needs a durable fix to prevent recurrence.
- No code/service/token/env change; MT5/EA/gold path untouched; feed gate untouched.
