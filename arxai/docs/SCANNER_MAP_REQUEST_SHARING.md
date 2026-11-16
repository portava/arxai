# Opportunity Map request sharing

Date: 2026-10-26. Stacked on scanner closed-window freshness PR #83 (`eecc4f71`). Backend-only change to the Opportunity Map read cache and its HTTP timeframe validation.

## Behavior

Previously the cache treated `M5` and `5m` as different keys, even though the scanner analyzed the same timeframe. Its 10-second result TTL also expired pending computations, so a request arriving during a slow scan could start another scan for the same key. Eviction of a pending result could have the same effect.

The map now canonicalizes supported timeframes before scheduling work and returns the canonical code. Unsupported HTTP timeframes return 400 before scanning. Its existing six public market groups and sign-in requirement remain unchanged; the internal `full` universe is not added to the public route. Internal cache callers must also supply a supported universe and timeframe, keeping the pending-key space finite (7 internal universes × 21 timeframes).

A map-specific pending registry shares the existing computation until it settles, independently of the result-cache TTL and eviction. Success and rejection both remove the pending entry; failures can retry. The generic short-TTL cache, router, selected-market service and provider concurrency budget are unchanged. Different selected symbols still compose their own comparison cheaply from the same core.

The original `generatedAt` is retained. The existing result TTL is anchored to read start, not completion: a build finishing after that TTL does not gain another fresh window. An old result may therefore arrive already limited by the UI's existing age gates. No timestamp is reset to make it actionable.

## Offline evidence

The scanner quality suite passes 57 tests, including 10 new map-cache and HTTP cases. These cover a pending build beyond 10 seconds, rejection and retry, equivalent aliases, invalid requests with zero core reads, selected-symbol recomposition, original age/TTL, pending work surviving resolved-cache eviction, the public group boundary and authentication.

A separate constructed latency probe runs the actual Opportunity Map orchestration and cache, with a 20 ms delay for each candle/quote read. Scan mathematics, history and news are replaced with fixtures; all 43 internal-full-universe rows are directional by construction. This is not an HTTP/browser or real-provider benchmark. Its before/after call counts are:

| Scenario | Before scans | After scans | Before candle + quote reads | After candle + quote reads |
| --- | ---: | ---: | ---: | ---: |
| Three identical cold readers, different selected symbols | 43 | 43 | 86 + 86 | 86 + 86 |
| One cached reader | 0 | 0 | 0 + 0 | 0 + 0 |
| Two equivalent timeframe requests (`M5`, `5m`) | 86 | 43 | 172 + 172 | 86 + 86 |

Peak concurrent fixture I/O remains 8. One recorded before/after alias run took 925.52/462.32 ms; the counts establish reduced duplicate work, while these individual wall times are illustrative and are not production latency percentiles. Cached-read responses keep the original scan timestamp. A virtual-clock test independently proves that a same-key request after 10,001 ms joins the pending build instead of creating a second one.

Validation logs, probe source, before/after observations and the final commit are retained in `/Users/areyouok/arx-tier1-release/scanner-map-request-sharing-20261026/receipt.json`.

## Remaining latency and timeout limits

This change does not promise a deadline. Assistant HTTP reads use a real 5-second abort in `assistant/marketHttp.ts`; Deriv WebSocket requests have an 8-second request timeout in `data/providers/derivWsClient.ts`, with connection setup potentially adding time. Provider chains and enrichment stages can add those waits together. The shared PostgreSQL pool in `lib/db/src/index.ts` sets no explicit application connection or query timeout; external database settings are not verified here.

Pending **keys** are bounded by canonical identity. A never-settling database/provider read can still pin a key and a scanner permit, and HTTP callers awaiting that promise are not admission-limited here. The process-wide scanner FIFO queue also has no cancellation contract. Browser cancellation alone does not cancel the underlying work. A future deadline/cancellation change needs to remove canceled queued work and retain active permits until the real operation stops; racing a promise and releasing a permit early would hide excess provider work. No such race, global timeout or admission policy is introduced here.

The scan and lateness stages still re-read candles/quotes and check private source identity. Removing those reads needs a separately reviewed, provenance-preserving snapshot contract. No source or freshness gate is removed to obtain the count reduction above. No live/DEMO provider, broker action, database mutation, deployment or merge was performed.
