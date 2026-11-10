# Eleanor answer accuracy: evals, claims checker, runtime verifier

Eleanor (the ARX assistant) may state a number, ticket, time or execution status
only when this turn's tool outputs support it. This page covers what enforces that
and how it is tested.

This is about **accuracy, not edge**. The checker proves Eleanor reports ARX data
correctly. It does not and cannot make a forecast true. Deriv V-indices are
driftless, so a "probability" Eleanor states without a calibrated source is
removed. It is never shown.

## Parts

| Part | File | Runs |
|---|---|---|
| Evidence index | `artifacts/api-server/src/lib/assistant/grounding/evidence.ts` | per answer |
| Claims checker | `artifacts/api-server/src/lib/assistant/grounding/claimsChecker.ts` | CI and production |
| Runtime verifier (streaming claim gate) | `artifacts/api-server/src/lib/assistant/grounding/runtimeVerifier.ts` | production, every chat answer |
| Shared chat loop | `artifacts/api-server/src/lib/assistant/chatTurnLoop.ts` | production route **and** eval harness |
| Deterministic eval harness | `artifacts/api-server/src/lib/assistant/evals/harness.ts` | CI |
| Eval corpus | `artifacts/api-server/src/lib/assistant/evals/fixtures/*.json` | CI |
| Live-model lane | `artifacts/api-server/src/lib/assistant/evals/liveModelEval.ts`, report + thresholds in `liveEvalReport.ts` | CI workflow `.github/workflows/eleanor-live-eval.yml` (push to the base branch, manual dispatch), needs the `OPENAI_API_KEY` secret |

## What the checker extracts and verifies

Each claim must be grounded in **this turn's** tool outputs. A number the user
wrote in their own message may be echoed back.

- **Numbers**: prices, P&L, sizes, counts, percentages, durations. A number
  matches at the precision written: `1.0852` matches `1.08523`, but `1.0860`
  does not. Also accepted:
  - thousands separators, currency signs and `k`/`bn` suffixes
  - `%` against a fraction or a percent field
  - pips against a price distance
  - "52 minutes" against an `ageSeconds` / `*Ms` field
  - counts against array lengths
- **Tickets / ids**: `#70011224`, `ticket 70011224`, `order 5123` must appear in
  the evidence.
- **Times and dates**: `14:32 UTC`, `2026-11-09`, `Nov 9` must match a timestamp
  in the evidence (UTC).
