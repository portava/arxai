# Selected-chart Fibonacci ownership acceptance

**Status: scoped acceptance complete on the saved frozen build.** Following
explicit approval to repair and resume, a standalone harness completed **40/40
checks on desktop and 40/40 on phone**, including primary/comparison ownership.
Earlier incomplete attempts and the original 8 passes / 1 failed assertion are
retained below, not reclassified as passes. No current-checkout, real-provider,
performance, parity or strict network-allowlist acceptance is claimed.

## Scope and source identity

This acceptance is limited to the saved combined actual-Scanner source
`e4bbba1e2bdccda166566892d0e7600a4bea8cf4`, frozen actual-App build
`28ccd598d091581c`. It is not acceptance of the current checkout, the running
API, real market data, or support/resistance branch `af64be44`.

The original development report remains
`ARX_HISTORICAL_FIBONACCI_SOURCE_DEVELOPMENT.md`. Original attempts are retained
without rewriting their results. In particular,
`generated-artifacts/arx-historical-fibonacci-validation/browser-fibonacci-desktop/journey-result.json`
still contains **8 passes / 1 failed assertion**, unfinished. Its SHA-256 is
`5a561def32ad0417c33c0abc4dc3c9c72e75ef02567bb795854c4eaaf5e0499e`.
The receipt correctly displayed `50.0%`; the old test required literal `50%`.
It was a harness failure, not evidence of incorrect Fibonacci calculation.

### Saved versus current source

The saved scratch source is checked against its original source-hash manifest,
not assigned the identity of the newer checkout. The three relevant engine
files still match the saved source:

| File | SHA-256 |
|---|---|
| `chartAppliedWindow.ts` | `ba42e9ab226c1bb4f2a49c93f562edbcaec47cb09875cf5753c1265e472c7e8e` |
| `chartAutoFibonacci.ts` | `9b00ab4210a48b6622a0f38ce55faaad57454aa11bd3a5d47a54529a7277b555` |
| `chartFibonacciExplanation.ts` | `2bf16743bb11df9060807c19a25ddd7fa937c355d73e7eb35b75609be654bc31` |

Saved `ChartWorkbenchTools.tsx` is
`99f54dd7f7e600829cc9828291a4f9834a68dbcce24d56ec2227bcf35253d1c0`;
the checkout's newer file is
`4459577591485e025c638f32c685596784c9ccc5cfdd7b1d3d1da7710ae0b4d5`.
The saved observer also differs from the newer checkout's observer. These are
scope disclosures, not an instruction to roll back or include newer changes.
Only the saved observer and build are used for acceptance.

## Numeric and geometry contract

Numeric equality is semantic: `0.0`, `50.0`, and `100.0` percent are the same
ratios as `0`, `50`, and `100`. Exactly seven unique ratios must occur:
`0`, `23.6`, `38.2`, `50`, `61.8`, `78.6`, `100`.

Prices must equal the selected drawing's measured values after the existing
reader's disclosed seven-significant-digit formatting
(`Number(value.toPrecision(7))`). This is not a widened arbitrary tolerance.
Missing, duplicate, wrong-ratio and wrong-price levels must fail. Receipt
wording alone does not establish installation: the existing observer must show
the drawing and its seven rendered levels. Source, selected-pane identity,
window, anchors and non-forecast/source-clock caveats remain separate gates.

## Evidence and preserved limitations

### Completed standalone acceptance

The corrected programs are ordinary standalone modules, not runtime string
replacement wrappers:

- `scripts/qa/fibonacci-ownership.mjs`: synthetic envelopes, semantic numeric
  comparator, unchanged-observer geometry gates and actual Scanner journey.
- `scripts/qa/run-fibonacci-ownership.mjs`: source/asset-pinned, 300-second owned
  browser runner with immutable per-attempt directories and cleanup.
- `scripts/qa/audit-fibonacci-evidence.mjs`: read-only audit of saved receipts,
  exact source window, strict original pivots, confirmation and caveats.

