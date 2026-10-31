# Focused chart drawing shortcuts — 31 October 2026

Status: locally accepted, awaiting selective development import. First-navigation speed, TradingView/MT5 parity and launch readiness remain open. No deployment or broker testing.

## Exact source and behavior

Application **6537d90d898898b97e6aadc2f26e67fde2b2a57b**, branch `codex/chart-drawing-shortcuts-20261031`, based on accepted **14077859889fe58cfbf87103a86e5cd8411e9ce3**. Initial implementation **1b6cbb5e87338f1b1cb559478ac4733ee6caa508**; final commit corrects stale drawing status text found during visual review. Final ordinary-runtime immutable fixture **d67f02148600dc4d**; earlier fixture **ebf7b91052550705** remains separately identified.

When the plot has keyboard focus in drawing-selection mode, Delete/Backspace removes its selected unlocked, visible drawing. Ctrl/Cmd+Z undoes a drawing edit; Ctrl/Cmd+Shift+Z redoes it; Ctrl+Y also redoes. A real canvas click explicitly focuses that plot, including when selecting a drawing prevents the browser default. Toolbar controls remain available. Deletion updates the actual primitive immediately and commits through the existing persisted, browser-local history. Undo/redo use that same history. Feedback now describes the actual edit.

Shortcuts do not intercept text fields, other charts, dialogs, composing/repeated/previously-handled events, modified deletion keys, ongoing placement or unfinished drags. Locked/hidden objects are preserved by shortcut deletion; existing explicit toolbar deletion policy is unchanged. Pan-only/global-hidden drawing modes do not expose these shortcuts. Cross-chart local storage synchronization still clears stale history. No market-data, API, order, funds, or safety policy changes.

## Competitor research and explicit differences

MetaTrader documents selected-object deletion and sequential Backspace removal. ARX deliberately uses Backspace for the selected drawing only; it does not delete the latest unselected object. MT5 exposes more object families and broader controls. [MetaTrader analytical objects](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects).

TradingView has selectable locked-drawing removal behavior. ARX shortcut deletion preserves locked drawings; no configurable removal policy is added. Multiselect, groups and reorder remain open. [TradingView locked-drawing removal](https://www.tradingview.com/support/solutions/43000760814-how-to-set-removal-of-locked-drawings/).

The comparison document's stale eight-tool/channel/search rows are reconciled with previously accepted nine-tool, parallel-channel and object-search work; this turn did not implement those again. No equivalent competitor workload was timed.

## Exact final-source validation

- Frontend: **2,635 pass, 0 fail, 11 skip** across 179 passing files and one skipped file.
- Dashboard typecheck and production build pass. Existing large-chunk warning retained.
- **87/87 guards and 7/7 bridge-binding assertions pass**.
- Actual offline Scanner: **28/28 assertions** at 1440×1100 and 390×844; trusted browser keyboard/pointer input, selected deletion, undo/redo variants, editable-field protection, lock protection, current feedback, unchanged engine identity and full canonical/display data, no overflow or page exceptions. Screenshots inspected.
- Self-review only; no independent agent review. Full backend/root/DB suites not repeated for this frontend-only change.

## Scoped interaction measurements

All owned builds/tests stopped before serial timing. Synthetic 200-bar history, ordinary production fixture, desktop Chromium resized to both viewports; CPU 1× and 4×. Ten alternating undo/redo samples per group, 40 total, all valid. Timing starts at trusted keydown and ends after persisted and active-primitive drawing counts match for two animation frames. Plot focus and visible area checked; all canonical/display values unchanged afterward. These are rendering-scheduling proxies, not physical paint or real hardware measurements. Browser resizing is not physical mobile or touch acceptance.

| CPU / width | Samples | Median ms | Maximum ms |
|---|---:|---:|---:|
| 1× / 1440 | 10 | 30.2 | 32.1 |
| 1× / 390 | 10 | 29.5 | 31.9 |
| 4× / 1440 | 10 | 21.6 | 55.6 |
| 4× / 390 | 10 | 20.9 | 28.2 |

All 40 are below 100ms for this narrowly defined edit. Small-sample nearest-rank p95 equals maximum, not a population estimate. The lower slowed medians reflect scheduling phase and do not establish faster behavior under throttling. Initial-source 40 samples (maximum 51.6ms) are retained separately, not substituted for the final source. This does not validate first navigation, actual Replit speed, provider delivery, broker latency or competitor superiority.

## Retained failures and limitations

New editor tests on the unchanged baseline: 18 pass / 6 fail; focused implementation 63/63 before the additional history integration case; final full run includes all new cases. Review wrapped the storage-event test update in act and added history-reset assertions before the application commit. Local server binding and browser launch were first blocked by environment permissions, then succeeded with the approved isolated execution. An initial browser command treated a filename as code (ReferenceError); corrected to --filename. A diff check was accidentally run outside a repository, then repeated in the actual worktree. No application/browser assertion was weakened.

The earlier Replit pending-engine import remains busy. Read-only status questions were rejected as busy, not queued; it has not received these shortcuts. Preserve that running task and the exact prior combined source. API activation stays deferred. Owner-authenticated published-app acceptance and physical-device checks remain unverified.

## Evidence and next steps

Raw files: `/Users/areyouok/arx-tier1-release/chart-drawing-shortcuts-20261031`. Portable receipts under `docs/validation/chart-drawing-shortcuts-20261031/manifest.json`, with original and archive SHA-256 hashes. Owned browsers and servers closed after validation.

Next: obtain the pending Replit result, then selectively import this accepted change with final combined validation while preserving concurrent work. Keep the first-navigation 100ms target open and continue startup work; retain all earlier invalid/outlier measurements. Cockpit/funds/dispatch, provider/broker validation, and the remaining chart/Truth/Scanner/Profit Mission gaps are not complete. No main merge, deployment, existing database changes, API/worker activation or live/demo tests authorized here.
