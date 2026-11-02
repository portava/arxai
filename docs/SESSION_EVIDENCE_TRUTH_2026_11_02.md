# Session evidence and final confidence limits — 2 November 2026

Application: `ce7db72cc8d82ae23986ff4773010ad460c9d540`.
Base: `3fd08a46ac0d78c2f7791ba3c8f599049a281aba`.
Branch: `codex/session-evidence-truth-20261102`.

Verdict: scoped accuracy repairs verified offline; not release-green or architecture/competitor completion.

## Reproduction and behavior

The combined intelligence reader inferred London/New York/overlap/Asia from a candle's printed UTC hour, although its source clock could be unverified and no venue/session calendar was supplied. Missing or invalid time became `synthetic_continuous`. That inferred session could contribute a positive timing nudge.

The reader now reports an unknown session for non-synthetic instruments until qualified session evidence exists. An exact `synthetic` asset classification retains its continuous classification; substring matches no longer qualify. This is deliberate withholding, not a completed session-calendar implementation. Even original UTC time alone would not establish market hours or liquidity.

The shared timing contract represents an otherwise-positive assessment with an unknown session as `unverified`: confidence/quality are withheld using the existing zero/none representation, timing approval is false, and no positive edge adjustment is added. Known adverse/wait conditions retain their statuses. Missing/unrecognized runtime session values also become unknown. The explanation does not blame a live feed merely because the session is unknown. The shared intelligence badge says “Session unverified,” with a neutral tone; confluence treats that timing evidence as missing.

Gold no longer defaults an unknown or synthetic session to New York. Its timing result preserves `unverified`. Independent review then found that the Gold strategy composer could add a macro adjustment after a zero timing ceiling, producing confidence 5, or bypass that ceiling in its blocked return, producing 20. All final return paths now respect the lowest macro/risk/timing ceiling after adjustments. A second review probe found an infinite raw tactic score could be normalized into confidence 100; raw scores and caps must now be finite within the existing 0–100 score domain or the result is withheld with a warning. Fractional ceilings are not rounded upward. This validates existing advisory score bounds, not a new calibrated probability or AI-entry confidence policy.

## Exact validation

- Initial session suite: **1 pass / 12 fail**, then **13/13 pass**. Four runtime missing/unrecognized-session cases were added afterward.
- Gold composition reproduction: **35 pass / 6 fail**. The independent probes preserve the 5/20 confidence leaks and infinite-score result. Subsequent invalid/fractional tests remain in the permanent suite.
- Final backend: **89 pass / 0 fail / 0 skipped** across actual session/intelligence composition, Gold and captured-source cases. Independent final session/intelligence/Gold run: **83/83 pass**, nine source hashes matched the application commit; no scoped review findings remain.
- Final full frontend: **4,730 pass / 0 fail / 12 skipped**. Shared-library, API and dashboard typechecks pass. Both production builds pass. Existing DOM navigation, build source-map and large-chunk warnings are retained.
- Guards: **85/87**, same 44 normalized failure-output lines as the preceding checkpoint. All three supplemental fixtures pass. Full root CI was not run.
- Earlier successful checks preceded the final Gold numeric-input repair and are retained as intermediate results. Final acceptance uses `*-accepted.log` receipts and the final source hashes.
- No browser, live-feed, broker, calendar-validation or performance acceptance is claimed on this commit.

## Remaining work and scope

The actual combined intelligence reader is repaired. Existing callers that explicitly supply named sessions remain responsible for their evidence; those callers are not universally qualified by this patch. No production caller of the standalone Gold strategy evaluator was found during review; its repair is library correctness evidence, not a deployed screenshot fix. The global application session header and other session engines are not covered by this result.

Next: introduce source-bound session-calendar evidence with venue, holiday and daylight-saving handling where applicable, and validate its display against the same observation as the chart. Keep unknown where that evidence is absent. Broader account/currency identity, stale balances/P&L, original-clock authority, AI calibration, trusted native-chart performance and competitive features remain open.

Raw logs, source hashes, failed runs and independent probes: `/Users/areyouok/arx-tier1-release/session-evidence-truth-20261102/`.
No main merge, deployment/Replit sync, existing-database mutation, worker/trading enablement or live/demo broker tests.
