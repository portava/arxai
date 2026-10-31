# Smart Chart object visibility and search — 31 October 2026

Status: locally validated, not yet imported to Replit. Architecture and competitive parity remain incomplete. Source tested: `7fd1c3ac399e63b73c25040375dc49df575c9176`; immutable production-runtime fixture `64a08af4b1ceeaa6`. Base accepted source `6345956d`; no held toolbar or containment experiments included.

## Behavior

The actual Market Scanner Smart Chart now has per-object Hide/Show and a search box in Objects. Search matches drawing type, original list number or user-note text, case-insensitively. It filters only the list; it never changes the canvas or renumbers actions. Hidden objects remain saved with their exact anchors and styles and count toward the existing object limit. Hide/Show participates in undo/redo, reload and browser-local same-context synchronization. Locked geometry can be hidden without unlocking it.

Hidden drawings have no strokes, text cards, selection handles or price labels and cannot capture a pointer gesture. The editor retains the full object collection, so dragging a visible object cannot erase a hidden one. Global Hide remains a temporary visibility override; Show restores each object's individual choice. Hidden objects stay listed for recovery. These are analysis objects, not order or position controls.

Self-review checked renderer, hit testing, selection, editor commits, persistence, replay ownership and filtering. No independent agent review is claimed. Schema validation accepts only boolean visibility, preserving legacy objects unchanged. Replay remains private through the existing no-persistence boundary. Search is local and is cleared when creating a new drawing so its row can be found.

## Validation on exact source

- Full frontend: 2,583 passed, 11 skipped, 0 failed (178 passed files, 1 skipped).
- Dashboard typecheck/build passed; 87 guards and 7 binding assertions passed.
- Six new regression checks: all six fail on the prior application source, while the 48 existing focused tests pass. Candidate focused run: 54/54.
- Actual offline Scanner browser, 1440×1100 and 390×844: mouse placement of a level and text note, individual/global visibility, search retaining stable row indices, undo/redo and actual document reload passed. Exact canonical/displayed candles and chart/series identities remain unchanged across actions. Hidden objects reload hidden and restore their original geometry. No horizontal page overflow or page exceptions. Narrow screenshot inspected visually.
- Fixture APIs are intercepted. Expected unavailable-data 503 console errors, unknown read endpoints and blocked background analysis/activity requests are retained in the raw network receipt. These do not establish healthy production APIs or real-feed/AI acceptance. No broker calls occurred.
- Root/backend/live-server lanes were not rerun for this frontend-only change.

## Interaction measurement

On this same clean source, 60 trusted zoom clicks under 4× CPU slowdown in resized 390×844 desktop Chromium passed the existing ≤100 ms source-correct, unobscured-plot, two-frame witness. Median 45.6 ms; p95 46.9 ms; p99/maximum 49.4 ms. All 60 samples retained. The 16.1-second observer recorded 966 frame gaps, p95 16.7 ms, maximum 16.8 ms, zero gaps above 33.34 ms and zero ≥50 ms long tasks.

This is one offline 200-bar historical workload with saved drawings, no concurrent owned builds/tests, and uncontrolled other host load. Frame observations include test/idle time and are not physical display timing. It is not a comparison against the old source or TradingView/MT5, nor proof of universal 60 fps. Individual Hide/Show latency was not measured. First-navigation timing was not rerun for this feature; previous slow-CPU and Replit first-load failures remain open.

## Verified competitor context and remaining scope

TradingView's official [object-tree documentation](https://www.tradingview.com/charting-library-docs/latest/ui_elements/object-tree/) describes managing drawing, indicator and symbol visibility/removal. This change closes one ARX drawing-management gap; it does not add full object-tree equivalence, groups, ordering, naming, indicator/symbol management or cloud synchronization.

MT5's [object-list documentation](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) documents object selection, properties, deletion and jumping to objects. MT5's `OBJPROP_HIDDEN` refers to hiding an object from the list while it can remain drawn; ARX's new flag hides canvas geometry while retaining its list row. They are different semantics, not claimed as equivalent.

Full study/drawing catalogs, advanced chart types, loaded-history/replay performance, physical touch/accessibility, scripts/alerts/cloud workspaces, real-provider reliability and matched competitor workloads remain unfinished. No completion percentage or parity claim.

## Receipts and handoff

Portable runners, compact browser results and file hashes are under `docs/validation/chart-object-controls-20261031/`. Raw logs and screenshots: `/Users/areyouok/arx-tier1-release/chart-object-controls-20261031`. Run the storage-preserving setup in a fresh browser with immutable fixture served on loopback before the functional runner; the zoom runner uses the same strict visible-source witness as the accepted baseline. All owned browser/server processes are closed.

Replit's prior render-isolation development update is confirmed busy; it was not restarted. Retrieve its final exact combined source and failure receipts before selectively importing this separate change. Do not overwrite concurrent work or attribute local validation to remote combined source. No main merge, deployment, existing-database changes, worker/trading enablement or broker/demo testing occurred.
