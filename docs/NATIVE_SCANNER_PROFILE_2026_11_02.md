# Native Scanner diagnostic checkpoint — 2 November 2026

Status: diagnostic tooling verified; **no product speed improvement or broad engine accuracy claim**. The architecture and competitive performance goal remain incomplete.

Exact diagnostic/tooling source: `df0adbcb44392ab72a5d71bd4bb4994b210fd96c`, on `codex/native-scanner-profile-20261102`. Initial tooling commit: `8b090d16929c36044cd1ea90226808c5234f911e`. Application files are unchanged from parent checkpoint `03bb1e66` (last application change `ce7db72c`).

## What changed

The React profiling fixture previously refused native-default builds because its candle timeline was wired to the legacy adapter. It now follows the actual selected adapter, observes the existing native viewport paint method, and records bounded object IDs, candle counts and requested/current/painted revisions. A superseding revision, pending paint, missing frame, destruction or error prevents a completed-paint claim. No prices/account payloads are copied by the timeline and it does not call derived frame/state getters.

The diagnostic driver runs three desktop and three mobile trusted first-link navigations per CPU rate. It checks exact source/canonical/displayed OHLC after settling and requires post-click React commits plus native paint evidence. Every attempt is retained. The separate profiling renderer and loopback port remain diagnostic-only; ordinary acceptance still rejects profiling metadata.

Independent static review found two issues in the first driver: polling snapshots could construct cached frames and distort work attribution, and missing React commits did not reject diagnostic completeness. Both were fixed in `df0adbcb`; the original findings and final file hashes remain in the independent review receipt.

## Validation and findings

- 34 focused tooling checks pass, zero failures/skips. Coverage includes wrong/dirty/overridden builds, missing/pre-click traces, native paint invalidation, wrapper return/error preservation, and ordinary acceptance rejection of profiling.
- Clean diagnostic fixture `f1eff2ff03792274`, exact source `df0adbcb`: 12/12 attempts complete with matching canonical and displayed candles, six normal CPU and six 4x CPU. No page errors or dropped timeline/commit records. Synthetic historical EURUSD M15, 200 bars; fixed 80 ms response; existing setup blocks external APIs and writes.
- Clean ordinary fixture `bc1e6e61f3ae61b9`, same source: build succeeds. All JavaScript assets were checked; none contain the custom `__arxCandleTimeline`, `__arxReactProfile`, or `native.paint.end` markers. Ordinary metadata remains non-profiling with no timeline engine.
- No tests/builds overlapped browser diagnostics. Owned browser sessions and both local diagnostic server processes were stopped; all known process handles exited.

These ranges describe diagnostic work, **not acceptance latency**:

| Observation | Normal CPU, six samples | 4x CPU, six samples |
| --- | ---: | ---: |
| Native first completed paint method duration | 0.5–0.8 ms | 2.5–3.6 ms |
| Click to that paint's return | 50.9–68.6 ms | 249.0–340.7 ms |
| Largest React root render before that paint | 12.4–14.3 ms | 56.3–66.9 ms |
| Recorded effect duration for that commit | 10.6–12.8 ms | 45.6–55.9 ms |
| React commits before that paint | 5 | 5–10 |

The main lead is page mounting, commit effects and subsequent updates before paint, rather than time spent inside the draw method. This is a candidate direction, not causal proof about a specific component. Nested/bailout fiber durations cannot be added, and these logs do not time all JavaScript, layout or frame preparation. One throttled attempt received parsed candle data after the click; it remains in the results.

## Retained failures and limitations

Initial fixture `c4e40030d20b3d4f` was built before the driver review fixes and was not used for final diagnostics. Fixture `db74c73df29db18f` included two untracked browser output files in source status; it is excluded. Those files were moved into the evidence directory, then a clean fixture was built. Initial unauthenticated local navigation produced expected unavailable-route console entries; retained separately from the final offline fixture runs.

Viewport IDs correlate objects; they do not assign individual HTTP responses or batched set calls one-to-one to paint. Active-tick updates are not instrumented. React profiling and observers add overhead. Resources were primed by setup; this is not cold process startup. Final readback follows a settled frame, not first source-correct visible completion. No physical paint, real device, provider, deployed app, broker or competitor comparison was measured.

This tooling-only change did not rerun full application CI/typechecks/guards or ordinary navigation acceptance. Prior guard failures and throttled first-navigation acceptance failures remain open; historical passing results are not attributed to this new commit. No performance candidate was installed and neither held performance branch was restored.

## Next work

Inspect route-mount layout effects and repeated updates using the recorded commits, then test one justified candidate with the ordinary immutable fixture, quiet ABBA runs, exact source/render/visibility checks, all failures retained. Keep the candidate only for repeatable improvement. Continue independent engine evidence audits: qualified session calendars, global session labels, account/currency freshness, and cross-consumer agreement are still open. Live MT5 balance/P&L equality remains unproven.

Evidence: `/Users/areyouok/arx-tier1-release/native-scanner-profile-20261102/`, including raw CLI output, both parsed diagnostic reports, `diagnostic-summary.json`, ordinary isolation checks, build manifests and `independent-review.json`.

No main merge, deployment/Replit sync, existing database changes, trading/worker enablement, or broker tests.
