# Smart Chart early explanation clicks — 1 November 2026

**Validated offline for this bounded change. ARX remains not release-green; Replit is unchanged.**

Application commit: `3a4407185e35f5bfe5ecff5c5d5b885f4d4276ad`. Base: `0deaebec1ae9f42abe650d8e3b49843f379f1a38`.

## Problem and behavior

The previous actual-Scanner browser run reproduced an early **Explain this finding** click returning unavailable before the existing lazy assistant mounted. The chart now acknowledges that click immediately and retains one exact local answer for up to ten seconds. When the assistant registers, it verifies the same selected pane and unchanged evidence before delivering once. A newer click replaces the pending request. Pane/source changes, removal, changed evidence or expiry prevent old-answer delivery. Failure stays visible; it does not fall back to a remote model or another chart.

Independent review found that a timeout callback alone could be delayed by a busy browser. The final implementation checks elapsed monotonic time before rereading and immediately before delivery as well. A regression failed before that correction and passes afterward. No second assistant or detector was introduced. Manual/protective trading gates and AI entry policy are unchanged.

## Verification tied to this source

| Check | Result |
| --- | --- |
| Full dashboard suite on application commit | 3,590 passed, 0 failed, 11 skipped; 217 files passed, 1 skipped |
| Pane lifecycle suite | 16 passed, included in full total; late mount, source/pane change, changed reading, removal, expiry, delayed timer, latest click, StrictMode and receiver re-registration |
| Dashboard typecheck | Passed immediately before commit; same four-file application/test content |
| Production dashboard build | Passed on application commit; sourcemap diagnostics and large-chunk warnings retained |
| Guards | 85/87; exact same failure blocks as previous receipt: 38 wording matches and 3 internal-name/display matches |
| Actual Scanner browser | Delivery 5/5; cancellation 4/4; fixture `dc51b70d2e95b0f7`, built from clean application commit |
| Independent source review | Deadline finding fixed; no additional concrete blocker found; reviewer did not run browser/performance checks |

The assistant chunk was deliberately held before the first click, then released. One click delivered the exact selected EURUSD M15 finding and cleared pending feedback. Switching through the actual M30 toolbar control before releasing the chunk prevented the old answer from opening. The first cancellation harness timed out because it waited for nonexistent observer field `timeframe`; source inspection showed the actual field is `intervalSeconds`. The corrected harness requires `1800`. Both scripts, the failed run/screenshot and the passing rerun are retained.

All API responses were generated and intercepted; external requests and WebSockets were blocked. Incidental startup mutations received an intercepted 503. No real provider, model, account API or broker was contacted. The fixture uses the actual dashboard entry and components with an isolated build configuration and observer; it is not the deployable bundle. The two scenario samples of cold feedback are diagnostics, not a cold-load p95 result.

## Local interaction measurement

Chromium `156.0.8078.79` on this Mac, 24 measured clicks plus three warmups per condition. Click capture to answer DOM and two animation frames; all 96 answers matched the selected finding and symbol/timeframe. Task tests/builds were finished before measurement. Unrelated machine workloads were not controlled.

| Width / CPU throttle | Two-frame median | p95 | p99 / maximum |
| --- | ---: | ---: | ---: |
| 1440 px / 1× | 29.1 ms | 30.0 ms | 30.1 ms |
| 1440 px / 4× | 58.8 ms | 70.7 ms | 76.4 ms |
| 390 px / 1× | 30.5 ms | 31.8 ms | 31.8 ms |
| 390 px / 4× | 26.9 ms | 27.8 ms | 28.0 ms |

These warm local clicks meet the existing p95 <100 ms target in this environment. The prior finding-label round recorded p95 29.3/81.2/31.5/28.8 ms for the same four conditions; those are historical observations, not a counterbalanced comparison or speed-win proof. The smaller phone conversation view and frame phase affect timing. This does not establish first-navigation speed, remote AI latency, hardware paint, sustained 60 fps, or competitor performance. The first-click cold behavior is functionally verified, but repeated cold-load distribution and prolonged stalled-chunk browser testing remain gaps.

## Competitive context and remaining gaps

TradingView documents [automatic candlestick labels with hover information and alerts](https://www.tradingview.com/support/solutions/43000584462-automatic-candlestick-pattern-detection/). MT5 documents [analytical objects and descriptions/properties](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects). Reliable access to an explanation is a usability requirement for ARX's selected-finding workflow. This change closes its reproduced early-click failure; it does not establish equivalent vendor AI capabilities or vendor timing. Hover explanations, equivalent pattern alerts, detector accuracy/catalogue completeness, broad object-tool coverage, provider-authenticated freshness and real-preview latency still need evidence. Other unresolved gaps remain in the owner brief and earlier reports.

No main merge, Replit source edit/restart, deployment, existing database change, worker/trading enablement, email or live/demo broker test occurred. The architecture objective remains active.

## Receipts and reproduction

Portable evidence is in `docs/validation/chart-assistant-cold-click-20261101/`. The archive retains raw test logs, first failures, reviewer receipt, browser scripts/screenshots, generated responses, all samples/warmups and immutable fixture metadata. Every archived member was verified against `raw-manifest.json`; `archive.json` records the archive checksum.

Build the existing shared-chart fixture on the application commit, serve its immutable build locally and run the archived `browser-deliver.js` and `browser-cancel-witness-fix.js` in separate fresh browser sessions. All routes must stay intercepted. Run `local-click-timing.js` on the delivered session after tests/builds finish. Local dependency tooling was `/tmp/arx-offline-run.py`; no packages were installed or dependency sources edited. Dedicated browser sessions and fixture server were closed afterward; port 4199 had no listener.
