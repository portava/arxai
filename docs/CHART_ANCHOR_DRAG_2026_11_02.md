# Native Smart Chart: direct anchored indicator scale — 2026-11-02

Scoped outcome: pointer and keyboard movement of an existing anchored indicator scale is implemented and offline accepted. The architecture and competitive chart goal remain incomplete. No deployment, main merge, existing database change, worker activation or broker test occurred.

## Exact source

- Parent numeric-anchor checkpoint: `5a04e3dda8dc1863c952f97ec94bbaac06675674`.
- Initial direct-drag implementation: `8fdf47cba921f860066cbc72b2f4cc6f44adf439`.
- Final application and browser driver: `d54eb639a7993060f9b9f78215ca06b0abbde7ac` on `codex/chart-anchor-drag-20261102`.
- Clean production-default native fixture: `e33cf206cb84a98f`, built from that exact final application commit.
- Independent source review: 13 file hashes match final source. Review did not run test workloads.

## Behavior

The gold indicator scale anchor can be dragged directly. Movement previews a new vertical percentage without changing saved settings or raw indicator calculations. Release commits once; Escape, pointer cancellation, capture loss, blur and unmount abandon the preview. Keyboard arrows move 1%, Shift+arrow 0.1%, Home/End reach 0/100%. Existing numeric value/percentage settings and Auto release remain.

The preview uses the actual pane owner's mapping for plot, anchor and scale labels. Invalid or unrepresentable mappings refuse. Source, timeframe, layout, settings and context changes invalidate old gestures and delayed commits. Scale and divider gestures have exclusive ownership. Maximized panes remain maximized during direct edits; collapsed panes expose no anchor handle.

An explicit pane action may finish a pending cosmetic hover repaint. It cannot use unpainted data or changed geometry, and paint failure or synchronous source replacement refuses the action. Passive getters remain passive.

## Validation on final source

| Check | Actual result |
| --- | --- |
| Focused adapter, anchor handle and workbench | 140 passed |
| Full dashboard | 5,025 passed, 12 skipped, 0 failed; 293 files passed, 2 skipped; 137.12 s |
| Typecheck | Passed |
| Production build | Passed, existing bundle warning |
| Repository guards | 85/87; existing risky-wording and internal-name guards fail; 43 normalized failure lines identical to parent |
| Actual Scanner route, offline browser | 18/18 checks, zero page errors, zero unexpected writes |
| Browser network isolation | 90 intercepted requests; 57 unavailable endpoints; 6 expected blocked POSTs; 63 offline console errors; 4 synthetic candle responses |
| Visual inspection | Desktop dragged guide and 390px narrow layout viewed |

Browser checks cover preview before persistence, release, exact candle/indicator/layout invariance, Escape cancellation, keyboard boundaries, reload, ordinary single-click maximize, anchor edit preserving maximize, collapse/expand and narrow-layout keyboard control. The browser was closed and owned loopback server PID 67406 stopped (handle 88370, exit 0).

## Retained failures and corrections

- Initial implementation baseline: 9 failures, 56 passes; retained, not counted as final validation.
- Review found a history A→B→A range round trip could revive an old drag lease. Two regression tests failed before monotonic invalidation; both fixed.
- Browser runs initially reached 13 successful checks and then failed maximized-pane adjustment. Diagnostics separated a cosmetic hover repaint dropping a click from a generic settings setter restoring the pane and invalidating the edit. The final real-click driver passes without a hover/wait workaround.
- Four action-flush regression tests failed before the fix. Two more wheel geometry regressions failed before routing zoom/pan invalidations through the frame revision. Pointer-pan coverage was added too.
- A reentry test was strengthened to prove paint recovery and an actual synchronous completion callback. Its earlier false assertion was insufficient evidence; this was a test correction, not an additional product bug.
- Earlier full runs (5,017 and intermediate action run) belong to earlier source states; only the 5,025 result above describes the final source.

## Competitive scope and limitations

The MT5 documentation describes Scale by line with a value, percentage and draggable line: https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators (verified in the numeric-anchor research checkpoint). ARX now has this interaction category with its own explicit mapping policy. This is not proof of identical MT5 scaling semantics, broad parity or faster performance.

Actual mobile touch dragging remains untested; the narrow browser check uses keyboard. Near the pane's upper boundary the focused anchor strip is close to the caption; dense multi-study visual acceptance and collision refinement remain open. No latency benchmark was run for this change. Existing 4x CPU/navigation/replay performance gaps remain. Other chart capabilities, fair competitor comparison, native MT5 compilation/terminal evidence, Truth/money accuracy integration and full launch readiness remain separate incomplete work.

The separate performance chat reports changes in Replit, but those changes were not imported or validated in this isolated chart branch. No claim here applies to the currently served Replit preview.

Evidence packet: `/Users/areyouok/arx-tier1-release/chart-anchor-drag-20261102` (raw failures, browser screenshots/logs, review hashes, guard comparison and validation receipt).
