---
name: full-ci chain-order + non-diff red classification
description: How to honestly read/classify a full-ci (pnpm run ci) failure in this repo without fake-green or false-blocking.
---

# full-ci chain-order + red classification

`pnpm run ci` (the `full-ci` validation lane) is a single ~200-command `&&`-chain.
It **short-circuits at the first failing command** — every command after it never
runs. So "the suites that ran all passed" is NOT "the lane is green," and the
platform validation SUMMARY's "all other commands executed successfully" only
counts the commands that ran before the failure. Find the real failure at the log
tail via `ELIFECYCLE` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `Exit status 1`.

**Only one suite in the ci chain, `test:security-regression`, hits the persistent
api-server workflow at `http://localhost:80`** (BASE_URL default). Every other
HTTP test in the chain boots its own in-process server. So if security-regression
fails with uniform `status=502`, the api-server **workflow was down/unreachable**,
NOT a code regression — restart `artifacts/api-server: API Server`, confirm proxy
`healthz=200`, and re-run to get past it. (It passes 58/58 once the server is up.)

**Classifying a deeper full-ci red:** re-run that ONE failing suite in isolation.
- Identical failure in isolation ⇒ NOT a full-ci-load transient. It's a HEAD-level
  failure (pre-existing or introduced by a later merge) or a persistent provider
  issue — not env-saturation.
- Then attribute by diff scope: `git show --name-only <commit>` + grep the failing
  area. If the failing test + the source it exercises are outside the audited
  commit's files, it is NOT that commit's regression.

Live-provider-dependent Ruby/assistant tests (e.g. `rubyFeedNotConfirmedTest`)
degrade under external rate-limiting (twelvedata `429`). But a tool returning
`ok:false` **even for the mt5_broker-served CONFIRMED case** is a code-level issue,
not merely rate-limiting — distinguish the two before calling it "environment."

Two more full-ci flakes classified in practice (both env, both re-run green):
- `ruby-chat-chart-read-parity` "a verified feed yields a real read (got insufficient)"
  fires when external providers 5xx (FRED/others `503`) during the run so the feed is
  unconfirmed → read collapses to INSUFFICIENT. Re-run in isolation returns 20/0
  ("got ok") once providers respond. Feed-dependent, not a regression.
- `brokerCandleCoverageRoute` (registered LATE, ~18th, inside `test:ci-inprocess`) can
  fail with authed admin/owner minted-session requests returning `401` (rejected as
  anon) + cascading "got undefined". This is a **shared in-process app SESSION-STATE
  ordering flake** — an earlier ci-inprocess test in the same process poisons auth
  state. Tell: it does **NOT** repro when the suite is run STANDALONE
  (`test:broker-candle-coverage-route`, own process) — standalone it passes or just
  hangs on DB handle (exit 124 from bash), never 401. So a 401 seen ONLY under
  ci-inprocess ⇒ cross-test pollution, not a schema/auth regression of that suite.

**Why:** a verify-and-report task must neither fake-green (claim the un-run tail
passed) nor false-block (leave a sound commit blocked on a pre-existing/unrelated
failure it is forbidden to fix). Separating chain-short-circuit + env-server-down +
provider-flake + real-code-regression is what makes the classification honest.

**How to apply:** on a full-ci red — (1) locate the exact failing command at the
log tail; (2) if security-regression 502s, restart api-server + re-run; (3) re-run
the failing suite in isolation to separate load-transient from persistent; (4)
attribute via diff file scope; (5) report per-command PASS/FAIL and never describe
the un-run tail as green.
