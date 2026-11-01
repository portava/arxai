# Shared chart-read request ordering — 1 November 2026

Application commit: `5eee59fc4f410e692381a8a6b22729988dba548c`. Development only; **not deployed or release-green**.

The prior implementation shared a chart assessment between panels but kept requests, loading and errors local. Three actual React regressions reproduced before the fix: the previous direction remained visible during refresh, another panel could submit the same market while it was loading, and changing markets carried the previous request's loading/error state into the new market.

## Changes

- The existing page store now owns loading, failure and completion for each symbol/timeframe. Pending and failed requests replace the old read with an explicit restriction; they do not return to a pre-read capability that could upgrade the header. Both existing panels and the header consume the same result.
- Synchronous request tickets prevent an older success or failure from overwriting newer work. Explicit clear, supersession and provider unmount invalidate outstanding work. Symbol/timeframe keys remain independent; JSON tuple keys avoid separator collisions.
- A 30-second **transport timeout** aborts the fetch, settles even an abort-ignoring loader, preserves the restriction and permits retry. Late completions cannot overwrite the retry. Timers/listeners are cleaned up. Browser event-loop suspension can delay the timeout callback; this is neither a strict wall-clock deadline nor a market-evidence expiry policy.
- The existing endpoint display payload is validated before publication: empty objects, malformed gates/consumed fields and contradictory read-layer flags cannot restore an unrestricted read. Actual FULL, STRUCTURAL_ONLY and older market-resolution refusal shapes were checked against server construction. Unknown supplemental fields do not grant authority.
- The existing root-CI Scanner truth lane includes both new regression files. Previous render tests now seed the real provider rather than bypassing its lifecycle with a mock.

## Validation

Full frontend: **3,811 pass, 0 fail, 11 skipped** (226 files pass, 1 skipped). Targeted Scanner/header/store checks: **66 pass**. Dashboard typecheck and production build pass. The full frontend run started before committing; `tested-source.json` verifies identical hashes of all seven changed files at the application commit. Final typecheck/build ran on that clean commit.

Architecture guards: **85/87**. The two existing failures remain: risky wording (38 findings) and internal UI names (3). Failure/header lines match `8747c8d8`; only the scanned product-file count changed, from 2711 to 2712. No waiver was added.

Independent review found two additional gaps (malformed objects and hung-request lockout); both were fixed and re-reviewed. Tests include superseded success/failure, same-batch ordering, explicit clear, independent keys, timeout/retry/late response, provider unmount, synchronous errors, and malformed response shapes. The initial three failing regressions and review findings remain in the archive. Independent reviewer inspected code/tests but did not separately rerun them.

Receipts: [manifest](validation/chart-read-request-order-20261101/manifest.json) and [archive](validation/chart-read-request-order-20261101/receipts.tar.gz). Archive SHA-256: `ebddd4af8f6c8a72a05851b8150b0c97b029b62244d4b48cfa71a463fd02dee2`.

## Remaining work

The cache is still keyed by symbol/timeframe, not a server-verified account, source, candle window or observation identity. Response symbol/timeframe echo verification and evidence-age expiry are not implemented by this change. Different drafts share a key; plan-specific assessment binding also remains open. A structurally valid response is not proof that the market facts are correct. All of these must be resolved before claiming comprehensive chart/Truth agreement.

No actual-browser acceptance or latency measurement ran in this slice. React DOM tests establish these state transitions, not physical input/paint or TradingView/MT5 parity. Earlier slower-device failures, broader feature gaps and the original owner requirements remain open. No broker/model/provider calls, orders, existing-database changes, workers, main merge, Replit edits/restart or deployment occurred.
