# Chart clock authority and position display — 1 November 2026

Development progress; **not release-green**. Application source:
`1ca810309b7a2910d34a278df2d6485933c1516b`, based on `3368c8f1`.
The following checkpoint changes only acceptance-driver expectations,
documentation and receipts. It does not change the tested application code.
No default-renderer switch, deployment, main merge, existing-database operation,
worker activation, order, email or broker/terminal test was performed.

## Changes and independent review

The shared chart interface now carries original source-clock qualification,
defaulting and resetting to false. Main-chart initialization and subsequent
updates propagate the existing qualification independently of the preferred
display timezone. Loaded history without that authority and replay snapshots
without preserved authority remain unqualified. Both native and Lightweight
Charts renderers retain source-clock wording, including compact axes. A saved
timezone or epoch-shaped number cannot establish original UTC authority.
Native PNG output uses the same qualified/unqualified pixels. Native explicit
height is also retained through later observer, window and screen-density changes.

PositionMiniChart now uses the existing shared adapter, retaining it through
supplied price and candle updates. Entry, stop and target reference lines remain;
the invented entry-time marker is removed because no entry timestamp is supplied.
The current-price line requires the existing live verdict and disappears when
that verdict is withdrawn. The preview is inert and cannot intercept chart
gestures. Empty data disposes the renderer; restored data creates a fresh one.

The parent position card binds candles and status to their requested symbol,
withholding old-symbol content immediately on a symbol change and ignoring late
retired requests. It accepts the endpoint's actual ISO `openTime`, validates
calendar values and OHLC numbers, and rejects contradictory symbol/interval
metadata. It does not guess timestamp units or fabricate the current time.
This is not full account-era/provider attestation of all position data.

Independent source reviews and failed-before reproductions are retained. The
focused sets overlap the full frontend run and must not be summed with it.
The DB-bearing `qaPositionMiniChart` script's assertions were updated, but that
script was not executed; no database acceptance is claimed.

## Exact validation

| Check | Result on application commit above |
| --- | --- |
| Full frontend | 4,512 pass, 12 skip, 0 fail; 257 files pass, 2 skip |
| Dashboard typecheck / production build | Pass / pass; existing bundle-size warnings retained |
| Guards | 85/87; same 38 wording and 3 internal-name findings as the previous checkpoint after line/count normalization |
| Native clock/height focused set | 128 pass |
| Main/replay/adapter clock focused set | 152 pass |
| Lightweight Charts focused set | 139 pass |
| Position parent/mini/guards focused set | 50 pass; 32 parent/mini independently rerun |
| Offline route tooling | 13 pass |
| Actual-app production QA build | `f4c99b711d36f38a`; clean exact source; immutable executed entry identity checked |
| Browser acceptance | 26 assertions pass; no page exceptions or external feed/broker requests |
| Root/backend/database lanes | Not run; no backend change in this increment |

The browser uses a QA-only native-default override and intercepted synthetic
candle contracts, never a broker feed. A synthetic original-UTC contract is
withdrawn during the run: the adapter and canonical OHLC stay unchanged while
actual painted labels revert to source-clock wording. Desktop, 390px mobile and
PNG checks cover this transition. The isolated real PositionMiniChart route
checks retained updates, stale-current-line removal, symbol reset, inert wheel
behavior and empty/restore lifecycle. Its white fixture page does not reproduce
the full app theme or account-page parent integration.

Two failed browser runs are retained: the driver searched for a desktop-hidden
compact Tools button, then expected `GMT-5` where the browser correctly painted
`EST`. The corrected driver handles visibility and both timezone spellings.
These were harness corrections, not product fixes. Console errors from blocked
unknown fixture APIs remain in raw logs; zero page exceptions does not mean
all app endpoints succeeded.

## Scoped timing, not broker latency

Actual native position component, 80 synthetic bars, 390×844 browser viewport.
Each group retains five warmups and all 60 measured updates. Time starts at a
programmatic DOM click and ends at a subsequent animation-frame observation of
the expected canonical close and a new completed renderer paint. Early click
acknowledgement is recorded separately. This does not measure physical scanout.

| Quiet run / CPU multiplier | p95 completed update | Maximum | Failed samples |
| --- | --- | --- | --- |
| 1 / 1× | 66.9 ms | 67.6 ms | 0 |
| 1 / 4× | 67.1 ms | 68.0 ms | 0 |
| 3 / 4× | 66.8 ms | 67.1 ms | 0 |
| 3 / 1× | 67.0 ms | 67.8 ms | 0 |

Run 2 overlapped a broad read-only file inventory. It is retained as non-quiet
evidence (p95 66.1/66.9 ms; maxima 66.9/67.1 ms), not substituted for quiet
acceptance. No samples, warmups, failures or outliers were discarded. All groups
met this fixture's 100 ms p95 target. This is not a before/after comparison,
competitor benchmark, physical slow device, Scanner first-navigation measurement,
MT5 delivery measurement or proof that every app interaction is instantaneous.

## Remaining truth, money and competitive gaps

The global `LIVE · Shared MT5` account-mode badge remains visible in the offline
Scanner screenshot despite historical-only chart data. Its semantics require
separate review; the chart-specific checks do not establish whole-page truth.

The owner's same-account monetary requirement remains active: preserve MT5's
confirmed native balance, equity, margin and floating P/L, including external
manual trades; never substitute another account, estimated profit or optimistic
released funds. Earlier canonical Cockpit/Analytics/personal-report and response
deadline fixes are inherited unchanged. This increment adds position display
correctness, **not** proof of real-time monetary equality. Terminal capture/retry
latency, producer clock/ordering/atomicity, process-local notifications, polling
fallbacks, remaining consumers, missing native margin-level coverage and measured
end-to-end terminal-to-screen latency remain open. Suspended clients cannot
render immediately. No authorized broker test was performed.

TradingView distinguishes chart display timezone from exchange timezone, and
MetaQuotes distinguishes local, quote/server and estimated server clocks.
Accordingly ARX requires original authority before conversion; this design
decision does not establish platform parity.
[TradingView time concepts](https://www.tradingview.com/pine-script-docs/concepts/time/),
[MetaQuotes local and server time](https://www.mql5.com/en/book/common/timing/timing_local_server).

Lightweight Charts remains the default with its genuine attribution. Native
all-route acceptance, synchronized multi-chart replay, deep replay, cloud
layouts, remaining chart types/tools and slow-device Scanner first-click gaps
remain open. The isolated native component and source-clock tests do not justify
removing the current default or declaring architecture completion.

## Receipts and next steps

Raw: `/Users/areyouok/arx-tier1-release/native-clock-and-position-20261101/`.
Portable archive and per-file SHA-256 manifest:
`docs/validation/native-clock-and-position-20261101/`.
All owned browser/server/test jobs were closed or completed; intentional local
server shutdown returned 130. No background validation is left pending.

Next: preserve this source and failures; address account-mode/live wording and
the remaining MT5 monetary delivery chain, then continue native consumer,
mobile, replay and actual Scanner performance acceptance. Use the original
owner brief and progress index; do not restart or report a completion percentage.