Syntax checks passed. Twelve offline parser/comparator/fixture assertions
accepted formatted equivalents and rejected wrong price, wrong ratio, duplicate,
missing level, missing rendered geometry and omitted source evidence.
Separate offline projection self-checks accepted valid geometry and rejected a
wrong pixel coordinate and a missing line. These checks ran before browser
acceptance; none is mislabeled as a browser feature assertion.

| Completed journey | Viewport | Passed | Failed | Incomplete | Driver exit |
|---|---|---:|---:|---|---:|
| `standalone-desktop` | 1440 × 1100 | 40 | 0 | No | 0 |
| `standalone-phone` | 390 × 844 | 40 | 0 | No | 0 |

Both used Node `v24.22.1`, workspace headless Chromium `152.0.7977.64`,
fresh contexts and stripped child environments. No CPU throttle was requested;
shared-host contention was not independently controlled. These are untimed
functional journeys, not performance measurements or physical-device evidence.

Each viewport completed the following on the actual Scanner:

- Two simultaneous panes: primary EURUSD/M1, synthetic identity `a…a`, and
  analysis-only comparison EURUSD/H1, synthetic identity `b…b`.
- Each installed 160-bar canonical dataset matched its fulfilled response
  exactly, with its distinct prices and source identity.
- Explicitly selected assistant context identified primary versus
  analysis-only comparison, without attributing comparison tools to primary.
- Local preview replies named the selected symbol/interval and source identity,
  retained precision/window/non-forecast/source-clock caveats and matched all
  seven numeric levels against installed drawing anchors.
- The existing observer showed seven unique Fibonacci strokes whose finite
  endpoints matched the anchor price projections plus container offset
  (≤1.5 CSS pixels); strokes had nonzero horizontal span and ≤0.5-pixel y delta.
  This geometric tolerance is separate from numeric price equality.
- Previews were locked, unaccepted and anchored to original source extremes.
  Objects remained zero until explicit Keep.
- Keep created and selected one editable drawing with unchanged anchors and
  archived automatic provenance. Manual explanations retained its seven
  levels and distinguished archived provenance from current advice.
- After the full flow, the selected drawing and exact candle timestamps/OHLC
  remained unchanged; the other pane's drawings and candles also remained
  unchanged. Comparison commands preserved the primary's already-kept drawing.

The read-only receipt audit additionally passed for all **four**
viewport/pane combinations: exact window endpoints/count, both original strict
opposite pivots with two closed observations on either side, later confirmation,
source identity, geometry, full source/window wording and clock caveats. This is
an audit of recorded browser evidence, not four more browser runs.

### Seven prices observed in both viewports

| Ratio | Primary EURUSD/M1 | Comparison EURUSD/H1 |
|---:|---:|---:|
| 0% | 104.2814 | 190.7002 |
| 23.6% | 102.2572 | 195.0897 |
| 38.2% | 101.0049 | 197.8052 |
| 50% | 99.99274 | 200 |
| 61.8% | 98.98061 | 202.1947 |
| 78.6% | 97.53962 | 205.3194 |
| 100% | 95.70407 | 209.2997 |

The corresponding source-coordinate windows were January 1, 2026 00:00 through
02:40 for M1 and January 1 00:00 through January 7 16:00 for H1. These labels
remain source coordinates with UTC unverified; the synthetic fixture does not
establish real historical clock authority.

### Earlier attempts retained

| Directory | Passed checks | Failed assertions | Other error / remaining scope |
|---|---:|---:|---|
| `desktop` | 13 | 0 | Hidden responsive-tools-toggle locator timed out |
| `desktop-correction` | 14 | 0 | Success-only reply predicate timed out on actual source-evidence refusal |
| `desktop-correction2` | 14 | 0 | Same refusal after Fit history; fixture still missing evidence source |
| `desktop-correction4` | 19 | 1 | Preview receipt arrived; comparator incorrectly read pixel points as prices |
| `desktop-correction9` | 12 | 1 | Comparator positive self-test lacked drawing anchors; feature flow not reached |

