# Source-bound automatic Fibonacci proposal

Base: `5507f148`. This adds a bounded missing tool through the existing Smart Chart and manual drawing owner. It does not add a chart engine, new pattern detector, new assistant, trade permission or prediction.

## Behavior

Choose **Drawing tool → Automatic Fibonacci preview** in the Scanner's native chart or private replay. The existing source/finality capture and `selectSmartChartWindow` select only the applied visible closed history (at most 600 bars). The shared `findSwings` detector uses strict pivots with two observed closed bars on each side. The latest confirmed pivot is paired with the most recent unambiguous opposite pivot. The actual confirmation time is the close of the second right-hand bar, not the pivot's own timestamp. Same-bar high/low ambiguity and equal-price anchors are withheld.

One locked, unaccepted preview reuses the manual Fibonacci drawing primitive. Its anchors freeze; changed source evidence, closed prices, visible window or replay prefix withdraw the proposal instead of shifting it. Request another preview explicitly. Each proposal displays its actual anchor prices/times, confirmation time, method and bounded coverage. Percentages run from 0% at the first chronological anchor to 100% at the second; they are geometry, not reversal probabilities. Underlying source OHLC is used in Heikin Ashi and other display styles.

**Keep and edit Fibonacci** rechecks current source evidence and appends one ordinary editable drawing through the existing history, storage and editor. Original proposal source identity, symbol, timeframe, method, window, confirmation time and anchors remain separately recorded. Later edits affect current anchors only. Original metadata is explicitly described as provenance rather than current live advice. Undo/redo, delete, hiding and locking use existing tools. User-owned drawings are never moved or deleted by automatic refresh.

Preview objects never enter stored drawing history or templates, and are filtered out of manual editor commits. An explicitly requested PNG may include the visible preview, but its header labels it **UNACCEPTED automatic Fibonacci preview**; source/feed context remains included. Export rechecks source/window validity immediately and withdraws an invalid preview before any capture.

## Validation

- Three initial component checks failed against the original tool: no preview/apply ownership path existed. The initial standalone launch also hit a missing local Rollup binary; that dependency failure is retained separately and is not counted as a product test failure.
- 209 focused checks pass across pure Fibonacci, existing workspace validation, drawing primitive/editor, workbench tools, Native wiring and replay wiring.
- Independent Truth review found malformed archived provenance could describe impossible confirmation spacing. Five added tests reproduced that gap; validation now strips impossible origin metadata without deleting the manual drawing. Local metadata remains descriptive, not attestation.
- Local declaration builds and dashboard typecheck pass.
- Tests cover causal-prefix parity, missing/unsupported evidence, a future replay candle, same-bar ambiguity, exact ratio geometry, original provenance surviving manual edits, preview exclusion from storage/editor commits, undo/redo, revocation immediately before Keep/export, native source revocation and replay seek.
- Independent review and combined browser acceptance are recorded by the parent integration lane; unit/component results alone are not browser acceptance or a performance claim.

## Limits

The pivot span is fixed and disclosed at two observed bars. Automatic selection operates only on source-qualified visible history, with existing 600-bar coverage disclosure; it does not fetch hidden history, claim complete sessions, score swing significance or identify a preferred trading opportunity. Missing scheduled intervals are not inferred from elapsed gaps. This slice has no assistant natural-language drawing command, automatic SR zone integration, VWAP or volume profile. Existing source data limitations remain. No deployment, API activation, existing database changes or broker tests were performed.

## Parent-reset lifecycle correction

Actual Scanner browser acceptance of the first integrated implementation found a real regression: a source-context reset removed kept drawings from the canvas while their edited objects remained correctly saved. Moving all drawing installation into a child layout effect let the parent's later `resetDataContext()` clear them. Two new component regressions reproduced this ordering, including initial saved drawings; an additional Strict Mode regression caught effect-replay reset handling.

Ordinary drawing installation is again passive, after parent context resets. Only withdrawal of a previously installed invalid preview is immediate in layout. Installation tracking avoids a duplicate same-epoch withdrawal write, while epoch changes and adapter effect replay force reinstallation. Render/action-time evidence checks remain intact. Kept original provenance and stored manual edits are unchanged. The four affected component suites pass 140 checks; the parent owns the renewed exact-source browser acceptance.

## Parent combined acceptance

Exact tested application: `203df87e2e6d42fd435d9c2e0b6dffaea580cedd`; actual Scanner fixture `8a320ae32b0b6ea2`. Parent combined frontend: 2,986 pass / 11 skipped; all four typecheck units, dashboard production build, domain declaration build, 87 guards and 7 bindings pass. This is targeted change validation, not a new full-root-CI or API-runtime receipt. Backend source behavior remains covered by the separately recorded original-basis correction.

Actual Scanner browser acceptance: desktop14/14, CPU4x14/14, phone16/16 assertions pass (44 repeated assertions, not44 unique features). Tests observe real drawing geometry and storage: one locked preview, original candle anchors, explicit Keep/edit, preserved original provenance, undo/redo, source-change withdrawal without moving kept drawings, and reload preservation. Phone checks first verify a narrow49-bar view refuses an unsupported opposite swing, then fit loaded history, wait for the actual range to apply, and verify the same ownership path. Screenshots were visually inspected. No page exceptions.60 unavailable API requests and5 blocked mutations per session remain in raw logs; no broker/order request is accepted. These use synthetic historical fixtures, not broker data.

The first candidate `f5bed074` exposed a genuine lifecycle regression in the browser: moving drawing installation into a child layout effect let the parent's later source-context reset erase saved geometry, although local storage retained it. Two component regressions reproduced initial/source-change loss, and a third exposed Strict Mode replay. The correction restores passive installation after the parent reset while retaining immediate invalid-preview removal and avoiding a same-epoch duplicate write. All failed attempts are retained.

Two phone harness attempts expected a proposal too early: the first had insufficient visible swings, and the second requested before the fitted range reached the chart. Both correctly withheld anchors; the final check waits for observed range application and verifies the withholding explicitly. No product evidence gate was relaxed to pass a test.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-auto-fibonacci-20261101/`, including initial source checks, browser failures, component failures, final receipts and screenshots. No new click-latency or first-navigation benchmark is claimed by this increment; previous first-visit and large-chart performance gaps remain open. Replit import/acceptance is tracked separately. Nothing was merged to main, deployed, enabled or broker-tested.

## Combined MT5 source checkpoint

Combined source `eeb77d0bd563943562f4819f66c33eaf0dd4f519` also includes the reviewed original chart-mode producer source and compiler report. The dashboard, domain and generated API source trees are byte-identical to tested203df87e; no later browser result is inferred for a changed frontend. Four EA source hashes match compiled77a4b829 exactly. At this combined head the existing offline lane passes56 fake-DEMO-core +105 management +60 original-basis payload assertions, bridge packaging5/5 and87 guards. These named offline DEMO checks make no terminal/broker calls. The separate674 terminal-result receipt belongs to77a4b829 and is not relabelled as a new combined run.

The Mac/Wine compile-only receipt independently verifies all four new EX5 artifacts and0errors/0warnings, while retaining process exit1 for each. No binaries were installed or published. Runtime, v2 declaration preservation, Replit final acceptance, first-navigation performance and remaining owner-document capabilities stay open.