- **Execution statements**: "filled / executed / placed / went through / I opened"
  need a result with an executed status: `executed` or `filled`, a fill with
  `executedAt`, or a trade row. If an id is named, it must belong to that result.
  A partial fill only supports a "partially filled" claim. Negated and
  conditional sentences are not claims ("has not been filled", "once you confirm
  it will be placed").

Each problem the checker finds is reported as one of these kinds:

| Finding | Meaning | Runtime handling |
|---|---|---|
| `FABRICATION` | no tool output supports the number, ticket or time | kept, marked inline: `1.0871 [unverified]` |
| `WRONG_NUMBER` | a labelled figure ("stop loss 1.0859", "3 open positions") disagrees with the tool field of that name | sentence removed and replaced by a notice |
| `STALE_AS_LIVE` | the number comes only from data marked stale (`stale:true`, `freshness: STALE`, `isLive:false`, nearest flag wins) and the sentence calls it live, current or real-time without disclosing staleness | sentence removed and replaced by a notice |
| `UNCALIBRATED_PROBABILITY` | a percent or 0..1 figure stated as a chance, probability, odds, likelihood or confidence without a calibrated source (see below), a 0-100 score (`confidenceScore`, `score`, `quality`, ...) shown as a %, or a measured base rate presented as this setup's chance or edge | sentence removed and replaced by a notice |
| `EXECUTION_UNCONFIRMED` | "executed / filled / placed" with no executed result | sentence removed and replaced by a notice |

When anything is marked or removed, the answer ends with a one-line verifier
footer.

### Calibrated probabilities (the calibration-engine seam)

The calibration engine (`lib/calibration/cache.ts`) stamps scanner rows,
strategy payloads, radar opportunities and AI reviews with a `CalibrationStamp`:
`{ probability, status, n, scope, model, baseRate, edgeDetected, label, ... }`.
It does not write `calibrated: true`, so the evidence index recognises the
stamp by its shape (`status` measured/unmeasured, a `probability` key, numeric
`n`, boolean `edgeDetected`), never by a payload field name:

| Stamp | What may be quoted as a probability |
|---|---|
| `status: "measured"`, numeric `probability`, `edgeDetected: true` | `probability` and `label` (e.g. "Win prob 62% (N=143)"), and a sibling `calibratedProbability`. Its `n` is quotable as the N. |
| `status: "measured"`, `model: "base_rate"` / `edgeDetected: false` | Only as a **base rate**: the sentence must frame it as one ("historically 55% of these calls worked (N=143)", "the base rate is 55%"). Stated as this setup's chance, or with an edge claim ("edge", "beats", "outperforms") it is removed. "No edge" is fine. |
| any stamp's `baseRate` field | A base rate, under the same rule (even inside an edge stamp). |
| `status: "unmeasured"` | Nothing. Say the probability is unmeasured, with its N. |

`n`, `fitVersion` and the other stamp fields are counts, never probabilities.
The raw `confidence` / `confidenceScore` / `score` next to a stamp stays a raw
score: shown as a % or a chance it is removed, whatever the stamp says. A
legacy `calibrated: true` field still marks a measured probability.

Eleanor's `getMarketScannerOpportunities`, `getFinalTradeRead` and
`explainOpportunityRanking` outputs carry `calibratedProbability` and the full
`calibration` stamp (`getTopOpportunitiesForMe` returns the radar rows whole),
and `GROUNDING_CONTRACT` tells the model the rule above.

## Runtime: fail closed

In `chatTurnLoop.ts`, every content delta goes through a `ClaimGate`, which:

1. Holds text until a sentence or line is complete.
2. Checks that sentence against the evidence gathered so far in this request.
3. Releases only the verified version.

As a result, no unchecked claim is ever streamed, not even briefly. If the
checker throws, the gate withholds that sentence and shows a notice. Text is
never shown unchecked.

Other guarantees:

- The text that is persisted to `arx_assistant_messages` is exactly the verified
  text the user saw.
- Preamble turns (text followed by tool calls) are cleared by exactly the number
  of characters the gate released.
- When anything is flagged, the route logs `eleanor_claims_verifier_flagged`
  with each finding.

The system messages include `GROUNDING_CONTRACT` (in `systemPrompt.ts`), which
tells the model the rules the verifier enforces.

Limitations:

- Arithmetic Eleanor derives herself (sums, distances) is marked `[unverified]`
  unless a tool returned the figure. The fix is to add the derived figure to the
  tool, not to loosen the checker.
- The push-to-talk and realtime **voice** paths are speech-to-speech and have no
  tools. They are not covered by this verifier. Their numbers cannot be grounded,
  and the voice instruction already forbids figures.

## CI (default lane)

`pnpm --filter @workspace/api-server run test:eleanor-grounding` is wired into
the root `ci`. It runs offline, with no key and no database round-trip, and has
these files:

- `eleanorClaimsChecker.test.ts`: extraction and grounding rules, including the
  non-claims it must ignore (symbols such as `R_75`/`1HZ100V`/`Volatility 75
  Index`, timeframes, list markers, `x/100`).
- `eleanorRuntimeVerifier.test.ts`, covering:
  - gate holding and release
  - chunked output equal to whole-answer output for every chunk size
  - fail-closed behaviour
  - the invariant that "nothing ungrounded reaches the user unmarked"
  - the loop (preamble clear, stream error, provider and tool failure)
  - route and loop wiring, including that the loop cannot place orders
- `eleanorEvals.test.ts`: replays every fixture through `runChatTurnLoop` with
  the production system messages and the real `TOOL_DEFINITIONS`, using a
  scripted model and recorded tool results. Each fixture must satisfy all of
  these:
  - the checker reports exactly the planted findings (no misses, no false alarms)
  - the visible text equals the persisted text
  - expected text is present or absent
  - re-checking the visible text finds no unmarked ungrounded claim
  - every fixture tool name is a real Eleanor tool

  The scorecard asserts 100% pass, every planted error caught, and zero false
  alarms on clean answers. It also asserts minimum coverage:
  - at least 50 fixtures
  - at least 5 per category
  - every finding kind planted at least 3 times
  - at least 20 clean answers

Two more files in the same script:

- `eleanorCalibrationSeam.test.ts`: the calibration-stamp rules above, using the
  engine's own `toCalibrationStamp` / `calibrate` (measured probability with its
  N survives, unmeasured is removed, a raw score as a % is still removed, a base
  rate is never an edge, stamp counts are not probabilities), and that Eleanor's
  tools return the stamp.
- `eleanorLiveEvalReport.test.ts`: the live lane's report and thresholds, the
  "not run: no key" failure, the workflow triggers, and one end-to-end run of
  the CLI against a local fake OpenAI endpoint (real `chatTurnLoop`, real
  verifier, measured report written).

### Corpus

There is one JSON file per category in `evals/fixtures/`: `prices`,
`positions`, `fills`, `executions`, `risk`, `chart_reads`, `scanner` and
`errors_stale`. Each fixture has this shape:

