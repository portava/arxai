# Deriv public market data

The market-data transport is an explicit opt-in: `ARX_DERIV_PUBLIC_DATA_ENABLED=true`.
It uses the fixed official public WebSocket endpoint, with no app ID, token, OTP,
authorize request, account identity or trading operation. Leaving the flag unset
preserves existing transports. Changing the mode requires a server restart.

Public data is labeled `deriv_public` throughout routing, candle history,
normalization, chart tips, streams and diagnostics. The original 22-symbol map is
validated against current venue discovery; absent or closed IDs are withheld,
never guessed. Unsupported timeframes (including W1) remain unsupported.
Only the existing four-symbol keep-alive universe is pinned by default; other
known symbols subscribe on demand. Discovery is refreshed periodically.

The transport shares one connection and coalesces discovery, subscription and
identical candle reads. Pending requests are bounded, history responses are
limited to 5,000 bars, and requests are capped at 180/minute and 10,000/hour per
process, below the venue public limits. Ping is excluded. This is a local budget,
not a distributed quota service. Reconnects use bounded exponential backoff with
jitter. A ping timeout or uncertain subscription closes the session. Closed
sessions clear live evidence and cannot publish late responses.

Ticks must have the exact native symbol, a finite positive price, a positive
provider epoch no later than now, and nondecreasing provider time. Candle OHLC,
provider time and ordering are validated. Freshness uses provider timestamps,
never the arrival clock. Global live-data status means at least one fresh
subscribed symbol; the health page reports each symbol separately. Discovery
alone is not historical-candle evidence. Chart tips cannot cross provider
identity, and a history continuation cannot append public bars to a legacy
source cache.

Public quote data is last-price only. No bid, ask or spread is invented. Scanner
paths requiring an observed executable spread remain withheld. Account and order
capabilities stay false. The live ENTRY feed gate explicitly refuses
`deriv_public`; protective CLOSE, REDUCE and MODIFY behavior is unchanged.
Existing owner, arm, governor, guardian and broker gates remain in force.

## Evidence and operation

The initial Replit development audit found the feed unconfigured, disconnected,
with zero subscriptions and no last tick. This package is based on upstream
`76cdbdc9525a2da1eec8113cb3c5fe9b63cf2325`; the independent execution and chart-source
companions are included. No deployment or trading validation is implied.

A finite local run of the implemented client at 2026-10-26 18:08 UTC discovered
89 instruments, confirmed all 22 configured mappings, and read five M1 candles
for each default instrument. Tick ages at observation were 577–1,330 ms.
`authorized` and `accountConnected` were both false. That proves the implemented
public transport, not the running Replit app. Development verification must be
recorded separately after installation and opt-in.

Offline checks: `pnpm --filter @workspace/api-server test:deriv-public-data` and
`pnpm --filter @workspace/trading-dashboard test:deriv-health` run in CI. The
finite public-only diagnostic is
`ARX_DERIV_PUBLIC_DATA_ENABLED=true pnpm --filter @workspace/api-server diagnose:deriv-public-data`.
It is never run by CI and never sends account or order requests.

Official protocol references:
- https://developers.deriv.com/docs/options/ws-public/
- https://developers.deriv.com/docs/data/active-symbols/
- https://developers.deriv.com/docs/data/ticks/
- https://developers.deriv.com/docs/data/ticks-history/
- https://developers.deriv.com/docs/limits/
