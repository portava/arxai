# Shooting-star candle identity and resistance evidence — 2 November 2026

Development-only correctness repair. ARX remains not release-green; broad engine accuracy and TradingView/MT5 parity are unproven.

Application: `ae251596ad941fd0f378e2509b1bef3bd8895fe7` on `codex/chart-star-identity-20261102`; parent `7131a17bd1eebe7e28527897405656e4b095b38e`. Documentation checkpoints do not change application bytes.

## Proven defects and corrections

The shared detector correctly selected a shooting-star candle, but Smart Chart reconstructed its identity by searching for the last candle with the same high and low. A later wide-body candle with equal extrema stole the marker. A subsequent decline then falsely confirmed a shooting star on that non-star candle.

The deterministic fixture starts with five advancing closes, followed by open1.04/high1.06/low1.0395/close1.041. The next candle shares high1.06/low1.0395 but has open1.04/close1.055; it is not a shooting star and did not close below the original star's low. A further close1.035 must not count as the original star's next-candle confirmation. Before the fix, the reader emitted two shooting-star findings and falsely confirmed the newer one.

The shared detector now returns its exact selected source-window index, or null when absent. Smart Chart uses that identity and validates its index and extrema. It preserves the sixty-candle rolling-prefix offset and original following-candle confirmation rule. Tests cover the fixture with zero and61 earlier candles, both before and after the delayed decline. The marker, reader and local assistant explanation stay on the genuine star and remain observed/unconfirmed.

Separately, the detector hardcoded `at_resistance` after testing only a prior advance and wick geometry. Server reasoning repeated it as a fact. It now returns unknown location because no independent resistance-level evidence is supplied. The existing test that asserted resistance by definition was corrected. Gold's separate atKeyResistance/midRange checks, ranking and execution gates are unchanged. Existing heuristic confidence weights were not recalibrated or turned into probabilities.

## Exact-source validation

| Check | Result |
| --- | --- |
| Before: Smart Chart regression | 1 fail /57 pass; duplicate false-star finding reproduced |
| Before: pattern-library suite | Unsupported resistance and absent source-index regressions fail; raw counts retained |
| Focused chart analysis/reader consumers |192 pass |
| Full dashboard |4,714 pass /0 fail /12 skipped |
| Pattern library, actual server composition/reasoning |35 pass /0 fail |
| Pattern Truth suite |26 pass /0 fail |
| Library, API and dashboard typechecks; both production builds |Pass |
| Guards |85/87; same43 baseline failure/diagnostic lines after source-location normalization |
| Actual Scanner browser |11/11, fixture5bb5b3ce6325ea8e on exact clean application commit |
| Independent review |Clear within this repair; all five reviewed hashes match final source |

React integration uses the real analyzer and rendered SmartChartReader, with an adapter boundary double. It checks the exact genuine candle timestamp/price sent to the annotation, dashed unconfirmed geometry, screen explanation and local assistant getter. The backend regression calls real buildPatternLibraryRead and buildPatternReasoningBlock and checks no invented Location/at-resistance evidence and no execution-permission fields.

Browser acceptance uses the actual dashboard entry/native renderer with69 synthetic historical candles, compares applied source bars, selects the genuine observed star, and checks desktop/mobile narrative and stale qualification. External/broker connections are blocked. Initial browser fixture used MOCK source mode and correctly failed the analysis-availability expectation; its logs/screenshot are retained. The corrected synthetic fixture uses the recorded-demo schema, not a real demo account. No application changes between those attempts.

The isolated Vite fixture is not the deployable dashboard bundle. Annotation identity is component-tested; no canvas pixel-level measurement of that marker is claimed. Mobile sticky-header overlap and expanded-panel density remain visible. No new timing, native-terminal, real-provider, full-release CI or competitor benchmark was run.

## Remaining work

All engines still require evidence-bound audits. Equal labels are not proof: source, account, instrument, interval, candle identity, closed status and observation time must agree. Unknown location, stale reports and failed reads must not become confidence or permission.

Open items include remaining monetary consumers and all-account push, native clock/order/current-state verification, terminal-confirmed-close reversal, slow-CPU chart navigation, broader chart tools/catalogue and real-provider/terminal acceptance. This scoped repair does not close them. No main merge, deployment/Replit sync, database migration/change, worker/trading activation, broker test, order, funds movement or email occurred.

Evidence: `docs/validation/chart-star-identity-20261102/receipts.tar.gz`, bound by manifest.json. Local raw receipts: `/Users/areyouok/arx-tier1-release/chart-star-identity-20261102`.
