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
| Live-model lane (optional) | `artifacts/api-server/src/lib/assistant/evals/liveModelEval.ts` | manual, needs a key |

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
| `UNCALIBRATED_PROBABILITY` | a percent or 0..1 figure stated as a chance, probability, odds, likelihood or confidence without a `calibrated:true` source, or a 0-100 score (`confidenceScore`, `quality`, ...) shown as a % | sentence removed and replaced by a notice |
| `EXECUTION_UNCONFIRMED` | "executed / filled / placed" with no executed result | sentence removed and replaced by a notice |

When anything is marked or removed, the answer ends with a one-line verifier
footer.

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
three files:

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

## Live-model lane (optional, not in CI)

```bash
AI_INTEGRATIONS_OPENAI_API_KEY=... pnpm --filter @workspace/api-server run eval:eleanor-live -- --out eleanor-live.json
```

`OPENAI_API_KEY` also works; the base URL then defaults to `api.openai.com`. The
lane runs the real model (`ELEANOR_EVAL_MODEL`, default `gpt-5.4`) with the
production system messages, tools, loop and verifier:

- Each distinct fixture question is answered against the fixture's recorded tool
  results.
- A tool the fixture did not record returns `not_recorded_for_eval`. No
  database, broker or account is touched.
- It prints each answer's findings and a summary: grounding rate, and findings
  by kind.

Flags:

- `--strict`: exit 1 if any answer has a finding.
- `--only <id-substring>`: run a subset of fixtures.
- `--require-key`: fail instead of skipping when no key is set.

Without a key it prints `skipped` and exits 0. The lane is intentionally not
part of `ci`: its results depend on a paid, non-deterministic model.
