# Scanner read admission and overload recovery

The four expensive scanner HTTP reads now share a process-local admission limit: 32 active handlers in total and eight per resolved viewer. There is no waiting queue. A request arriving at capacity receives HTTP 503 with `SCANNER_BUSY`, a one-second retry hint and `Cache-Control: no-store`. It does not consume the manual-scan database cooldown, start provider work, read the result cache or invent a completed scan.

Protected routes keep their authentication gate before admission. The existing opportunities read retains its access policy; requests without a resolved session share one anonymous bucket. Client headers, parameters and arbitrary tokens cannot create viewer identities. These limits are conservative initial bounds, not measured production capacity, a distributed quota or a claim of optimal fairness.

## Ownership and lifetime

`scannerReadAdmission.ts` owns admission counts and the wrapper. The wrapper covers GET `/market-scanner/opportunities`, POST `/market-scanner/scan`, GET `/market-scanner/selected-market` and GET `/me/opportunity-map`. Every admitted handler releases in `finally`, including synchronous errors, rejected promises and early validation responses.

The permit remains owned until the handler actually settles. Client cancellation, response closure and an already written response do not release unfinished provider work. Existing identical-request coalescing, source timestamps, cache keys, freshness checks and the shared eight-operation provider budget are unchanged. There is no timeout that pretends underlying I/O stopped. The page reports a busy manual scan in plain English and offers the short retry without applying a result or the successful-scan seven-second cooldown.

A stalled dependency can still occupy a permit until it settles. Background callers, existing fire-and-forget governance writes, transport buffers, other APIs and multiple application instances are outside this HTTP bound. The existing provider budget still constrains scanner leaf I/O. Provider-aware cancellation, request deadlines and multi-instance capacity control remain separate work.

## Acceptance and comparison

- At most 32 admitted HTTP handlers and eight per viewer; no stored waiters or unbounded anonymous keys.
- Excess work receives an explicit failure without fresh result metadata. Authentication and cooldown behavior remain intact.
- A disconnected request retains capacity through actual work settlement; success, failure and recovery do not leak permits.
- Accepted work retains the original response and timestamps. Refusal is not counted as faster successful scanning.
- Compare completion distributions for the same accepted synthetic work before and after admission, reporting conventional median, p95 and p99, all measured samples and a separate stalled-work overload experiment.

[TradingView's screener workflow](https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/) and [Pine Screener](https://www.tradingview.com/support/solutions/43000742436-tradingview-pine-screener-key-features-and-requirements/) provide the discovery, refresh and custom-screen capability references. [MT5 Market Watch](https://www.metatrader5.com/en/terminal/help/trading/market_watch) documents quote/source/time columns and export. These sources do not disclose comparable server admission capacity or latency, so no speed or reliability advantage over either product is claimed.

The load-control approach follows [Google SRE's overload guidance](https://sre.google/sre-book/handling-overload/): bound resource use and report resource errors transparently. HTTP 503 and its retry hint follow [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable). This is an engineering comparison, not a claim that those services use ARX's limits.

## Offline verification

The existing scanner quality suite includes admission unit tests and real router checks for all four reads. An actual held HTTP scan is aborted by its client; a second read remains refused until the held scan's work settles. Existing source, freshness, request sharing, ranking and access regressions remain enabled. No market provider, broker, live or DEMO execution is involved.

The opt-in `scannerReadAdmission.benchmark.ts` uses a loopback-only Express server and identical synthetic two-millisecond awaited work. It alternates 24 pairs of eight accepted requests, retaining 192 measured completions per version. A separate 128-request stalled-work experiment compares admitted and refused counts, then verifies recovery. It measures local HTTP completion and capacity behavior, not browser display, real scanning throughput, production load or competitor latency.

Exact source hashes, commands, outcomes and raw timing samples are kept in `/Users/areyouok/arx-tier1-release/scanner-read-admission-20261026/receipt.json`. Passing this slice does not complete the scanner's broader coverage, scriptable filters, alerting, provider health or comparative performance requirements.
