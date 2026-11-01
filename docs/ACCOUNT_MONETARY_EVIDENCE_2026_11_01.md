# Account money: observation timing and P/L evidence

Combined application **`c1ea3ba99c45e3c338b2ea8bfe413c04fd3f4baf`**, based on `5e40597f`. Development only; **not release-green, not installed in Replit or an MT5 terminal, and not proof of instant broker matching**. The broader Smart Chart/TradingView/MT5 objective remains incomplete.

The owner requires ARX's corresponding account figures to match MT5, including changes initiated outside ARX. Matching needs the same account, currency, observation and precision. ARX allocations remain separate from broker account totals. This increment repairs concrete scheduling and false-assurance defects; it does not implement the missing full native report.

## Changes

Telemetry commit `9c8bff5abde296588d813eddc592ff50d4fe1d89` changes only v154 heartbeat and Beta account-snapshot elapsed scheduling to `GetTickCount64`. They continue when quote time is zero, frozen or moves backward. Attempts remain bounded, missed intervals coalesce, and missing configuration stays idle. Normal intervals remain **15 seconds / 10 seconds**. An attempt stamp is not evidence of delivery. Command, config, position/book and chart scheduling are unchanged; no faster end-to-end rate is claimed.

Profit application `2c60cb1a` ports independently reviewed `02202e4f18bc893633dec9030fc82bc661cfb03d`. Equity minus balance is no longer treated as authoritative account profit or proof that a position sum reconciles. The existing snapshot reports the missing native comparison explicitly. Finite individual broker values remain available; missing, nonfinite, future-dated or incomplete aggregate evidence cannot become a complete total. Invalid aggregate timestamps cannot crash the allocation composer.

The existing shared hook, Cockpit, allocation panel, Open Trades and Ruby strip distinguish supplied-position diagnostics from account-wide money. Missing completeness flags fail closed. A withheld total cannot be revived by the Open Trades fallback; partial card sums cannot claim net account profit. Unverified/estimated sums carry neutral styling and explicit currency uncertainty rather than fabricated dollar precision. Pending or missing realized-P/L evidence withholds the corresponding total.

Existing SSE/reconcile, account-shell, admin and Ruby projections retain the same scope/completeness metadata through the existing wire adapter. No extra balance engine, query, provider or event connection was added. Numeric completeness alone never establishes common account/currency scope: the producer explicitly emits `monetaryScopeVerified:false`, so derived allocation money stays unavailable in the affected panel until real evidence exists. Test-only true-scope fixtures isolate other conditions; they are not runtime proof.

Legacy internal allocation arithmetic retains a known partial subtotal only with the new producer's explicit diagnostic provenance. For supplied P/L `[-10, unknown]`, allocation 1000, reserved risk 100 and realized P/L 20, the read model retains equity 1010, free 910 and available 890, while floating P/L and unqualified derived displays are withheld. The execution-consumer trace found no modified gate: mode resolution skips the investor snapshot, and the master pool reads its own loss rows. This is not a new account or risk authority.

## Exact combined validation

All rows below concern application `c1ea3ba9`; clean source and matching head were recorded before and after the run.

| Check | Result |
|---|---|
| Full frontend | 3,746 pass, 0 fail, 11 skipped; 223 passing files, 1 skipped |
| New account-profit backend lane | 33 pass, 0 fail, 0 skipped |
| Account stream/session/producer lane | 35 pass, 0 fail, 0 skipped |
| Account projection/contracts lane | 46 pass, 0 fail, 0 skipped |
| Legacy snapshot adapter | 27 pass via direct Node loader; see launcher failure below |
| Extracted MT5 offline lane | 56 demo-core, 105 management, 60 candle-producer and 48 account-timer checks pass |
| Bridge package | 5 pass, 0 fail, 0 skipped |
| API/dashboard typechecks and builds | Pass; existing build warnings retained |
| Guards | 85/87; exact same 38 wording and 3 internal-name findings as the prior checkpoint |

The first legacy adapter invocation could not start the `tsx` CLI's local IPC pipe (`EPERM`), so no assertion ran. The same script passed through the direct Node loader on the same commit. Both attempts are retained; the original runner exit is not relabeled green. The full root-CI command, real-database integration, browser acceptance, native MetaEditor compilation and broker runs were not performed.

Before evidence includes 15 failures/1 pass in the initial profit backend cases and frontend failures with one explicitly corrected invalid test selector. The original investor composer fixture caught a stale diagnostic-subtotal regression during implementation; it was fixed before integration and its 24 extracted assertions passed. These are isolated-agent results, not an additional combined root-CI run. The timer test initially failed to compile because its C++ alias was missing; after fixing the harness, prior EA sources failed 14 of 22 assertions each. Those include cascading checks, not 28 independent bugs. Final timer coverage is 24 checks per EA; four semantic mutations were caught by runtime assertions. Both independent reviews and all intermediate failures are archived.

## Verified competitor basis and remaining gaps

MT5 exposes balance, credit, profit, equity and margin as distinct native properties, and provides broker currency display precision. The account report must preserve these facts rather than infer profit from other totals. [Native properties](https://www.mql5.com/en/docs/account/accountinfodouble), [account currency precision](https://www.mql5.com/en/docs/constants/environment_state/accountinformation).

MT5's `TimeCurrent` in a timer callback follows the last quote; `GetTickCount64` measures elapsed system time. These documented semantics support the telemetry repair; they do not certify its terminal runtime. [Quote clock](https://www.mql5.com/en/docs/dateandtime/timecurrent), [elapsed counter](https://www.mql5.com/en/docs/common/gettickcount64).

TradingView's documented trading integration pushes equity and position P/L updates when values change. This is an interface capability, not a measured speed result for any broker. ARX currently has process-local change hints followed by canonical reads; end-to-end parity is unproven. [Trading flow](https://tradingview.com/charting-library-docs/latest/trading_terminal/trading-concepts/), [Trading Host updates](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IBrokerConnectionAdapterHost/).

Next implementation must reuse the existing Bridge V2 receipt store and Broker Hub reader for a complete versioned native report: profit, credit, precision, identity, capture/receipt times and ordering. The archived read-only audit identifies discarded fields, float4/two-decimal loss, duplicate-driven apparent freshness, future-clock handling, reset/competing-stream ordering, newer rejected reports hidden by older accepted reports, and HTTP-200 rejections incorrectly treated as producer success. **That contract, producer and selector are not implemented by this increment.**

Native report publication, faster bounded capture, distributed delivery, recovery, actual MT5 equality and observation-to-screen latency remain open. Other monetary readers and estimate conversion conventions remain broader audit work. No new chart performance measurement, TradingView/MT5 parity, architecture percentage, deployment or trading readiness is claimed. Prior slower-device navigation, heavy-history, AI and chart comparison gaps remain active.

Receipts and source hashes: `docs/validation/account-monetary-evidence-20261101/manifest.json` and its verified archive, including the complete native-report audit. No main merge, deployment, Replit edit/restart, existing database change, EA installation, worker activation or live/demo broker test occurred.