These counts are repeated **per-attempt** setup and check observations, not
unique feature passes. Every listed journey is unfinished. They cannot be
summed into acceptance coverage.

Correction4 repaired the synthetic envelope's missing
`marketEvidence.source: "mt5_broker"` field. Previously, exact installed candles
and an identity alone did not satisfy the unchanged source gate. The actual
assistant's refusal was present in retained DOM; a predicate waiting only for
successful preview text concealed it as a timeout. No product gate was weakened.

Correction4 then reached a preview but incorrectly expected price values on the
observer's pixel-coordinate stroke endpoints. Later prepared comparisons derive
level prices from observed drawing anchors and require actual pixel endpoint
alignment through the existing coordinate observer. Those corrected geometry
checks were unverified at the stop. They subsequently passed in the standalone
journeys above; the earlier failed attempts remain unchanged.

`desktop-correction5`, `desktop-correction7`, `desktop-correction8`, and
`desktop-correction10` have driver errors from generated-wrapper directory or
replacement-anchor failures; no journey-result receipt was produced.
Correction3 and correction6 have provenance but were unstarted. Correction11
was prepared but unstarted. Earlier `phone`/`phone-correction*` directories are
unstarted provenance, not phone feature coverage. The distinct completed phone
journey is `standalone-phone`, not any of those earlier programs.

The original comparator's duplicated numerical self-check accepted equality and
rejected wrong price/ratio/duplicate/missing levels, but did not exercise the
actual receipt parser. After changing that self-check to use the real
comparator, its positive synthetic geometry failed because the fixture lacked
anchors. Neither self-check result is actual chart geometry acceptance.

The standalone continuation completed the previously outstanding semantic
numeric/rendered geometry, preview/no-auto-Keep, explicit Keep, selected manual,
unchanged data and primary/comparison ownership behaviors on desktop and phone.
No application defect was established by the old harness failures. They were
fixed in the offline harness, not by weakening application gates.

### Offline boundary and cleanup

The checks that reached asset verification found all **295 served assets**
identical to the frozen build manifest. The shared setup SHA-256 remained
`2da6efde889d39b4edae1378da141adb025452bf987f20009054aedbf193a78d`.

All observed API traffic remained intercepted, with attempted writes rejected
503. No external-origin or WebSocket attempt was observed in the retained
journey records. The unexpected blocked
`POST /api/me/assistant/conversations` remains outside the known-background
allowlist; no strict allowlist pass is claimed and it was not whitelisted.
Its separate remote-conversation follow-up already exists.

| Completed journey | API requests | Blocked writes | Blocked conversation POSTs | External / WebSocket attempts | Strict allowlist |
|---|---:|---:|---:|---:|---|
| Desktop | 77 | 8 | 4 | 0 / 0 | Failed |
| Phone | 75 | 8 | 4 | 0 / 0 | Failed |

Conversation POSTs are a subset of blocked writes, not additional requests.
The safe-boundary gate passed; the strict known-background allowlist did not.
The harness reports these separately without treating blocked conversation
creation as approved behavior.

Owned browsers and the static-only loopback server were closed. No original
workflow was activated or restarted, no source/bundle was installed into a
running application, and no application/library source was edited by this work.
Tracked work is limited to offline acceptance tooling and documentation.

The registered `arx-preview` command (`bash scripts/check-arx-preview.sh`) was
not run for this scoped acceptance: it requests the shared application/API
runtime rather than the frozen isolated build. The original services were not
running during this work and activating them is explicitly prohibited. The
offline self-checks, source/asset gates, completed browser journeys and saved
receipt audit above are the verification performed; the existing shared-preview
validation configuration was left unchanged.

### Completed evidence identity

Both completed directories contain `journey-result.json`, `provenance.json`,
`terminal.json` and four screenshots (`primary-preview.png`,
`primary-kept-manual.png`, `comparison-preview.png`,
`comparison-kept-manual.png`). Selected desktop/phone screenshots were inspected;
they do not establish whole-plot viewport fit.

