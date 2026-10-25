# Owner instruction: replace the ARX scorecard (2026-10-25)

The owner (Portava) gave this instruction on 2026-10-25 in the project thread.
It is kept as given. It authorizes ARX Tier 1 Scorecard v2 and retires the
original scorecard. The rubric (`rubric.json`) cites it.

> Fix the recurring ARX scorecard blocker. I authorize creating a replacement scorecard and establishing a new baseline. Do not ask me again for the missing original scripts, metrics, rubric, or dashboard link.
>
> 1. Retire the missing dependency: Record the original scorecard as unavailable. Preserve 68.7% as a historical reported result only. The replacement is "ARX Tier 1 Scorecard v2"; its results are not directly comparable with that percentage.
> 2. Build a reviewable rubric: Derive criteria from the existing Tier 1 requirements, architecture documents, owner decisions, and outstanding findings. Cite the source for every criterion. Include unresolved requirements, not just implemented features. Separate: Architecture and code implementation. Verification and regression evidence. Deployment and operational readiness. Use PASS, FAIL, UNKNOWN, and explicitly justified DEFERRED statuses. Missing evidence is UNKNOWN. Guard counts alone cannot establish architectural completion. Preserve approved deferrals such as keeping the physical position tables behind the ledger; state their scope accurately. Commit the rubric before measuring. Do not change criteria or weights to improve the result. Prefer counts and completion gates over a weighted percentage unless the documented requirements justify weights.
> 3. Deliver the replacement: Store the rubric, measure.py, build_csv.py, generated metrics JSON/CSV, and a readable dashboard in the repository. Use repository conventions for locations and commands. The dashboard must work locally without an external service or missing link. Show the measured commit, measurement time, each criterion's evidence, unresolved items, and separate code and operational verdicts. Measurement must be repeatable and read-only. Unknown production facts stay UNKNOWN; never query or modify production implicitly. Keep generated timestamps separate from deterministic result data.
> 4. Establish an honest baseline: Measure current main and record its exact commit. Validate that the scripts handle missing evidence and failed checks correctly. Preserve the six reported integration failures individually until their current status and baseline comparison are verified. Explicitly evaluate the outstanding order-path enforcement, heartbeat close policy, My Trades DEMO idempotency, and other documented gaps against current code. Do not assume they remain open or were fixed. Report implementation completion separately from operational readiness. State the precise unmet gates behind any TIER 1 NOT COMPLETE verdict. Do not treat an approved future project as a current blocker unless an applicable requirement makes it one.
> 5. Finish the handoff: Open a PR containing the replacement and baseline. Update the owner runbook and handoff documents so future agents use v2 and stop requesting the original artifacts. Include one command to regenerate the scorecard and the dashboard's repository path.
>
> This authorizes scorecard tooling and documentation changes. Do not deploy, change production data, arm live trading, or place broker trades. Preserve the older uncommitted Codex worktree.
>
> Finish with the PR link, measured commit, baseline results, and concrete remaining actions—not another request for the old scorecard.

## The six reported integration failures

"The six reported integration failures" are the suites that failed in the
`ci:integration` lane (local database) in the round 5 verification on
2026-10-25. They failed both on `32033c6` (main before round 5, checked in a
separate worktree) and on main after round 5, so round 5 did not cause them.
The lane then ran 132 tests (121 spawned, 11 in-process).

| Tracked id | Suite | Reported failure |
|---|---|---|
| INT-1 | `@workspace/scripts::test:admin-unrestricted-risk` | exit 1 |
| INT-2 | `@workspace/scripts::test:chart-decision-receipts` | 14/15; "overtrading detected" assertion fails |
| INT-3 | `@workspace/scripts::test:mode-scope` | exit 1 |
| INT-4 | `@workspace/scripts::test:one-click-concurrency` | foreign key `arx_dispatch_exposure_reservations_user_id_users_id_fk` on the local database |
| INT-5 | `@workspace/api-server::test:scanner-no-feed-honesty` | exit 1 |
| INT-6 | `@workspace/scripts::test:ruby-draw-setup-route` (in-process `rubyDrawSetupRouteTest`) | 49 passed, 4 failed (governanceOutcome / verdict) |

The scorecard keeps each one as its own verification criterion until it
passes. A failure outside this list fails the integration-lane criterion.
