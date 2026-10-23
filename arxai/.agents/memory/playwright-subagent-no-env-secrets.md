---
name: Playwright testing subagent cannot read env secrets
description: Real-browser owner/admin QA can't log in via env creds inside runTest; use server-side harness instead.
---

The Playwright `runTest` subagent runs in its own notebook where
`process.env.QA_OWNER_EMAIL` / `QA_OWNER_PASSWORD` (and other secrets) are
**undefined**. A test plan that says "log in using the env credentials" will
report `unable` ("credentials not available inside the Playwright notebook"),
and a run that *claims* it logged in without them is unreliable (likely
hallucinated) — do not trust a browser-login "success" that had no real way to
obtain the password.

**Why:** secrets are not propagated into the testing subagent's environment, and
the no-secret-echo rule forbids pasting the password literal into the test plan.

**How to apply:** for real owner/admin authenticated QA on the running preview,
use a **server-side script** that reads the env directly and never echoes it
(e.g. `scripts/src/qaTimingHarness.ts`, run via `pnpm --filter @workspace/scripts
run qa:timing-harness`) for real exact-ms timings, and `curl` with
`jq -nc --arg e "$QA_OWNER_EMAIL" --arg p "$QA_OWNER_PASSWORD" '{email:$e,password:$p}'`
+ a cookie jar for authenticated endpoint round-trips. Reserve `runTest` for
unauthenticated/public flows or flows where you can register a throwaway user.
App-preview screenshots still prove real cross-viewport (mobile/desktop)
rendering of the running app.
