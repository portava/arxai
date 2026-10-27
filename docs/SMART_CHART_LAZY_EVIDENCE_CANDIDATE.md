# Chart evidence disclosure candidate

Baseline: `1818df263770e5bdda4eb4dab73117d56ebe59ab`. This isolated candidate includes that baseline's concise percentage wording and UTC dates for older readings. It does not include the separate earned Replay cache experiment.

The closed evidence disclosure previously constructed its full metrics and older-pattern tree on every reader render. This candidate mounts that tree only while the native `details` element is open. The main explanation, descriptive context, complete analysis calculation, selected annotation and exact applied-prefix checks remain active while it is closed. Opening uses the current result, not a saved result from the last opening. Closing does not reset the selected older reading.

## Approach and comparisons

TradingView documents [hiding indicator values](https://www.tradingview.com/support/solutions/43000659666-i-want-to-hide-the-values-of-individual-indicators/) and [accessing exact values even when the status line is collapsed](https://www.tradingview.com/support/solutions/43000759580-how-to-enable-disable-floating-data-tooltip/). MT5 documents [separately showing the Data Window](https://www.metatrader5.com/en/terminal/help/startworking/interface) for exact values. These support keeping a compact chart with details available on demand. They do not establish those products' rendering implementation or latency.

The implementation uses [React conditional rendering](https://react.dev/learn/conditional-rendering) and preserves the [HTML details/summary disclosure semantics](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-details-element), including native activation and the coalesced `toggle` event. It does not replace the control with a custom keyboard handler. A queued toggle reads the element's current `open` state.

## Acceptance and evidence

- The closed disclosure contains its summary but no hidden metric/history subtree. Main readings and annotations still update from installed candles.
- Opening after a backward seek shows the latest acknowledged prefix, source and as-of time. Open details continue updating on later seeks. Missing source evidence or an OHLC mismatch withdraws the metrics and annotation; reopening cannot restore old evidence.
- Older-pattern selection, exact UTC dates and precise numeric evidence survive close/reopen. Opening alone does not rerun analysis or change its result.
- 101 focused reader, Replay and model checks pass; dashboard types pass using this checkout's local workspace dependencies. The React tests explicitly dispatch the native toggle event; production keyboard/mobile behavior still needs browser confirmation.
- Performance acceptance is **pending**: compare this candidate with its exact baseline using the same 5,000-bar, 12-study, complete-catalogue/metrics workload, both closed and open. Record median/p95/p99 for feedback, installed series, reader DOM and visible completion, plus opening the details. Retain the owner's 100 ms p95 target and all prefix/source witnesses. A smaller hidden tree alone is not a measured speed improvement.

Local logs and the candidate receipt are under `/Users/areyouok/arx-tier1-release/chart-reader-lazy-details-20261026/`. Parent review and paired production-browser measurement are required before accepting this candidate. No competitor speed, parity or overall completion claim is made.
