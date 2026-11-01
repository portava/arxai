# Existing assistant: current-chart study actions

Base: `d535c3f32795be9bb84dc59b708137cf5c8ce66a`. This is a bounded display capability, not general natural-language strategy execution or architecture completion.

The existing assistant now handles a small local grammar before its remote conversation path. The primary mounted `ARXNativeChart` registers its current context. It applies the existing `ChartStudy` preferences through `adapter.setStudies` and reads `getStudyValues` from that same renderer at the last visible candle. It does not instantiate another chart, chatbot, study calculator or trading path.

Examples:

- `What does RSI tell me about this chart?`
- `show MACD`, `add EMA 20`, `explain Bollinger Bands`
- `set RSI period to 21`, `hide RSI`, `remove RSI`

Supported study kinds come from the existing catalogue: SMA, EMA, SMMA, WMA, DEMA, TEMA, Bollinger, RSI, MACD, ATR, CCI, stochastic, Williams, standard deviation, envelopes, momentum, ROC, Donchian, DMI/ADX. Catalogue defaults are disclosed in the applied label. An existing single instance retains its settings unless a period is explicitly requested. All settings remain editable in Studies. Showing a study (including a curiosity request) reveals its channels and the receipt discloses that change. A period-only edit preserves existing hidden channels, whose calculated values are explicitly labelled hidden; hiding retains the instance; removing deletes it. Repeated instances require choosing the instance manually. A bare MACD period is refused because its fast/slow/signal relationship is ambiguous.

Receipts name the current asset, interval, provider/feed-at-request state, visible UTC window, exact observed bar-open time and actual renderer values. Missing/warming-up/nonfinite values remain unavailable. Current-feed confirmation does not relabel visible historical bars as live. Calculators may use earlier loaded bars for warmup; the existing viewport is retained. RSI/reference and price-versus-average comparisons explain observations, not forecasts, calibrated confidence or trade instructions.

Boundaries and remaining gaps:

- Only the primary current chart receives actions. Comparison panes cannot steal the binding. Unmounted, unready or pending changed asset/interval data refuses application.
- Full text must match the bounded grammar. Extra assets, intervals, price-source modifiers, multiple tools and negation do not partially apply. This is not arbitrary AI tool planning.
- VWAP and volume profile are explicitly unsupported here; no overlay is claimed. Volume provenance, auto structure/Fibonacci actions and historical backtest conversation remain separate gaps.
- Period changes are available in text; other study settings use the existing editor. This does not add a searchable all-tools selector.
- Local receipts appear in the existing open chat and are not persisted in the server conversation. A later remote model turn does not receive these as tools or verified historical context.
- No order, confidence-policy change, worker, external model request or broker test is involved.
- Component tests verify wiring and use controlled adapters. A real browser acceptance check of this new assistant flow remains pending; no latency or competitor parity claim is made.

Validation receipts are saved under `/Users/areyouok/arx-tier1-release/ai-chart-capability-20261101/`. Two wiring regressions fail against original base component snapshots: the assistant did not dispatch the action, and the chart had no registered application handler. Updated tests exercise actual component wiring, current-context refusal, primary-only ownership, preferences saving, supported kinds, manual overrides, hide/remove, warmup/nonfinite values and renderer failure handling. Core numeric fixtures reuse the existing `StudyCalculator`; production reads only the renderer's values.
