# ARX development checkpoint — 27 October 2026

The owner requested that all committed work be saved to GitHub and the Replit development workspace before remaining usage is exhausted. This is a development handoff, not a production release or a claim of TradingView/MT5 parity.

## Source and validation boundary

The combined application source is commit `273103076237a9bcc9bfbf0222b03e19e6211d5b` on `codex/platform-evidence-integration`. This document is a subsequent documentation-only checkpoint.

The last **fully validated combined** ancestor is `69c9eec9a089d18a5f2ef410f7d15e9f4dbddfc0`: 1,747 frontend tests and 1,360 backend/database checks passed, with 9 frontend and 10 backend optional checks skipped. Four workspace typechecks, 87 guards, both production builds and seven offline desktop/mobile browser checks passed. Those counts apply to that ancestor, not automatically to the newer combined source.

The newer combined source includes these separately reviewed and tested slices:

| Change | Original commit | Evidence and remaining limits |
| --- | --- | --- |
| Plain-English changes and timestamps for older chart readings | `1818df263770e5bdda4eb4dab73117d56ebe59ab` | 87 focused checks, types, dashboard build and desktop/mobile checks passed. |
| Feed labels agree with freshness evidence | `07126af52fad0881aba1a8c79d856c9e53a76d66` | 1,751 frontend tests passed, 9 optional skipped; four typechecks, dashboard build and desktop/mobile checks passed. |
| Exact MT5 terminal target preflight and capability gate | `6b4a9dfcafca063d5b269402715afb8c83ee9097` | 104 required isolated database checks, 105 extracted-handler assertions, 56 existing offline core assertions, 28 focused checks, guards, API types/build passed. Native terminal and broker behavior remain unverified. |
| Missing chart Truth measurements stay unmeasured | `ac3473bf05a807a3af53586a22bc7d801d876fb6` | 22 focused checks including generated-schema roundtrip, API types/build and independent review passed. Missing evidence cannot earn points. Numeric broker comparison alone does not establish account identity or freshness. |
| Replay preserves native disclosure keyboard controls | `273103076237a9bcc9bfbf0222b03e19e6211d5b` | 10 focused component tests passed. Combined browser validation remains pending. |

**The final combined source still requires a full combined validation.** Component results are not a substitute for it. Keep the integration PR draft until the required checks and review are complete. No aggregate architecture completion percentage is established.

## Included systems

- Scanner: bounded concurrent reads, request sharing, source/context isolation, selected-market responsiveness, closed-bar and stale-feed checks, saved screens and lifecycle corrections.
- Smart Chart: zoom/pan, Replay, configurable studies, drawing controls, layouts, automatic plain-English readings, supported pattern annotations and evidence disclosure.
- Truth: source and freshness handling, evidence expiry, server/client validation, and explicit missing-measurement coverage.
- Self-trading: dispatch/capacity safeguards, accounting and settlement evidence, outbox processing, position targeting and terminal management preflight. These offline checks do not establish real execution correctness.
- Profit Mission/research: causal historical evaluation and owner-scoped append-only research evidence. Prepared database migrations are not permission to apply them to an existing database.

The candle catalogue covers 65 of the owner's 104 requested names, with 62 definitions across 16 families; 39 names remain pending. The competitive scorecard retains 41 capability rows with no invented aggregate percentage. Native MT5 validation, real broker behavior, durable terminal result recovery and measured competitor performance remain incomplete.

## Held experiments — GitHub backup only

These branches preserve useful research history but are deliberately excluded from the combined source and Replit installation:

| Branch | Commit | Reason held |
| --- | --- | --- |
| `codex/chart-replay-earned-checkpoints` | `418148b76bb9ba0c3801605893058baec09dec2e` | Original eager checkpoint experiment. |
| `codex/replay-cache-combined` | `07a24664273530ad4eff8ee68bc0667769047e5b` | Warm completion improved but remained over the 100 ms p95 target; 40 fresh-session cold completion p95 regressed from 162.7 to 217.2 ms. |
| `codex/replay-checkpoint-packing` | `f59ebe311c17af9014477075250d9b0c426bdfc3` | 40 fresh sessions per build: first-reveal completion p95 153.9 to 150.7 ms; first rewind regressed from 46.7 to 130.5 ms. All 160 chart/reader witnesses correct, but latency failed. |
| `codex/chart-reader-lazy-details` | `31635038690f5a601ccb5ff087d8bb4d77d57905` | Lazy disclosure candidate, held after matched comparison. |
| `codex/chart-reader-lazy-baseline` | `af4397e4e00692bb2aefa26a5e151470a8b2fb9d` | Matched comparison baseline, not an additional app feature. |
| `codex/chart-reader-lazy-combined` | `6890d835f50f8f5a754fcda3ffd053c38c2d2f15` | Repeated forward-seek completion p95 147.1 to 152.7 ms and 150.5 to 152.2 ms; no improvement. |

Do not combine all saved branches indiscriminately: some contain equivalent changes before cherry-picking and others contain failed experiments. Preserve the raw failed measurements when continuing performance work.

## Local unfinished work

The successor terminal-result evidence work remains uncommitted and is excluded from this publication. Only its extracted-handler check ran (672 assertions); the new cross-language/database tests, types, guards and builds have not run. Two known blockers remain: entry volume loses precision through the legacy float4 mailbox, and result-kind mapping omits supported market-order aliases. The existing validated target-preflight slice does not fix those successor issues.

The local release archive retains the unfinished patch, four untracked files, checksums, detailed receipts, raw benchmarks and the combined-validation runner. Resume from that archive rather than assuming the unfinished changes are in this PR.

## Replit development update

Target: [ARX AI baseline import, @portavainc](https://replit.com/@portavainc/ARX-AI-baseline-import). The connector exposed the older account only, so the update request was sent through the authenticated development workspace in the browser.

Apply the combined source to the nested ARX app after checkpointing and reviewing current workspace changes. Preserve current local fixes, the outer Replit scaffold, launch adapters, dependency/firewall adjustments, sign-out/reset fixes, access-control changes, private backups, secrets and existing disabled trading controls. Do not replace the outer repository with the upstream layout.

Run offline checks and builds before accepting the update. Use disposable isolated databases for database tests. If a required migration is missing, preserve the source and report the blocker; do not migrate existing development or production data as part of this checkpoint.

The update request is not evidence that installation or validation has completed. Obtain the resulting Replit checkpoint and test report before declaring it complete. No main merge, production publication, broker enablement or live/demo order is part of this handoff.
