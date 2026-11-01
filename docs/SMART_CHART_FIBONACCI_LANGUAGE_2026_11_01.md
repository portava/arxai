# Fibonacci language through the existing Smart Chart assistant

Base: `2f8f4d9d`. This extends the existing assistant and drawing owner. No new chat, chart engine, model request, calculation authority or order path is introduced.

## Accepted scope

- “Show automatic Fibonacci on this chart”, “preview Fibonacci”, “add Fibonacci” and “apply Fibonacci” request an **unaccepted preview only**.
- “What does Fibonacci show me about this chart?” and “what is Fibonacci?” explain a current preview or selected kept drawing; otherwise they prepare the same source-bound preview as the manual Drawing tool.
- “Explain Fibonacci preview” explains an existing current preview without creating one.
- “Explain selected Fibonacci” requires a selected kept Fibonacci drawing.
- “Keep Fibonacci” explicitly converts a current valid frozen preview to an owned drawing, just like Keep and edit. Curiosity never keeps it.
- “Hide/show/remove selected Fibonacci drawing” edits only the selected owned Fibonacci. Bare hide/remove, all-object instructions and extra modifiers refuse. Hidden Fibonacci objects remain selectable in Objects; global drawing visibility is preserved.

The complete phrase must match. Additional assets, timeframes, spans, ratios, anchor rules, other tools, ambiguous ownership actions or orders refuse locally with no partial execution and no remote fallback. The same primary chart owns both manual and text actions; comparison and private replay tools never register this command.

The parser/registry imported by the chat shell has no runtime imports. Geometry and source explanation stay in the chart bundle. This avoids importing chart-pattern calculations into assistant startup.

## Same authority and user ownership

`ChartWorkbenchTools` calls its existing `requestFibonacci` action. The assistant never writes drawings directly. Explicit Keep calls the same manual owner action; selected hide/show/remove call the same manual persistence and history callbacks. Existing source/finality/visible-window gates, fixed span-two causal pivots, 600-bar limit, preview withdrawal and manual limits remain authoritative. Keep remains an explicit button or complete text instruction, using ordinary persistence and undo. Same-turn repeated Keep consumes the preview once; current source/window, capacity and storage availability are checked. Owner refs retain ordered edits before the next render. A failed browser-storage write is disclosed as an open-view-only change.

A preview response says **prepared**, not painted. A later explanation checks the existing owner's installation record and current source window. Revoked or changed evidence withdraws the old preview; the assistant does not describe those old anchors as a current reading. Replies explicitly remain local receipts at request time rather than continuously updating chat evidence.

Level values come from `drawingSegments`, the same manual Fibonacci geometry, with the chart reader's disclosed rounded display formatting. The text identifies first/second anchor orientation, all seven levels, actual confirmation time, source identity and observed window. Ratios are not reversal probabilities, forecasts or targets. Transformed candle display does not replace source OHLC.

Selected kept drawings are described as the user's current editable geometry. Their archived automatic anchors/source are separately named and explicitly not revalidated as current advice. Explanation does not overwrite edits, hide/show preferences or stored objects. A flat edited range is described as flat.

## Validation and remaining limits

Two owner integration tests failed before registration was added: text could neither prepare the manual-equivalent preview nor fulfill chart curiosity. Focused tests cover complete-phrase refusals, manual/text geometry equivalence, selected edits/original provenance, hidden selection, unknown/replaced sources, refreshed explanation values, renderer absence, primary ownership, unmount cleanup, no automatic Keep, and actual assistant-panel routing without a remote message. Existing drawing lifecycle and replay regressions are also included in the parent-reported validation receipt.

A malformed archived timestamp regression exposed an existing Objects-panel crash before the assistant could explain it. Origin validation now uses the existing anchor-time bound for confirmation/window times and strips invalid origin metadata while retaining the manual drawing. The failing-before receipt is retained.

Independent Truth review found no blocker. Its wording observation was corrected: when invalid evidence withdraws a preview, the reply says no **new** Fibonacci was added rather than claiming nothing changed.

Selected-manual explanations currently require a ready fresh automatic proposal as well; they may conservatively refuse when the current window has no qualifying opposite pivots. Arbitrary drawing rules, custom automatic spans/ratios, arbitrary natural-language anchor edits, comparison/replay command ownership, VWAP/profile and automatic SR integration remain outside this slice. Parent owns combined exact-commit browser/build acceptance. No deployment, database change, activation, broker or model call was performed.

Source-clock limitation at this base: MT5 epoch values may represent broker-server clock coordinates despite an ISO `Z` serialization. This command preserves the chart's source coordinates; its timestamps do not independently prove UTC provenance. A separate source-evidence lane owns the clock gate. No clock conversion or new timestamp authority is introduced here.

## Owned-control follow-up (base dc5f6d18)

Nine new tests failed before this extension. Tests cover shared manual/text Keep and visibility/delete effects; undo/redo; same-turn double Keep and ordered hide/show; missing/stale/unknown source; externally filled drawing capacity; hidden selection recovery; unsupported compounds/asset/timeframe phrases; non-Fibonacci selection; owner cleanup and browser-storage failure. Manual annotation visibility/delete controls do not need a fresh automatic pivot, while Keep still requires the current frozen proposal. Selected explanation retains the conservative existing fresh-proposal requirement.

Replies describe the owner action, not confirmed pixel presentation. Global Hide drawings is never overridden by a selected Show command; its remaining effect is stated. No order or remote model action is introduced. Actual combined Scanner browser acceptance remains the parent's responsibility.
