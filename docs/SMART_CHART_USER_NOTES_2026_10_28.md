# Smart Chart user text notes — 28 October 2026

Development slice based on `0f12247640a589b655a6d8e74ba521a899a06cf4`.
It adds manual notes to the shared chart used by Scanner and other native-chart
surfaces. It does not add automated analysis, confidence, trading permission or
new feed evidence. No release, deployment or competitor parity is claimed.

## Reference behavior and bounded acceptance

TradingView's standard Text tool follows a chart point as the user scrolls.
Its documented options also include in-chart typing, typography, background,
border and timeframe visibility. [TradingView Text documentation](https://www.tradingview.com/support/solutions/43000516983-text-drawing-tool/)

MT5 Text uses date/price coordinates and moves with the chart; its settings
include font, rotation and anchor placement. MT5 Text Label instead uses pixel
distances from a chart-window corner and remains fixed during scrolling.
[MT5 Text](https://www.metatrader5.com/en/terminal/help/objects/graphical_objects/obj_text),
[MT5 Text Label](https://www.metatrader5.com/en/terminal/help/objects/graphical_objects/obj_text_label)

ARX implements the chart-bound case in this slice:

| Behavior | ARX scope |
|---|---|
| Placement | Choose **Text note (yours)**, enter text, then choose an actual loaded candle and price. |
| Identity | The canvas card says **Your note**; it is never labelled an automated reading or signal. |
| Editing | Edit in Objects and choose **Save note**. One save creates one undo entry. |
| Movement | Drag the card or its candle/price handle. Card movement preserves the anchor offset, including when the pointer starts over whitespace. |
| View changes | The note follows time/price projection, including zoom, pan and scale changes; it disappears when its anchor is outside the loaded/visible chart. A short connector identifies the exact anchor when the card moves inward near an edge. |
| Lifecycle | Existing select, lock, hide/show, delete, undo/redo and symbol/timeframe storage isolation apply. Replay notes stay session-local. |
| Text | Literal plain text, at most 240 UTF-16 code units and six explicit lines. Visible content is required; control/bidi-override characters are rejected. CRLF is normalized. HTML and Markdown have no special meaning. |
| Rendering | One shared drawing primitive, fixed 12 px type, word wrapping with grapheme-safe splitting for long words, user color on the title/border, and no added candle or price-series data. |

The existing 40-drawing limit includes notes. Text can wrap into more than six
visual lines. A tall note shows the lines that fit plus **More in Objects**;
short panes use a **Your note · Objects** badge. Below 40 px pane height cards
are withheld; full text remains in Objects. An anchor outside the current data is not moved to a
substitute candle. Browser storage remains local-device storage, not account
sync; existing storage-failure warnings still apply.

## Tests and cost evidence

Focused tests cover invalid imported text/coordinates, literal markup,
round-trip validation, Unicode layout, projection and hit-testing, actual
canvas text, loaded-history refusal, card/handle movement, locked movement,
creation/edit/undo/redo/reload, hiding/deletion and chart-context isolation.
Source callbacks still use current drawing state; the earlier unchanged-note
and unchanged-selection performance fixes remain intact.

The operation-count check uses 40 short notes. Their first layout requires one
text measurement per note. Sixty subsequent viewport invalidations perform
2,400 anchor projections and **zero additional text measurements**. This is
deterministic unit evidence for the bounded layout cache, not browser timing,
paint timing, frame-rate or a TradingView/MT5 speed comparison. The cache keeps
at most 128 text/width layouts. Changing text or available width recomputes its
layout, and projection still updates on every viewport invalidation.

The source-bound final receipt and retained initial failures are in
`/Users/areyouok/arx-tier1-release/chart-text-notes-20261028/`.
The initial typecheck lacked the unchanged domain build output in the new
worktree; the corrected run uses that existing output. A later word-wrap test
used a width smaller than its own expected text; the corrected fixture retains
the actual 16 px padding requirement. A follow-up hit-test initially used a
fixed pixel still inside the card; it now tests one pixel below the computed
card boundary. These failed test attempts remain in the receipt directory.
Independent review found that tall text could be silently clipped; the bounded
card, continuation footer and short-pane badge above close that finding.

## Gaps kept explicit

- Direct in-chart typing, screen-fixed labels, adjustable typography, rotated
  text, multiple alignment anchors, per-note visibility across timeframes and
  configurable background/border are not implemented.
- Notes remain manual local annotations. They do not identify chart patterns,
  establish market truth, generate advice or enter any trading path.
- This branch has unit/component and source validation. Actual Scanner desktop,
  mobile/touch, PNG and integrated latency acceptance must be recorded on the
  eventual combined source; they are not inferred from component tests.
- Existing W1/MN1 calendar gaps, active reader acceptance, sustained stream/history
  loads and equal-condition competitor measurements remain open.

No main merge, publication, existing-database operation, worker change or broker
test was performed for this slice.