```json
{
  "id": "prices-fabricated",
  "category": "prices",
  "description": "Model states a price the tool never returned",
  "user": "EURUSD price?",
  "turns": [
    { "toolCalls": [{ "name": "getMarketSnapshot", "args": { "symbol": "EURUSD" } }] },
    { "text": "EUR/USD is trading at 1.0871 right now." }
  ],
  "toolResults": { "getMarketSnapshot": { "...": "recorded result" } },
  "expect": { "findings": ["FABRICATION"], "visibleIncludes": ["1.0871 [unverified]"] }
}
```

A tool result of `"THROW:<message>"` makes the recorded tool throw. To record
several calls to the same tool, use an array of `{ "__call": <result> }`.

To add a case, copy a real tool result shape into the fixture. Clean answers
matter as much as planted errors, because they catch false alarms.

## Live-model lane (CI workflow `Eleanor live eval`)

The scripted corpus proves the checker and gate. It cannot say how often the
real model gets things right. This lane measures that.

**What it runs.** `.github/workflows/eleanor-live-eval.yml`, job
`eleanor-live-eval`:

- Triggers: push to `claude/replit-slice6-eleanor-20261105` and
  `workflow_dispatch`. **Never `pull_request`**: a fork PR can never reach the
  secret, and PRs do not spend model budget. `permissions: contents: read`.
- Secret: `OPENAI_API_KEY` (repository secret). The script maps it onto the
  `AI_INTEGRATIONS_OPENAI_API_KEY` / `_BASE_URL` variables the app reads, with
  the public `https://api.openai.com/v1` base URL (override: `OPENAI_BASE_URL`).
- Optional repository variables: `ELEANOR_EVAL_MODEL` (default `gpt-5.4`, the
  production chat model in `routes/meAssistant.ts`) and
  `ELEANOR_EVAL_MIN_ACCURACY` (default `0.9`).
- Each distinct fixture question goes to the real model with the production
  system messages, every `TOOL_DEFINITIONS` entry, the production
  `chatTurnLoop` and the runtime verifier. Tools answer from the fixture's
  recorded results; an unrecorded tool returns `not_recorded_for_eval`. No
  database, broker or account is touched, and the loop cannot place orders.

**What it reports** (job summary + artifact `eleanor-live-eval-<run id>` with
`eleanor-live-eval.json` and `.md`, kept 90 days):

- claims made, claims verified (matched to this turn's tool data **and** no
  finding of any kind), raw-model accuracy = verified / made;
- raw findings by kind, and answers with any finding;
- findings that reached the user unmarked after the verifier, by kind;
- per fixture: tools called, claims, accuracy, findings, raw and visible text.

**No key = fail.** Without the secret the job prints `not run: no key`, writes a
NOT RUN summary naming the secret, raises an error annotation and exits 1. It
never passes without measuring.

### Thresholds

The job fails (`--strict`) unless all of these hold:

1. **Zero ungrounded claims reach the user unmarked**, every kind. The gate
   removes WRONG_NUMBER, STALE_AS_LIVE, UNCALIBRATED_PROBABILITY and
   EXECUTION_UNCONFIRMED sentences and marks FABRICATIONs; this proves it on real
   model text, not only scripted text.
2. **Zero raw EXECUTION_UNCONFIRMED.** Even though the gate removes it, a model
   that claims an order filled when no tool says so is the most dangerous error
   in a trading assistant, so a single one fails the run.
3. **Raw-model accuracy >= 90%.** Why 90%: every answer in the corpus is short
   (one to five figures), so below 90% a typical answer reaches the user with a
   removed sentence or an `[unverified]` mark about once in every two or three
   answers, which makes Eleanor visibly unreliable even though it is safe. The
   known legitimate source of raw misses is arithmetic Eleanor derives herself
   (see Limitations), which the contract tells her not to do; 10% headroom
   covers that without hiding real grounding failures. The floor is a starting
   point: once the lane has measured runs, raise it to just under the measured
   rate (repository variable `ELEANOR_EVAL_MIN_ACCURACY`) so it catches
   regressions.
4. **Every question answered.** A provider or stream error is a fail, as is a
   run with no checkable claims.

A single run of a non-deterministic model is one sample; the per-fixture table
shows which questions drive the rate.

### Running it locally

```bash
OPENAI_API_KEY=... pnpm --filter @workspace/api-server run eval:eleanor-live -- --require-key --strict --out eleanor-live.json --summary eleanor-live.md
```

`AI_INTEGRATIONS_OPENAI_API_KEY` (+ `_BASE_URL`) take precedence when set.
Flags: `--require-key` (no key: not run, exit 1; without it a local run with no
key exits 0), `--strict` (exit 1 when a threshold fails), `--only
<id-substring>`, `--out`, `--summary`.
