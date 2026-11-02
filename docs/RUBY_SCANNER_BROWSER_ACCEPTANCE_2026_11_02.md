# Scanner assessment browser acceptance — 2 November 2026

Tested application checkpoint: `bb928044cfa7cb98a3d6a80213b25f1b74e2da1e` (application change `ff25250f3b9eb670f3ac1f5d5510b720c04ef849`). Immutable clean production fixture: `2d61c4ee718afc98`; native-default engine, no profiling renderer or source override. This report adds no application changes. Overall release and competitive chart goal remain incomplete.

## Browser evidence

The actual dashboard entry, scanner route, React providers, chart renderer, truth hook, read panel and read store executed in isolated desktop Chrome. All API calls were intercepted. The existing setup supplied explicitly synthetic historical candles and disabled trading. A local stub intercepted only the exact read-chart POST to control completed and delayed assessments; no real backend or broker handled it.

The corrected final run passed 13 checks: exact build/source; native canonical/display series agreement; completed assessment visible; HTF-only correction withdraws it; primary candles remain unchanged; request loading; next HTF-only correction removes pending authority before response release; delayed old response remains absent; new matching reread succeeds; the read panel's Prepare Trade button remains disabled; no external/unexpected mutation attempts; no page errors. A separate check compared every one of 200 source OHLC bars against the applied native canonical and displayed series and passed.

Both dependency revisions were detected by the actual hook's configured polling. This is not an immediate-push or latency benchmark. Captures were synthetic EURUSD M15 primary with H1 dependency; no price correctness or pattern-detection accuracy was inferred.

Final network receipt: 131 intercepted API requests, 4 blocked background/analysis mutations, zero external attempts and zero page errors. Unimplemented fixture reads returned 503 and remain listed in the receipt. The exact locally mocked read-chart POST is separately recorded; it is not counted as a server mutation or a trading action. Other BUY/SELL ticket controls were neither clicked nor validated.

## Retained failure and limits

The first run passed functional checks but failed its final network classification because the new check listed `/api/me/presence` instead of the existing blocked `/api/me/activity-ping`. The established acceptance script already identifies activity-ping as background. The corrected classification still requires it to remain blocked. Original report, script and screenshots are retained; the final run used a fresh browser session.

This does not validate backend-to-browser production delivery, provider truth, HTF calculations, real quotes/accounts, mobile behavior, every chart control, general engine correctness, or the running Replit version. Source identifiers and assessment replies are explicit fixture values. The global session label and other independent FVG/quote/account revision gaps remain open. The UI remains far more extensive than the one lifecycle checked here. No TradingView/MT5 parity or release-green claim.

Evidence directory: `/Users/areyouok/arx-tier1-release/ruby-scanner-browser-20261102/`. It contains the immutable build manifest, setup/driver/source-comparison scripts, raw reports, screenshots, receipts and independent review. The build assets remain in the ignored fixture output for the recorded build. Owned browser session was closed and the uniquely identified loopback fixture process was terminated; its handle returned terminal.

No main merge, deployment, Replit sync, existing database changes, trading/workers, broker/live/demo tests or messages to another chat. The separate performance patch was not integrated. No application test results from another checkpoint are attributed to this report.
