# Market data readiness without broker testing

The Alpha Vantage adapter incorrectly sent fiat pairs such as EURUSD to the
stock `GLOBAL_QUOTE` endpoint. Supported major pairs now use
`CURRENCY_EXCHANGE_RATE`, preserving bid, ask, pair identity and UTC observation
time. Stock behavior remains unchanged. Missing, invalid, future or stale
timestamps cannot become current merely because a request ran.

Supported pairs: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF and NZDUSD.
Intraday FX candles support M1, M5, M15, M30 and H1. The official `FX_INTRADAY`
endpoint requires suitable provider access. The adapter does not substitute
daily bars, upsample candles or change subscriptions. Missing FX volume uses the
existing zero convention, not observed trading volume. Metadata, timestamps and
OHLC validation reject malformed rows. Old history remains delayed.

Contract sources: [currency rates](https://www.alphavantage.co/documentation/#currency-exchange)
and [FX intraday](https://www.alphavantage.co/documentation/#fx-intraday).

## Read-only check

From the repository root with the environment's existing provider secrets:

```sh
pnpm --filter @workspace/api-server run check:market-data
pnpm --filter @workspace/api-server run check:market-data --symbol GBPUSD
```

The command only requests quotes and ten M1 bars. It does not connect to a
broker, write to a database, change controls, create orders or send email.
It emits one JSON report and exits 0 only when a current quote with bid/ask and
ten contiguous valid recent minute bars are present. Exit 2 means incomplete,
unavailable or invalid input. The report is scoped to that symbol/timeframe,
not all instruments or production. A configured provider alone cannot pass.

The report contains fixed provider/operation labels, HTTP statuses and safe
error codes. No request URLs, credentials, raw upstream messages or account data
are included. The HTTP diagnostic buffer is bounded to 32 observations.
Codes include AUTHENTICATION, ACCESS_RESTRICTED, RATE_LIMITED, HTTP_ERROR,
TRANSPORT_ERROR, TIMEOUT, INVALID_JSON and PROVIDER_ERROR. HTTP 200 alone does
not establish data availability. Codes guide investigation; they do not establish
a subscription's terms.

## Development observation on October 26, 2026

A direct read-only probe at 10:33 UTC found a real EURUSD Alpha Vantage quote
observed at 10:33:00 UTC with bid and ask present, before applying this repair.
This is development endpoint evidence, not production or broker validation.

No usable intraday candles were returned: Polygon and Finnhub answered HTTP 403;
Alpha Vantage returned a provider message indicating restricted access/limits.
No raw messages or credential values were recorded. The owner must supply an
existing feed entitlement covering the required instruments and resolution, or
separately approve changes to the provider account. Do not close the provider
operational gate based on a quote alone.

After applying revision `cc0f268d2eee439db382ce5c30b3d4becff82dc2`, the
read-only development diagnostic at 10:56:14 UTC returned a current Alpha Vantage
EURUSD quote observed at 10:56:13 UTC with real bid and ask. It returned zero
intraday candles: Polygon and Finnhub reported HTTP 403, and Alpha Vantage
reported restricted access. The command correctly exited 2 with `ready: false`.
This confirms the quote repair; it does not close the intraday-feed or production
gates. Retain reports with the tested revision and repeat in the intended
environment. Production evidence remains separate.
See [the owner runbook](TIER1_OWNER_RUNBOOK.md).
