# ARX safety and database check results

Verified on 2026-10-23 against the imported upstream-main baseline described in
`ARX_BASELINE.md`. This report supplements that historical import report; it does
not replace its source-provenance or deployment limitations.

## Repairs and classification

| Finding | Classification | Repair |
| --- | --- | --- |
| Ruby traffic selection had no `RUBY` surface entry | Application wiring defect | Include the same advisory departments used by Ruby's signal alignment, retaining the existing participant cap and risk authority. Added participant-selection assertions. |
| Draw-setup test assumed normal server startup had seeded core agents | Test prerequisite defect | Explicitly call the real idempotent core-agent seed and invalidate the registry snapshot before the route test. Existing earned authority/status is not overwritten. |
| Risk-template insert omitted required `created_by` | Fixture defect | Supply the fixture owner's real user ID; remove the type assertion hiding the missing required field. |
| A reused ADMIN fixture occupied legacy owner ID 4 | Fixture collision with an existing application policy | Avoid ID 4 for restricted ADMIN/USER controls, verify their identities explicitly, and leave the legacy application policy unchanged. Never delete a pre-existing ID 4. |
| Fundbook tier checks required canonical BALANCED/CONSERVATIVE pools | Fixture defect | Create two dedicated, paused, zero-capital QA pools and NAV rows transactionally, and remove their financial rows in `finally`. Never alter canonical pools. |
| Exposure-reservation concurrency checks assumed user ID 1 | Fixture defect | Create a dedicated system-test user, pass its returned ID, and remove its reservations/master/user in `finally`. No live access is granted. |
| No-feed and Ruby chat/chart parity network guards expected a provider attempt despite absent credentials | Offline test prerequisite defects | Use dummy provider configuration only inside the installed external-network guard. Preserve the assertions that external requests were intercepted and no feed was fabricated. The reusable parity test removes only its own dummy configuration and resets provider caches. |
| Security regression assumed the shared API had invite-only registration enabled | Test-server configuration defect | Default to an in-process API with the invite gate enabled in that test process only. Keep the real invalid-code/rate-limit assertions. An explicit `BASE_URL` still supports an already configured invite-gated API. The managed API's registration policy is unchanged. |

No risk thresholds, verdict expectations, live execution gates, or no-live-command
assertions were relaxed.

## Verification

All checks were launched through `scripts/run-arx-check.sh`: development database,
dummy loopback AI configuration, broker/bootstrap/provider secrets excluded, and
`ARX_LIVE_BROKER_EXECUTION_ENABLED=false`.

### Full commands, executed once

1. `bash scripts/run-arx-check.sh pnpm run ci`
   - Type checks and preceding guards passed.
   - Shared in-process tests: **523 passing, 0 failing across 18 groups**, compared
     with the baseline's 519 passing / 4 failing.
   - Ruby draw-setup: **53 passing, 0 failing**. Scanner risk **77** produces
     `governanceOutcome="downgraded"` and verdict **`caution`**.
   - The command subsequently stopped at `test:security-regression`:
     **57/58 passing**, with `07d_invite_rate_limit_enforced_on_real_endpoint`
     failing because the shared server's invite gate was disabled
     (`firstStatus=201`, `saw429=false`).

2. `bash scripts/run-arx-check.sh pnpm --filter @workspace/scripts run ci:integration`
   - Official schema provisioning succeeded.
   - Shared in-process tests: **346 passing, 0 failing across 11 groups**, compared
     with the baseline's 342 passing / 4 failing.
   - **73 spawned + 11 in-process = 84 groups reached**.
   - Fundbook tier checks: **33/33 passing**.
   - One-click concurrency: **20/20 passing**.
   - Two groups failed: `test:admin-unrestricted-risk` (legacy ID-4 fixture
     collision) and `test:scanner-no-feed-honesty` (no configured provider attempt).

### Continuation and targeted rechecks

After the full commands exposed the additional fixture problems, those were
repaired without changing the corresponding application policies.

- Ran the **232 previously unreached root-CI steps** in their original order,
  collecting every exit status rather than stopping at the first failure.
  **231 passed initially**; the only failure was
  `test:ruby-chat-chart-read-parity`, whose offline guard had zero provider
  attempts without a configured provider.
- Targeted final rechecks:
  - `test:admin-unrestricted-risk`: **17/17 passing**.
  - `test:scanner-no-feed-honesty`: **4/4 passing**.
  - `test:security-regression`: **58/58 passing**, including the actual HTTP
    invite-rate-limit check.
  - `test:ruby-chat-chart-read-parity`: **20/20 passing**, with **26 intercepted
    external attempts**.
  - Final `@workspace/scripts` typecheck: passed.
  - `git diff --check`: passed.

**No observed assertion failures remain unresolved.** Every listed root-CI step
was reached across the initial run and continuation, and every failing group was
rechecked successfully after its repair. However, the full root-CI and integration
commands were **not repeated after the final fixture fixes**. Their original
aggregate exit codes were both **1**; this is not a claim of a fresh, single-run
green aggregate.

### Remaining validation gap

Root CI invokes `@workspace/api-server`'s
`test:chart-truth-service-bypass`, but that package has no matching script.
pnpm printed `None of the selected packages has a
"test:chart-truth-service-bypass" script` and returned success without running it.
This is a pre-existing missing-check/wiring gap, not a passing test or a repaired
application feature. The separate `@workspace/scripts::test:chart-truth-bypass`
does exist and ran; it should not be assumed to be the missing service check.

## Safety and cleanup evidence

- Restarted the existing API workflow once after the application-code change.
  Startup reported database reachability and **live master switch false**.
- Routed `/api/healthz` returned a healthy ARX AI response, also verified in a
  browser snapshot. No dashboard or sign-in changes were made by this work.
- Final development-database counts:
  - `arx_live_commands`: **0**.
  - Dedicated tier QA pools: **0**.
  - Dedicated concurrency QA users: **0**.
  - Dedicated concurrency QA master accounts: **0**.
- The security suite also confirmed zero live-command delta and cleanup of its
  seeded users.
- No production database, real model request, live-money order, production
  deployment, or shared workflow registration-policy change was performed.
- Existing legacy risk-test fixtures may persist; their broader state-restoration
  hardening remains separate follow-up work.

Detailed run logs were written under `/tmp/arx-task2-*.log` in this development
session. They are transient diagnostics, not committed project assets.
