# Smart Chart workspace acceptance — 31 October 2026

Development-only acceptance on exact source `1e879563dd5f075c0dd87cd2924b4585f5ed7149`
(application source `1a4fa6d7286d25a84d14e365ca9ebb420cb0d76a`).
Immutable production fixture `44105c354d0bb578` was built with a clean, unchanged
source tree. PR103 remains a draft stacked on `claude/pr99-round3`; no main merge
or deployment. This is not release-green, architecture completion or competitor parity.

## Completed evidence

| Check | Date UTC | Result |
|---|---|---|
| Full frontend | 28 October |167 files;2,407 passed,9 skipped,0 failed |
| Dashboard typecheck and production build |28 October |Pass; bundle warnings retained |
| Guards and bridge binding assertions |28 October |87/87 guards and7 binding assertions pass |
| Named templates on actual Scanner |28 October |30/30 browser assertions pass |
| Manual text notes on actual Scanner |28 October |46/46 browser assertions pass |
| Standard Scanner regression |31 October |43/43 browser assertions pass |

The browser total is119 assertions across three separate fresh synthetic USER
sessions, not one end-to-end run. They all execute the same immutable source and
build. The full pipeline ran before the interruption; its logs were verified on
31 October, not rerun or relabelled with that date. No application changes were
made after these results. Earlier69 tooling checks on the identical application
and test source remain separate evidence.

Templates checks include actual plotted SMA values, settings-only export/import,
no application on import, native Web Lock refusal/retry, modal Escape layering,
mobile bounds/focus and preserving entered text while a deliberately delayed M5
candle response binds to the chart. Desktop/mobile screenshots were inspected.

Notes checks include real primitive attachment, exact anchored text, editing,
undo/redo, locking, movement, hide/show, pan/zoom, symbol/interval remount
persistence, deletion and a captured PNG. Desktop/mobile images and the actual
export were inspected: the **Your note** heading and text are visible, with the
persistent warning above the canvas. The mobile editor screenshot is a scrolled
editor view, not evidence that the entire chart fits on screen simultaneously.
The separate mobile-note screenshot shows the complete note card. Export labels
its source as synthetic and not live-confirmed.

Standard Scanner checks cover exact response-to-rendered OHLC, source identity,
interval/symbol changes, styles, navigation, mobile disclosure and absence of
graphic TradingView logos/embeds. Desktop/mobile images were inspected. The
mobile screenshot has the chart continuing below the fold; no full-viewport
chart or touch-device claim follows. Plain-text rendering-library credit remains.

## Barriers and retained failures

All API mutations returned503. No trading, external/WebSocket requests,
unclassified writes or page exceptions were accepted. Unknown reads deliberately
returned503 and remain visible in the logs: templates52 console errors/48 unknown
reads; notes77/68; Scanner63/57. These are offline fixture limits, not a claim that
the connected application has an error-free console. AI truth remains unavailable.
The note observer was restored after its run. Owned browser sessions and the
local static preview are closed/stopped.

Earlier template attempts with8/24/24/26 assertions remain failed/incomplete.
The earlier44-assertion note run remains **VISUALLY INCOMPLETE** because its
warning obscured the heading. These new source-bound results validate the fixes;
they do not rewrite the earlier results or remove their evidence.

Raw logs, JSON, wrappers, screenshots and exported PNG are archived in
`validation/scanner-smart-chart-20261031/workspace-tools/`. The manifest records
original file sizes and SHA-256 hashes; non-image files use gzip. Local originals:
`/Users/areyouok/arx-tier1-release/chart-workspace-tools-final-20261028/`.

## Remaining work

- Browser/process restart recovery, touch devices and broader browser coverage.
- Attested active-reader and owned-position/mini-preview browser acceptance.
- Calendar W1/MN1 boundaries and existing preserved calendar WIP.
- Heavy streaming/history, current-catalogue replay and measured style switching.
- Named multi-chart/cloud workspaces, channels and broader drawing/study coverage.
- Matched TradingView/MT5 workloads before any parity or speed-superiority claim.

The native style-input timing failure still has0/80 completed samples. Replay
and heavy-load misses remain in the comparison document. This acceptance adds no
new latency, physical-paint,60fps, broker or profitability evidence.

## Full document-reload follow-up — 31 October

No application code changed. The offline fixture gained an explicit
`SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD=true` option. It clears storage on the
first document only, then performs no storage writes on subsequent documents.
Default scenarios still clear on each navigation. Three regression tests cover
both modes and missing/invalid initialization markers. The two acceptance
scripts opt into their extra steps with `SCANNER_QA_RELOAD=true`; they refuse to
claim reload acceptance with the default clearing fixture. Neither script seeds
a note or template, forces primitive geometry or substitutes mock study values.

