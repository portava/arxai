# Master account evidence and real-time funds follow-up

Status: bounded display repair, **not release-green or real-time funds acceptance**. Development only; no Replit source changes, service restarts, deployment, existing database changes, trading/worker changes, or broker tests.

Application: `837b6ce726440f57da07bfffad2d351473cf4ddf`, based on `1ffeb1222bdb820e3d4f75d71c4a66b6a4a13a48`. Guard-only follow-up: `748b7ab4216c6cab06e2a90432b7655e24b836b9`. Final explanatory copy/comments: `c4244ee37b80f1bf78731f83865d79666afdc4f4`.

## What changed

The owner/admin master view now reads the connection pinned by the same allocation view used by the response. It no longer combines pool money with a second, potentially different pin lookup, or dates account money using generic connection heartbeats. Unknown identity, missing/invalid/future/nonpositive account-update timestamps and nonfinite amounts remain unavailable. Valid finite stored scalars retain their precision, including zero; unknown values are nullable throughout the API schema and generated clients.

Cockpit and Shared Account use the same observation aging and disclosure. Repeated successful requests and clock rollback cannot renew the same observation. Server stale remains stale; the display ages without requiring another response. Master figures say stored/unverified, carry the last account-update time and never borrow a user's live badge. Derived master P/L and its circular reconciliation were removed. Recorded trades are described as ledger records, not a complete current broker position count. Currency formatting uses the reported currency or explicitly marks it unverified.

Missing master data no longer falls back to a user's money. Missing canonical allocation headroom no longer falls back to virtual balance or zero. Refresh copy describes a stored-data reload, not a request for a fresh broker report or proof that the bridge is offline.

The existing 60-second account-update cutoff moved to the same shared pure module as the unchanged 5/30/120-second display bands. The guard requires all four exact values and real named server reexports. Negative fixtures reject changed/missing/duplicate values, extra executable code, false exports and local imports shadowing protected threshold names. No allowlist or execution threshold changed.

## Important correction from the subsequent funds audit

The original review inferred a possible balance-only/equity-only heartbeat from the handler's OR condition. That inference was too broad: the current heartbeat and sync-account validators both require balance **and** equity, and the inspected current production writers use those validators. Earlier raw review notes are retained as history, not current findings.

The concrete remaining partial-field problem is optional/ignored margin, currency and other fields, which can retain older values or defaults. The persisted marker does not date every field or identify a versioned full report. Direct MT5 account profit is absent from the current stored master view. Final copy correctly requires a verified broker profit report rather than suggesting a paired balance/equity report alone establishes account P/L. MT5 exposes profit, credit, equity and balance as separate properties: [official AccountInfoDouble reference](https://www.mql5.com/en/docs/account/accountinfodouble).

## Validation and retained failures

| Evidence | Source | Result |
|---|---|---|
| Full frontend | `837b6ce7` | 3,700 pass, 0 fail, 11 skipped; 220 passing files, 1 skipped |
| Account projection/route/schema tests | `837b6ce7` | 46 pass, 0 fail, 0 skipped |
| Library, API and dashboard typechecks | `837b6ce7` | Pass |
| API and dashboard builds | `837b6ce7` | Pass |
| Full guards | `837b6ce7`, guard follow-up `748b7ab4` | 85/87; same 38 wording and 3 internal-name violations as baseline |
| Guard negative fixtures | `748b7ab4` | Pass; import-shadow fixture failed before correction |
| Four affected frontend suites and dashboard build | `c4244ee3` | 74 pass; build pass |

Fail-before receipts include the original cockpit regressions, nullable/shared-card failures, six route/projection regressions, three precision regressions, two timestamp regressions and seven later fallback/refresh-copy failures. A test-selector error, the initially failing shared-authority guard, and the independent review's import-shadow probe are retained. Do not sum these overlapping runs into a unique bug count.

Independent backend, frontend and guard review receipts are archived. Route tests execute extracted actual handlers with inert dependencies and generated validators; they are not real HTTP/database or broker proof. Frontend tests render components with mocked inputs and clocks; they are not acceptance of the authenticated Replit app. Builds retain their normal chunk-size warnings. Full root CI, real database integration, provider/terminal matching, and new performance comparisons were not performed.

## Still required for the owner's immediate monetary updates

- Preserve native MT5 monetary fields with appropriate precision and explicit account identity, source time, receipt time and ordered report identity. Do not substitute equity minus balance for reported account profit.
- Inspect and repair the EA-to-server contract: v154 constructs a richer nested account snapshot while the legacy heartbeat parser accepts only a subset. Its default account heartbeat interval is 15 seconds, and the timer uses [quote-driven `TimeCurrent()`](https://www.mql5.com/en/docs/dateandtime/timecurrent). Two-decimal EA serialization and float4 account columns can also lose precision; preserve the reported `ACCOUNT_CURRENCY_DIGITS` rather than assume currency display precision. See the archived `funds-pipeline-audit.txt` for exact source references and existing Bridge V2 receipt reuse options.
- Deliver committed account changes across API processes and to all authorized viewers of the affected account. The current advisory bus is process-local and user-keyed; master cards still poll at 3/5 seconds. Any trader's change must refresh the corresponding shared account without leaking other users' data.
- Reuse the existing account pipeline and streaming infrastructure. Preserve separate user allocation and broker-account meanings. A fresh transport message must not silently renew old broker evidence.
- Measure terminal observation to server receipt, persistence, event delivery and visible render separately. Retain missed updates, reconnect gaps, out-of-order delivery and latency outliers. No zero-delay or actual broker-latency claim is established here.
- Persist per-field/full-report evidence before promoting these master values to live. The pool/allocation/execution readers still use their previous evidence rules; this display repair does not certify those paths. Cached Eleanor identity/order/expiry, actual preview acceptance and TradingView/MT5 comparison gaps also remain open.

Raw receipts: `docs/validation/cockpit-master-truth-20261101/manifest.json` and its verified archive. Original owner brief and prior failure history remain intact.
