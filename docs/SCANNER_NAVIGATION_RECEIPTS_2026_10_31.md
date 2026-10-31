# Scanner navigation: durable receipts and diagnostic correction — 31 October 2026

Status: tooling validated locally; Replit diagnostic import pending. No release or
competitive-parity claim. Application source is unchanged from b107f1db, inherited
through a9521dbe. No live/demo broker activity, deployment, database or worker changes.

## Exact sources and checks

- Initial tooling: acac2cc5dbbfebd79e70b83ac866ad501a94f464, clean fixture 322d82f5d4aae955.
- Final tooling: 643899a0a1ab5075957c851e3f2c9d40e511c160, clean fixture 231a719410806a0e.
- 91 tooling tests pass, 0 fail/skip. Both changed entry scripts pass syntax checks;
  diff whitespace check passes. Isolated production fixture builds pass. Existing
  sourcemap-location and large-chunk warnings remain. Application suites/root CI
  were not rerun for this fixture-only change; prior app results retain their source.
- Self-review added rejection of contradictory final success claims after a failed
  sample. This is a separate review pass, not an independent-agent review.
- An intermediate build ef890e48b8bf9ccd included untracked browser logs in its
  source status. It was not measured or accepted. Logs moved to the evidence folder;
  the final fixture was rebuilt clean. Build receipts retained.

## What changed

The offline fixture writes append-only private receipts for the ten-attempt plan,
each pending attempt, collected results (including failures), and final summary.
Each acknowledgement follows a file flush. Writes happen outside the measured
click-to-chart interval. Loss of the outer runner, browser or fixture server leaves
prior receipts recoverable. An incomplete attempt cannot pass. Invalid order,
source/run identity, malformed/truncated records, premature or contradictory
completion and write failures are tested. The journal is not resumable across
server restarts and cannot survive deletion of the filesystem; archive its files.

Only the isolated runner can use the token-protected loopback fixture endpoint.
Application request interception is unchanged; no app API is used or permitted.
The recorder is not imported by the dashboard or API server.

The browser now records its version, link geometry changes, frame gaps, long tasks,
resource response times and runner call boundaries. Arrays are bounded with
explicit dropped counts. Resource responseEnd still does not prove JSON parsing,
query-cache insertion or module evaluation. Geometry is not the full Playwright
stability test. Observer work remains in the measured time. Overlap is not proof
of a bottleneck; CPU settings outside the harness must be recorded separately.

## Actual Scanner browser checks

Headless Chrome 156.0.8078.79, Mac-compatible UA, 14 reported logical processors,
DPR 1. Desktop 1440×1100 and emulated mobile 390×844. No harness CPU throttling;
host load/GPU/refresh rate not measured. Only this test workload ran in its timing
window. Historical synthetic 200-bar data, fixed 80ms mock response, inactive reader.
Prepared browser resources/full document reloads, not cold process startup.

| Exact tooling | Desktop under 100ms | Desktop median/max | Mobile under 100ms | Mobile median/max |
|---|---:|---:|---:|---:|
| acac2cc5 | 5/5 | 53.7 / 100.0ms | 5/5 | 37.0 / 96.7ms |
| 643899a0 | 5/5 | 38.5 / 96.1ms | 5/5 | 36.9 / 82.0ms |

All twenty attempts are retained; none excluded as warmup/outlier. Same strict
150ms readiness-to-click and 100ms completion budgets. Exact canonical/displayed
OHLC, source, build, chart identity and unobscured plot over two rendering frames
remain required. Two frames are not proof of physical paint. Marginal samples
remain visible; this is not proof of robust headroom or the user's real-app fix.

A separate 1500ms-idle fault-injection run closed the browser immediately after
acknowledging pending attempt 1. Recovery after browser AND server exit retained
two attempted slots, one collected result and one unfinished slot. It reports
INCOMPLETE, not PASS or zero attempts. This proves persistence across injected
browser loss; it does not claim a reproduction of Replit's exact 45s runner timeout.
The wrapper and raw recovered records are retained. No full idle timing verdict.

Final complete run: 486 intercepted requests, 322 unknown reads, 32 blocked POSTs,
354 expected HTTP-denial console errors and 0 page exceptions. These mock-denial
limitations remain; the browser test is not a healthy real-provider session.

## Replit diagnosis and correction to earlier checkpoint language

Read-only diagnosis returned 31 October. No new tests or changes were run there.
Existing app/tooling f3467de7c5f60038a139a60f00abe56d563f0cc4; checkpoint
caf608b984e2d62d52d5a79b1ea69903efad07dd; production fixture b00017402e73476c.
All 20 old remote samples still FAIL: ready-to-click 666.6–796.6ms and completed
render 122–181.5ms. Pointerdown-to-click 0–0.2ms; capture lag 1.7–4.1ms;
first observed chart container 97.1–116.7ms; witness computation 1.6–7.4ms.

**Correction:** the old 530.8–676.2ms pre-click timestamp means mock response
preparation before route.fulfill, not browser receipt or React readiness. Earlier
phrasing that candles/prefetch were already complete in the browser was unsupported.
The corrected label is included in new samples and the durable checkpoint index.

The old readiness probe omitted full click stability; no actionability/CPU/module
trace exists. Animation, remote automation scheduling and main-thread work remain
hypotheses. Browser version, launch flags, CPU allocation/throttling/load, GPU and
refresh rate were not retained remotely, so Mac/Replit equivalence cannot be claimed.
The 45s failure was an outer execution deadline; its exact configuration was not
archived. Completed batches took about 29.1s, while ten idle dwells add 15s plus
overhead. No old idle partial samples are recoverable; an unknown subset may have run.

## Next

Selectively import only the five fixture/tooling files from final tooling 643899a0
into the current Replit development source; preserve its application and local
setup. Do not import unrelated chart features through this branch's ancestry.
Use a quiet timing window, record the actual outer timeout/runtime/throttling,
retain every journal and failure, and diagnose the post-click/module/actionability
intervals on that exact combined source. Real-provider/authenticated published
Scanner latency and TradingView/MT5 comparisons remain unproven.

Receipts: docs/validation/scanner-navigation-receipts-20261031/manifest.json.
Full raw local logs: /Users/areyouok/arx-tier1-release/scanner-navigation-receipts-20261031.
Owned browsers and fixture servers closed after validation.
