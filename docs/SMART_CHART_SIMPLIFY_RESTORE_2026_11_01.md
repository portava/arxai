# Smart Chart simplify/restore and independent Truth audit — 1 November 2026

Application `edd97a425f4d95b491730f07623e0e7bdfb3b9d2` on `codex/chart-simplify-restore-20261101`, based on `837b28a6`. Development-only; architecture and release remain incomplete.

## What changed

The existing Scanner chart now has **Simplify chart / Restore tools** and equivalent selected-pane local assistant commands: “make this chart easier to understand” and “restore chosen tools.” The temporary view hides studies (including oscillator panes), user drawings, selected pattern annotations and automatic server structure. It preserves the current settings, individually hidden channels/objects, locking and drawing history. Original/displayed candles, trade/risk overlays, research overlays and source warnings remain. Reload resets this temporary mode. This adds no second chart, data authority, model call or trading path.

Valid requests to show tools restore the view before applying their settings. Invalid/unsupported settings and unavailable sources do not silently restore. Manual settings share the same owner. A completed drag is cached before the parent update, preventing immediate simplify/restore from reviving old geometry; an unfinished gesture is cancelled without committing. Context reset cannot revive old source-owned geometry. New engines receive the current temporary mode.

The reader, data window, preview cards, assistant receipts and export labels distinguish saved choices from visible layers. Failure to render does not prove hidden or restored geometry: the adapter marks presentation unverified and requires chart recreation/reload; UI labels disclose that uncertainty and tool acceptance/export refuse. A related pre-existing preview-capacity hole was repaired: saved drawings plus simultaneous automatic previews must fit the renderer’s existing 40-object cap. Incoming storage changes remove preview rows immediately, before effects can submit an oversized list.

## Exact evidence

On the application commit above: **3,436 frontend tests pass, 11 skipped**; dashboard typecheck and ordinary build pass. Focused review lane:321 pass. Full guards:85/87; unchanged failures are38 wording matches and3 raw JSON displays. Those matches need audience/context review and are not41 confirmed defects. Build retains the existing large-chunk warning.

Actual Scanner browser fixture `ef7c18b710766deb` records clean identical source before/after. Desktop1440px:17/17; phone-width390px:17/17. Real rendered series/drawing rows verify suppression, exact restoration, hidden-channel preservation, original/displayed candle equality, manual/assistant equivalence, refusal of invalid settings, isolation between panes, and reload retention. Root inspected chart screenshots. The browser checks use intercepted synthetic history, not a real feed, live API, broker or deployed app. Risk-overlay preservation, drag cancellation, source reset and render-failure handling are adapter/component proofs, not live-broker acceptance. No timing or physical-device claim is made.

Initial failures and outliers remain in the raw evidence. The first reload test compared serialized JSON text and rejected reordered fields; diagnostic values were identical. The corrected assertion compares every parsed field and array order. A reused browser context also rejected an already-registered fixture hook; final checks used fresh contexts. No failing product assertion was relaxed to claim a green release.

## Agent chart-versus-Truth audit and ChatGPT cross-check

The independent agent inspected preserved Scanner imagery, underlying175-candle data, rendered indicator values and accepted Truth/freshness labels on application trees identical to `837b28a6`. **31/31 independent numerical checks pass**:23 displayed statistics,6 MACD/Bollinger values, canonical/display equality, and fixture-generator correspondence. Spinning-top geometry and developing double-top pivots were separately corroborated. No new confirmed discrepancy was found in this bounded evidence. Earlier calendar/default-grade/stale-label fixes were not counted again.

A sanitized text/data prompt was sent to the owner-authorized [ChatGPT conversation](https://chatgpt.com/c/6ae734b8-4634-83ec-ac21-5c96378342ed). ChatGPT reproduced the supplied statistics and corrected its earlier confusion between empirical midrank and min–max range position. Its answer is advisory: it received no image or private source and did not validate live data, causality, predictive reliability or the full app. The agent’s calculations and exact prompt/response are retained independently.

## Verified competitive scope

TradingView documents hiding, showing and removing drawings/indicators through its Object Tree/Data Window. ARX’s temporary simplify mode preserves hide-versus-remove semantics and adds the requested local-language control; this is not a parity finding. [TradingView visibility guidance](https://www.tradingview.com/support/solutions/43000484389-how-to-restore-hidden-drawings-indicators-charts/).

MT5 documents lists for editing/deleting applied indicators and analytical objects. Its MQL5 `OBJPROP_HIDDEN` concerns the object list, not hiding plotted geometry, so it is not equivalent to ARX’s analysis mask. [MT5 applied objects](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list) · [MQL5 object properties](https://www.mql5.com/en/docs/constants/objectconstants/enum_object_property). No matched native/chart performance comparison was run.

## Replit and remaining work

Replit reports the earlier78f source import complete: combined application `31f4a51fea267c737cb57a4c50f2c1eb818e6711`, checkpoint `22c6966ca553103467683792a4aa2f4aef9b1f54`. Recorded3401 frontend/11skip,539 targeted backend,84/87 guards,7 bindings,22 recorder and9 fixture checks; both isolated builds/typechecks pass. No new browser run. API PID/start,16 build trees/6447files and16 compiler metadata files were preserved. **Frontend runtime preservation was not established**: Vite reads the edited source directory, so unmeasured HMR/client changes may have occurred. Do not repeat a source sync into that watched directory under a no-runtime-change promise. Any future backup must first target a separate unserved archive/worktree. Current application has not been imported there.

Broader owner requirements remain: complete natural/manual controls across tool families, editable automatic drawings, capital/sizing/costs/equity/benchmarks, historical-strategy evidence, real-provider qualification, source/funds/execution alignment and matched low-end performance. Held performance branches stay excluded. No main merge, publish/deploy, app-runtime restart, existing-database change, workers/emails or live/demo trade occurred.

Raw feature receipts: `/Users/areyouok/arx-tier1-release/chart-simplify-restore-20261101/`.
Independent audit: `/Users/areyouok/arx-tier1-release/chart-truth-independent-audit-20261101/`.