- Notes:58 assertions pass at `ca36fcc4866b9a570027281fde1150b7cd8d4acd`,
  clean build `dac533a3d0ee6846`. A UI-created/edited note retains its complete
  serialized data, ID, literal text and candle/price anchor through `page.reload`.
  A changed document time origin proves a new document; fresh intercepted
  candles are checked against actual canonical/displayed data. The current
  primitive paints and projects the restored note after a real zoom action;
  Objects retains full text, Undo starts empty, and unavailable truth stays held.
  The screenshots and real exported PNG were inspected, including the complete
  mobile note after reload. This does not prove first-paint timing.
- Templates:38 assertions pass at `406524dfae19fa69ebc0b656500618adb57204fc`,
  clean build `b1b840426c829496`. The complete saved library survives byte-for-byte.
  The visible original record is selected after reload and applied over a
  deliberately different candles/indexed chart. Actual source-bound bars,
  formula-correct SMA10 and logarithmic scale verify restoration. Desktop,
  mobile and reopened-library images were inspected.
- Tooling:72 tests pass at `406524df`. The previous full frontend/build/guards
  result remains tied to1e879563; no repeated full application suite was needed
  for these test-only changes.

The first template attempt at `f8fb28c0`, build `a28c03c891e79fd3`, failed after34
assertions: the new helper read `priceScale.mode` instead of the observer's
existing `scale.mode`. Corrected in406524df. That failure, image and logs remain
retained. The two successful runs are separate sources with identical application
code; they are not reported as one combined run or additional unique features.

The first two fresh-build attempts failed on missing local native dependencies
(Rollup, then Lightning CSS). The successful build used existing matching local
Rollup4.59.0, Lightning CSS1.31.1, Tailwind oxide4.2.1 and esbuild0.27.3 native
files from `/Users/areyouok/arxai/node_modules` through process-local search paths
and a local package-main shim; no source or dependencies in that checkout were
modified. The prior temporary esbuild location was not relied on. Failed build
logs are retained; fixture asset hashes identify what actually ran.

All mutations remain503; no trade/unclassified write, external/WebSocket
requests or page exceptions occurred. Expected fixture console/unknown-read
counts: notes104/101; successful templates89/82; failed templates77/70. Test
browsers and owned static servers are stopped. Raw evidence and SHA-256 manifest:
`validation/scanner-smart-chart-20261031/reload/`.

This verifies a full document reload in the tested Chromium session. It does not
establish cross-device/account storage, browser/process restart, touch behavior,
latency or competitor parity. Those gaps and the original performance failures
remain open.

## Browser-emulated touch follow-up — 31 October

Source `0af7ebd72a88c6702ab41a6729363e8bff770f33`, immutable clean production
fixture `17c30394fc267357`:55 assertions pass on the actual Scanner with a390x844
CSS viewport, coarse primary pointer and `navigator.maxTouchPoints=1` in the
CLI's mobile Chromium context. This is browser emulation, not a physical phone.
Application code is unchanged;75 tooling checks pass on this test-only source.

Note placement uses the browser touchscreen API. Card moves use CDP touch input
through the browser's real event pipeline, not DOM event dispatch. The observer
records trusted `pointerType=touch` at the chart. Checks cover placement at a real
loaded candle/price, movement, lock refusal, exactly one completed-drag undo/redo,
actual changed preview before cancellation, no persisted partial movement and
rollback of that preview after `touchCancel`. Control selection/editor filling,
zoom/pan buttons and menu actions remain programmatic/mouse; this is not an
all-touch journey, multi-touch pinch, keyboard, iOS or physical-input latency test.

Source-bound OHLC, current drawing attachment/projection, warning clearance,
long-text bounds, mobile editing, symbol/interval persistence and PNG export
also pass. Three screenshots and the captured PNG were visually inspected. The
editor view is scrolled and does not promise the full chart fits alongside it;
the separate note view shows the complete card. Export retains the synthetic,
not-live-confirmed source label.

Initial source `0da8e7ba`, build `3b0a0987c74ae1c6`, failed after36 assertions at
the later pan-projection expectation. Touch placement/move/lock/cancel had passed,
but panning earlier moved the anchor to x246.3344 on a228px pane. A read-only
primitive observation confirmed saved geometry remained and the off-screen card
was correctly absent. The helper now requires matching rendered geometry for an
on-screen anchor or absence of the card for a finite out-of-bounds anchor. Its
adversarial test rejects missing visible notes, stale coordinates, clamped
out-of-bounds cards, missing/NaN projections and invalid pane dimensions.
The failed run and diagnostic remain retained; it is not relabelled as a pass.

All mutations503; zero trade/unclassified/external/WebSocket requests and page
exceptions. Expected HTTP console/unknown-read counts: initial54/51, final82/73.
Observers, owned browsers and static servers were cleaned up. Evidence:
`validation/scanner-smart-chart-20261031/touch/`, with original sizes and hashes.

Physical-device and broader gesture coverage remain open, as do active-reader,
heavy-workload, calendar and equal-condition competitor gaps. No new performance
or parity result follows from these functional touch checks.