| Receipt / tested program | SHA-256 |
|---|---|
| Desktop `journey-result.json` | `e83c79d0ebec8de2ac169cbefadc40f4c8e7625825e862de5a5c133b59264b27` |
| Phone `journey-result.json` | `70756c02d1749b8f1c95529d5a46c63aae9caba0ddc19650b49334bd30b63919` |
| Tested `fibonacci-ownership.mjs` | `8a68e2f88287c6455b29d09565707bc07ef4eb97dfec16578d85710b7dfc6a7e` |
| Tested `run-fibonacci-ownership.mjs` | `7cce45209f770ce78462f8abe50997a6aad95ea674d783e5243992a9ad10cc51` |

New harness programs, provenance, raw replies, stage/DOM diagnostics, screenshots,
network receipts and terminal status are stored separately under:

`generated-artifacts/arx-historical-fibonacci-validation/fibonacci-ownership-acceptance/`

The browser uses the actual Scanner route with a synthetic offline fixture, not
a replacement chart component. Every API request is intercepted; mutations are
rejected rather than fulfilled as successful writes. No existing database,
provider, model, broker or trading operation is part of this acceptance.

The omitted-interior-original-observation rule retains its automated regression.
No browser rejection of that condition is claimed without an explicit negative
fixture demonstrating the omitted observation through the existing observer.

Old navigation/first-click, composer-focus, partial phone visibility and
zoom/touch failures remain open. No performance, physical-paint timing,
competitor-parity, production-readiness or real-provider acceptance is inferred.

## Source/window withdrawal continuation (2026-11-01)

**Scoped frozen-build acceptance complete: 75 recorded checks / 0 failures on
desktop and 75 / 0 on phone.** These totals include the original ownership flow,
source/asset and offline preflights, and 35 added checks; they are not 75 distinct
browser behaviors. This continuation still uses the same saved actual-App build
`28ccd598d091581c` and source `e4bbba1e2bdccda166566892d0e7600a4bea8cf4`.
It does not establish acceptance of the current checkout or the running API.
No application source, observer, bundle or runtime settings were changed.

### New actual-Scanner coverage

Both viewports exercise both explicitly selected panes, with their saved,
editable Fibonacci annotations already present:

1. Request another positive automatic preview. Require all seven ratios/prices
   from its installed preview drawing, distinguished by the existing observer's
   drawing/stroke IDs from the kept drawing.
2. Use the real Zoom in control after Fit history. Require the visible window to
   change, the preview region and preview drawing to disappear, and a fresh
   "Explain Fibonacci preview" reply to report no current preview.
3. Fit history and request another positive preview. Hold a real Keep send at
   the DOM boundary before React receives it. Replace only the selected
   response's synthetic source identity (`a…a → c…c` for M1, `b…b → d…d` for H1).
   Identical timestamps/OHLC isolate this from a candle-price or window change.
   Normal query refresh must actually fulfill the new-identity response.
4. Require the preview region/drawing and selected assistant ownership to
   withdraw. Release the held Keep text through the normal local send path.
   Require the no-ready-selected-chart refusal, with no primary fallback and
   no new drawing. Reselect the replaced source and require a fresh explanation
   to report no current preview, without the old identity.
5. After each withdrawal, delayed Keep and reselected explanation, compare all
   kept drawing fields and every drawing-storage string byte-for-byte; compare
   the other pane's complete drawings/canonical candles as well. Selected-pane
   canonical candles also stay exactly unchanged.

The held command is an explicitly synthetic DOM-delivery delay, not a model or
network response: local Fibonacci dispatch is synchronous. Historical assistant
messages are not deleted or rewritten. The check concerns fresh current-preview
answers. A kept manual drawing, its seven visible lines and archived provenance
remain valid user annotations, not stale automatic-preview geometry.

### Completed evidence

All directories below are relative to
`generated-artifacts/arx-historical-fibonacci-validation/fibonacci-ownership-acceptance/`.
Each successful run includes raw replies, observer snapshots, request/response
receipts, program hashes, terminal cleanup status and eight screenshots.

