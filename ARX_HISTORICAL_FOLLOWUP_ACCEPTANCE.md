# Historical selected-trade browser acceptance

## Outcome

Historical follow-up acceptance is complete against the original frozen actual
Scanner build `28ccd598d091581c`, source
`e4bbba1e2bdccda166566892d0e7600a4bea8cf4`. No application, observer, shared
fixture, API, database or active runtime behavior was changed.

| Completed journey | Checks | Assertion failures |
|---|---:|---:|
| Desktop 1440×1100, new attempt 7 | 37 | 0 |
| Phone-sized browser 390×844, new attempt 2 | 37 | 0 |

These are two completed viewport-qualified journeys, not 74 distinct features.
The phone case is responsive Chromium, not physical-device/touch acceptance.
Fibonacci acceptance remains separate and was not rerun.

Both journeys verified:

- Exact build/source identity and pinned shared-setup hash; fulfilled synthetic
  EURUSD/M1 identity and all 160 installed candle timestamps/OHLC values.
- A real historical Worker calculation, selected Trade row and `aria-pressed`,
  missing-selection refusal and simulation/non-execution caveats.
- Exact parsed exported snapshot equality (sample, result, ledger and complete
  configuration), all input/select values, displayed result and trade selection
  before/after polite explanation and unsupported compound-action refusal.
- Real UI/Worker positive (+0.89065522), exact zero (0), and negative (-0.002)
  net price-unit scenarios, with honest answers for each. Costs were changed
  through the existing editor, not by substituting results. Full-precision
  exported ledger values were needed to construct exact zero.
- Closing the workbench withholds its old explanation.
- Withdrawing clock evidence withholds the explanation but leaves the frozen
  result inspectable. Restoring qualified clock evidence restores the matching
  explanation. Independently replacing source identity then withholds it.

## Failed attempts are preserved

The original `browser-desktop` 3-pass witness-timeout,
`browser-desktop-correction` 7-pass row-locator-timeout, their programs and
provenance, the original summary and the Fibonacci failure are unchanged.
The nested workbench-scoped row filter was corrected in the new harness by
ascending from the actual Trade button to its ancestor row.

New desktop attempts 1–6 and phone attempt 1 remain incomplete, not passing
coverage. Their checks at stop were respectively 19/1, 21/1, 21/0, 26/0,
26/0, 26/0 and 26/0 (pass/assertion fail). Operation errors are distinct
from assertion failures. Corrections addressed generated harness assumptions:
default costs, a small nonzero residual, exported schema, reopening the
workbench, asynchronous fixture readers/refetch, and the mobile reload
disclosure. No application behavior was altered to accommodate assertions.
Every new failed browser attempt has DOM, screenshot and network evidence.

## Conversation POST investigation — not a strict allowlist pass

The original background allowlist remains unchanged and **false** in both
completed runs. There were 9 desktop and 6 phone
`POST /api/me/assistant/conversations` attempts, all blocked with 503.
Captured fetch initiation stacks and source inspection trace them to
`ArxAssistantLivePanel`'s panel-open history/bootstrap effect: the unavailable
conversation-list GET is followed by a fallback creation POST.

This is separate from `sendText`'s deterministic local chart-response branch,
which returns before remote conversation/message streaming. The bootstrap
endpoint was neither silently permitted nor assigned fake success.
Repairing that existing behavior is outside this acceptance task.

| Run | Intercepted API requests | Synthetic 200 | Unavailable/blocked 503 |
|---|---:|---:|---:|
| Desktop | 97 | 23 | 74 |
| Phone | 88 | 22 | 66 |

All other mutation attempts also returned fixture 503. No message/model,
provider, broker, order, external-origin or WebSocket traffic was observed.
No existing API/database was used. Known-background strict acceptance is
not claimed; containment and diagnosed bootstrap evidence are reported
separately. This is synthetic, offline functional acceptance, not live data,
model, broker, performance, deployment or release-readiness evidence.

## Reproduction and evidence

Tracked harness:

- `scripts/chart-qa/historical-followup-acceptance.js`
- `scripts/chart-qa/run-historical-followup.mjs`
- `scripts/serve-historical-acceptance.mjs`

With the preserved frozen fixture and its existing Playwright installation:

```sh
node scripts/serve-historical-acceptance.mjs
# In another shell; choose NEW tags so existing evidence is never overwritten.
node scripts/chart-qa/run-historical-followup.mjs desktop new-attempt
node scripts/chart-qa/run-historical-followup.mjs mobile new-attempt
```

The server binds loopback only and refuses all API/non-GET requests. It does
not forward to any service or read credentials. Stop this owned server after
validation. Do not restart or activate application workflows for this task.

Evidence root: `generated-artifacts/arx-historical-fibonacci-validation/`.
Final directories: `browser-followup-desktop-attempt-7/` and
`browser-followup-mobile-attempt-2/`. Each contains the attempted harness,
provenance, driver records, journey receipts, browser/network events, exported
before/after snapshots, DOM and screenshots. New failed attempts occupy
their own numbered directories. Details are in `browser-followup-report.md`.
All large generated files remain excluded from Git and deployment.

## Completion checks

Syntax checks passed for all three retained harness/server scripts.
`git diff --check` passed. Independent receipt checks confirmed both 37/37
results, all intercepted writes at 503, exact before/after parsed snapshot
equality, unchanged original evidence hashes, and DOM/screenshots for every
new failed browser attempt. Attempt-directory reuse is rejected before any
evidence is overwritten.

The configured `bash scripts/check-arx-preview.sh` check was attempted and
failed because `/` returned HTTP 502 through the shared router. This task
does not authorize starting application/API services to repair that unrelated
runtime prerequisite; its source-only acceptance uses the frozen loopback
fixture instead. That failure is retained, not relabeled as a preview pass.
Completion code review passed. The owned loopback fixture server was stopped.
