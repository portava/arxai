> Additional follow-up: the [Twelve Data stock slice](TWELVE_DATA_STOCK_VOLUME_EVIDENCE_2026_11_01.md) also qualifies original UTC for its audited explicit stock request. It does not establish historical BID/MID execution prices. Generic other-provider and rehydrated cache clocks remain withheld.

> Follow-up: the audited existing Polygon/Massive forex custom-bars adapter now has a narrow original UTC/BID path. See [its contract and limitations](POLYGON_FX_ORIGINAL_CANDLE_EVIDENCE_2026_11_01.md). Statements below about no registered adapter describe this document’s original clock-gate checkpoint, not the later combined source. Other provider and legacy/cache clocks remain withheld.

# Original candle clock evidence: interim research hold

This is a source-provenance correction, not historical timezone reconstruction or launch completion. No shipped production adapter currently provides qualified original UTC candle-clock authority. Consequently real chart research remains unavailable, even when original BID/MID price evidence is present. Prices and source-coordinate chart geometry remain visible.

## Why ISO strings were insufficient

MetaQuotes explicitly documents that the horizontal-axis time of MT5 charts is the server time in history: [Local and server time](https://www.mql5.com/en/book/common/timing/timing_local_server). `MqlRates.time` is the [period start time](https://www.mql5.com/en/docs/constants/structures/mqlrates). [TimeGMT](https://www.mql5.com/en/docs/dateandtime/timegmt) derives current GMT from the computer's local time/DST settings; it is not a historical broker timezone table. The [Universal Time documentation](https://www.mql5.com/en/book/common/timing/timing_gmt) distinguishes server and UTC clocks. Today's heartbeat offset cannot establish past offsets, DST transitions or historical changes in broker server configuration.

The maintained v151/v152/v154 batch producers serialize `r[i].time * 1000`. The v152/v154/kernel closed-candle streams serialize the same raw `MqlRates` coordinate. Batch `brokerCandleStore.parseTime` and the v2 stream sink turn the numeric coordinate into a JavaScript `Date`; `toISOString()` then appends `Z`. Neither operation establishes that the source coordinate represented UTC. Existing database names such as `openTimeUtc` are not proof of original time authority. This patch does not migrate, reinterpret or rewrite those stored values.

## Contract and boundary

`Candle.timeBasisEvidence` is optional for compatibility. Normalized candles expose the evidence through the existing OpenAPI/generated client contract:

- `kind`: `original_utc` or `unavailable`;
- `basis`: `UTC`, `BROKER_SERVER`, or null;
- `authority`: stable audited authority identifier, or null;
- `reason`: null for qualified authority, otherwise an explicit limitation.

The backend `resolveCandleTimeBasisEvidence` deliberately registers **no qualified production authority**. It refuses arbitrary raw evidence objects, including self-declared UTC or current-heartbeat-offset claims. MT5 receives unavailable evidence explaining its broker/source-clock limitation; other sources remain unavailable rather than obtaining UTC by provider-name inference. A future original provider adapter must establish its real timestamp contract and coverage, be independently reviewed, and explicitly register its authority before this resolver can admit it. Adding a string to a client payload is insufficient.

Normalization retains existing prices and coordinate values. Its clock metadata is not a freshness upgrade, provider attestation, financial recommendation or execution permission. Forming tips explicitly lose original clock authority; cache/deep-history rows without retained authority cannot regain it. `sourceDocumentation.timeBasisNote` keeps the limitation in Truth's source receipt.

## Chart and research behavior

Research capture requires every selected original candle to carry one consistent `original_utc`/`UTC` authority with a nonempty identifier and no unresolved reason. Missing, malformed, broker-clock or mixed authority blocks the run. Snapshot version **3** records the clock evidence. Result binding rechecks current original evidence and exact captured prices; withdrawal removes chart markers and explanations. Prior snapshot versions are refused, not silently upgraded. Engine v1/v2 numerical fingerprints remain unchanged: they certify supplied input/results, not clock authenticity.

The visible chart keeps original source coordinates. Without qualified clock evidence, timezone conversion is disabled and stored display-zone preferences do not shift the chart. The legend, drawing/Fibonacci coordinate labels and local study-assistant receipts say source clock with UTC mapping unverified. Go-to dates are explicitly source-coordinate dates; changing clock qualification clears pending date input even when both effective formatting zones are UTC. PNG capture time remains the actual browser capture time, while its feed disclosure identifies unqualified candle times. No price calculations or chart-coordinate math are reconstructed. Replay snapshots do not retain original clock authority, so saved non-UTC preferences are preserved but never applied to their source coordinates. The embedded chart reader follows the same rule and omits absolute UTC `datetime` attributes for unqualified observations. Actual replay capture time remains separately identified as the browser capture time in UTC. Saved Fibonacci origins have no original clock evidence and remain explicitly source-clock/unverified even when a later current feed qualifies UTC; current evidence cannot relabel archived provenance.

The `original_utc` examples in frontend tests are explicitly controlled normalized fixtures named `offline:utc-clock-fixture-v1`. They test how a future qualified server response is consumed. They are not produced by the current backend resolver and do not certify any live MT5 adapter.

## Remaining work

Historical original time authority, actual provider timezone coverage and independent real-source acceptance remain open. Current-price freshness, other existing source-clock-derived diagnostics and stored historical data are not repaired by this gate; no broad correction to their timestamp arithmetic is claimed. Native EA compile results do not establish timezone semantics. No terminal, broker, existing database, worker or external AI service was used for this change.

## Validation of this patch

The focused frontend set passes 305/305 across nine files, including the actual saved-Fibonacci/New York regression, replay and reader display, capture/rebinding withdrawal, native chart disclosure and workbench input clearing. The registered API candle-shape lane passes 71/71, including 17 new clock-specific cases. Dashboard/API typechecks and regenerated client/Zod declarations pass. Raw failing-before evidence is retained: six original research capture/binding failures, replay timezone conversion, and archived-origin conversion. Independent review closed the replay, reader and archived-origin findings. No full combined application build or browser acceptance is claimed by this isolated patch; integration must rerun those on its exact resulting commit. Raw receipts: `/Users/areyouok/arx-tier1-release/chart-time-evidence-20261101/`.