| Attempt | Viewport | Passed | Failed | Incomplete | Exit |
|---|---|---:|---:|---|---:|
| `withdrawal-desktop-fresh-reply` | 1440 × 1100 | 75 | 0 | No | 0 |
| `withdrawal-phone` | 390 × 844 | 75 | 0 | No | 0 |

Desktop/phone withdrawal screenshots were inspected. They do not establish
whole-plot viewport fit. Browser contexts and each runner's static-only
loopback server closed. All 295 frozen assets matched. Child execution used
a stripped environment, with no credentials passed into the browser runner.
No original workflow was started or restarted.

| Evidence | SHA-256 |
|---|---|
| Desktop `journey-result.json` | `737f16018b183ee2e9c6a81167b7eb70f729722156803b3be64400d1ad7937d9` |
| Phone `journey-result.json` | `d459d30f2e7fa0160bb69716463a64a21841220b2b7f7705be1fcc3a8a3599ae` |
| Tested `fibonacci-ownership.mjs` | `e70f1a2ab873476326fb2a78b5c46d0d91ec0e06bc9d263985d6aad4942c1b34` |
| Tested `fibonacci-withdrawal.mjs` | `a79844e9c624fb98f7bb224be87cfbfbed0eb3302d25bb18e6c5805951dc2743` |
| Tested `run-fibonacci-ownership.mjs` | `a6afbfcabfe756c64ade6c41d76d8d4449899cab83abc4184b29145789ac024f` |

The standalone read-only `scripts/qa/audit-fibonacci-withdrawal.mjs` passed for
both completed receipts. Its six negative mutations per receipt reject stale
preview objects, moved saved anchors, stale current explanations, a successful
delayed Keep, changed other-pane candles and missing fulfilled new identities.
These are offline audit self-checks, not additional browser runs.

| Offline boundary | Desktop | Phone |
|---|---:|---:|
| API requests | 150 | 148 |
| Blocked writes (all 503) | 20 | 20 |
| Blocked conversation POSTs (subset of writes) | 16 | 16 |
| External / WebSocket attempts | 0 / 0 | 0 / 0 |
| Strict known-background allowlist | Failed | Failed |

The previously documented conversation-creation issue remains blocked, not
whitelisted or relabeled as a passing strict allowlist. Its existing follow-up
covers it. No providers, broker, model, database or trading operations ran.
The shared `bash scripts/check-arx-preview.sh` validation remains intentionally
unrun because it activates the shared preview/API, outside this isolated scope.

### Retained incomplete harness attempts

- `withdrawal-desktop`: 10 passing preflights, no failed assertion; navigation
  stopped because the new static runner lacked `/market-scanner` in its SPA
  route list. Its failure receipt/screenshot remain unchanged.
- `withdrawal-desktop-route-corrected`: 39 passing checks, no failed assertion;
  the repeated positive preview replied successfully, but text-based freshness
  detection timed out because the identical reply already existed in history.
  Retained DOM records the new reply. The harness now tracks fresh
  role-qualified DOM nodes, accepting repeated identical replies and refusals.

Neither incomplete attempt is counted toward successful feature coverage.

### Reproduction

The saved scratch build, source manifest and Playwright dependency must exist;
the runner fails closed if pinned assets/source are missing or changed. It does
not rebuild or activate the application. Port 4199 must be free.

```sh
node scripts/qa/fibonacci-ownership.mjs
node --input-type=module -e "import {withdrawalSelftest} from './scripts/qa/fibonacci-withdrawal.mjs'; console.log(withdrawalSelftest())"
env -i PATH="$PATH" HOME="$HOME" node scripts/qa/run-fibonacci-ownership.mjs desktop withdrawal-desktop-new
env -i PATH="$PATH" HOME="$HOME" node scripts/qa/run-fibonacci-ownership.mjs phone withdrawal-phone-new
node scripts/qa/audit-fibonacci-withdrawal.mjs withdrawal-desktop-new withdrawal-phone-new
```

Use new attempt names: existing evidence is never overwritten. Missing interior
observations, real providers, performance, production and physical-device
acceptance remain outside this continuation.
