# Native consumer checks and overdue account reads — 1 November 2026

Status: development progress, **not release-green**. No default renderer switch,
deployment, main merge, existing-database change, broker test or trading action.

Application commit: `8b65ac6bd3659e17af8df320cc66f0576da34cb7`, based on
`2a901631189c817036ed94d72c3b038a69e2d186`. Subsequent checkpoint changes only
the browser test driver, this documentation and validation artifacts. Product
source tested below is exactly the application commit. Raw receipts:
`/Users/areyouok/arx-tier1-release/native-chart-acceptance-20261101/`.

## Monetary evidence

The owner's requirement is prompt, consistent same-account MT5 monetary reporting,
including external/manual trades and floating P/L. This increment fixes a real
late-response acceptance race in the shared personal/shared account HTTP reader:
an overdue response microtask could run before its delayed timeout callback.
The reader now checks the monotonic deadline after complete body decoding,
rejects expired responses and aborts the retired read. It preserves existing
caller cancellation, errors, failed-cache withholding and the existing 10-second
read budget. No invented amount, account source, freshness or optimistic released
funds is introduced.

Four header/body cases failed before the fix. Sixty focused checks pass, including
actual Cockpit/Analytics query, hint and failed-cache paths. These are included
in the full frontend total, not additional independent tests. Independent source
review found no scoped blocker. This proves the acceptance rule, not MT5 latency.

Still open: terminal timer/capture and pending retry latency, producer clock and
ordering continuity, non-atomic monetary capture, server database waits and
resource cancellation, process-local notifications with 3-second reconciliation
and 5-second client polling fallbacks, remaining monetary consumers, and native
account v1's absent margin-level field. JavaScript cannot process updates while
suspended. Exact instantaneous MT5 equality and measured end-to-end latency
remain unproven; terminal/broker testing was not authorized or performed.

## Native chart corrections

- History reconciliation/context reset no longer publish false user crosshair
  clears into linked charts. Followers do not start independent history loads.
- Full-window refresh/prepend preserves the inspected timestamp and canonical
  values; removed timestamps withdraw rather than moving to a neighboring bar.
- PNG export requires completed current paint evidence. Reentrant context,
  range or style changes cannot export superseded pixels.
- Main and replay credit the actual adapter. Native replay no longer claims to
  use Lightweight Charts; genuine Lightweight Charts credit remains intact.

Focused failing-before cases and independent reviews are retained. Uniform
prepend/trim history anchoring is covered; arbitrary interior insertion behavior
is not newly established. Native is still an explicitly selected adapter; the
production default remains Lightweight Charts.

## Exact validation

| Check | Result |
| --- | --- |
| Full frontend | 4,462 pass, 12 skipped, 0 fail; 255 files pass, 2 skipped |
| Dashboard typecheck / production build | Pass / pass; bundle-size warnings retained |
| Guards | 85/87; same 38 wording and 3 internal-name findings as prior checkpoint, after source-line/count normalization |
| Independent credit + offline-route checks | 25 component and 13 tooling checks pass |
| Actual-app native QA build | `799e85a0c40d3328`, clean `8b65ac6b`, minified, immutable asset hashes, QA-only native default override |
| Browser scenarios | 21 assertions pass; no page exceptions or external feed/broker requests |
| Root/backend/database lanes | Not run; no backend change in this increment |
| Physical-display or broker/competitor latency | Not measured |

Browser checks cover M15 primary/M5 comparison independence, primary adapter
retention, source-coordinate linking within loaded history, real pointer
crosshair linking, separate native replay, exact canonical prefixes at 100, 200,
12 and 13 bars, HA canonical preservation, PNG download, and a fresh current-data
request on exit. They wait for completed renderer evidence rather than treating
an applied React event as a completed paint. They are not full multi-chart,
all-route, mobile/touch, deep-history, study or drawing acceptance.

The replay fixture uses synthetic demo-shaped closed-candle contract rows and a
synthetic source identity inside the existing offline interception boundary.
Its feed verdict remains invalid/offline, with a visible synthetic-data banner.
This is **not a demo broker run**. All writes, unknown APIs and external feeds
remain blocked. The setup, raw logs, expected data and PNGs are archived.

Initial driver failures are retained: the Scanner panel selector also matched
the comparison pane; two pointer attempts targeted a candle behind the sticky
header (one edit attempt used the wrong working directory). Narrowing to the
primary card and choosing a visible plot coordinate fixed the harness. No
product fix or speed claim is attributed to these harness corrections.

## Visual blocker and competitor gaps

Visual inspection of both linked views and the exported PNG found a remaining
truth defect: the axis prints `UTC` while the shell/export caption states that
the source clock's UTC mapping is unverified. The shell currently forwards only
the display zone and loses the original clock qualification at the native
adapter boundary. This blocks default-native activation. Next: propagate the
existing qualification with default/reset false and preserve source-clock
wording on compact axes and exports. Do not infer authority from epoch-shaped
numbers or a saved zone preference.

PositionMiniChart still directly constructs Lightweight Charts and recreates
its chart on prop changes; its entry marker also lacks an actual entry-time
input. It requires a separate shared-adapter migration and acceptance. No
all-native migration claim is made.

TradingView documents linked symbol, interval, crosshair, time and date-range
controls, plus synchronized multi-chart replay. ARX's current replay is one
loaded window; synchronized replay, cloud layouts, deeper replay history and
other existing platform gaps remain open. Sources:
[layout synchronization](https://www.tradingview.com/support/solutions/43000629992-how-to-sync-the-charts-of-my-layout/),
[synchronized replay](https://www.tradingview.com/blog/en/synchronized-bar-replay-45933/).
MT5 documents chart navigation and save-as-picture workflows; ARX's offline
navigation/export checks do not establish matching platform performance.
[MT5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage).

No new timing experiment ran in this increment. Earlier slow-device first-click,
initial-study/full-history work, O(n) reference copies and full-range volume
profile calculation remain open. No superiority, parity, return, financial
accuracy guarantee or architecture completion percentage is asserted.

## Checkpoint and next steps

Private branch: `codex/native-chart-acceptance-20261101`. Compressed raw receipts
and SHA-256 manifest are in `docs/validation/native-chart-acceptance-20261101/`.
Owned browser and local fixture server are closed (intentional SIGINT exit 130);
validation jobs are terminal and reviewers finished.

Continue from this combined source, preserve the original owner brief and earlier
work. First fix native clock authority, then complete position mini-chart and
all-consumer/touch/export/history acceptance before considering a default switch.
For money, bound server waits with real cancellation and cross-process delivery,
audit remaining consumers, and preserve stale/unknown states. Any actual terminal
or broker latency validation still needs separate authorization. The earlier
anime.nexus playback/usability request was not covered by this increment.
