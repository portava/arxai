# Comparison workspace controls — 2 November 2026

Status: implemented and offline validated; chart parity and release readiness remain incomplete.

Final application commit: `a240890aa980f7327a5d8e39d1b51ce43c9c6ccd`.
Initial controls commit: `a2a7b1b2eabc9778dc03f2349d637cfc3a446b97`.
Base: `c3544679f1b7a1b360c655861f99e0705d5e3727`.
Branch: `codex/chart-comparison-workspace-20261102`.

Extends the existing optional native Scanner percentage pane rather than adding another chart engine. The selected comparison instrument now survives closing/reopening and page reload. Storage is scoped to the primary instrument and workspace pane. Only an exact canonical catalogue symbol is saved; no candles, account values, source evidence or authorization are stored. Restored choices still pass all original source, clock, interval and failure checks. Malformed choices are ignored, removal disables the comparison query, and storage failures are reported without hiding the current local selection.

A keyboard/touch range control and vertical cursor allow inspection of every observed timestamp, including missing values in one series. The slider exposes the selected time and both values; hover does not generate live-region announcements. Visible baseline prices use eight significant digits, with exact original closes available in details. Axis labels near zero are spaced without removing points, gridlines or table values.

## Verification

Evidence: `/Users/areyouok/arx-tier1-release/chart-comparison-workspace-20261102/`.

| Check | Result on final application source |
|---|---|
| Full frontend | 4,821 passed, 12 skipped, 0 failed; 274 files passed, 2 skipped |
| Dashboard typecheck | Passed |
| Dashboard production build | Passed; existing large-chunk warning retained |
| Guards | 85/87; same 43 normalized violation lines as the previous comparison checkpoint |
| Independent review | Clear; static review only, no reviewer test execution |
| Actual Scanner offline browser | 18 checks passed; clean build `32d626f9b259d769` matches final application commit |

The browser verifies independent source arithmetic, original/canonical/displayed OHLC equality, zoom rebasing, keyboard movement, canonical-only saved preference, close/reopen and full page reload restoration, narrow 390-pixel layout, axis clearance, withdrawal after UTC evidence is invalidated, close behavior and absence of embedded charts/TradingView branding. The final narrow screenshot was visually inspected.

All browser HTTP is intercepted. There were 109 intercepted requests, six blocked known background/analysis POST attempts, no unexpected network attempts and no page errors. Seventy-seven console errors from intentionally unavailable/blocked offline endpoints remain in the logs. The fixture uses real dashboard/Scanner code with synthetic history and an isolated Vite production configuration; it is not the deployable bundle and does not prove whole-app API health.

## Retained findings and limitations

- Before implementation, five new controls tests failed and seven existing component tests passed. Intermediate targeted checks passed 27 tests; additional validation and label-spacing tests were subsequently added.
- Independent review caught the new output's implicit live announcements on pointer movement. `aria-live="off"` and a regression assertion address it; slider value text remains available for deliberate inspection.
- Initial source `a2a7b1b2` passed 4,820 tests and 17 browser assertions. Visual inspection still found crowded zero/minimum axis labels. Both that passing evidence and the screenshot are retained. Label spacing was then corrected and the full frontend, typecheck, build, guards and browser acceptance rerun on final source. Earlier results are not attributed to the newer source.
- Storage is local device preference only, not cloud sync or account-specific saved workspace. Panel-open state is not persisted. Physical touch and assistive-technology device acceptance remain unproven.
- Same-main-pane overlays, independent price scales, multiple compared instruments, deep-history comparison paging and measured competitor/production speed remain open. No parity, superiority, architecture percentage or release-green claim follows from these checks.

Owned browsers and both loopback servers were closed; all owned validation handles are terminal. No main merge, deployment, Replit sync, database migration, worker activation, trading enablement or broker/live/demo tests occurred. The separate performance chat's changes and held performance branches were not installed.
