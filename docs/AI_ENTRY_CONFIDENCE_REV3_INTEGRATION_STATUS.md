# AI entry confidence Revision 3 — integration status

Recorded 28 October 2026. Code reviewed: `defca2a52ed399152b5230595a4295fa7384bf97` (draft PR 102, on PR 100).

The owner supplied [Draft Revision 3](AI_ENTRY_CONFIDENCE_POLICY_DRAFT_REV3_2026_10_28.md) while development continued. It is preserved verbatim, SHA-256 `c515c4b00a4aba83c70d7626850a20fe62c85ccdce23cabf279cc53412bfe2e8`. Receipt of this draft is not qualification, an activation decision, or permission to run broker operations. No approved context or activation record accompanied it.

**AI entry remains blocked.** The current code unconditionally applies `AI_ENTRY_POLICY_PENDING` to known Ruby, automation and strategy OPEN intents. There is no qualified-context exception. Manual OPEN and CLOSE / PARTIAL_CLOSE / MODIFY retain their separate gates. This checkpoint changes documentation only; it does not alter application behavior, databases, workers, deployment or permissions.

## What the draft now specifies

- A declared calibrated probability in finite 0-to-1 units, tied to a named outcome, purpose and horizon. Heuristic weights or an LLM's stated certainty are not accepted probabilities.
- Distinct RETURN and HEDGE purposes, immutable context/pipeline identity, context-specific numerical requirements and deterministic threshold selection. No global threshold, sample size, lifetime or expiry is supplied or invented.
- Separate software-control acceptance, statistical qualification, operational readiness and scoped activation. A passed test, document, backtest or confidence score activates nothing.
- Equivalent enforcement for governed paper/simulated execution and each broker-bound final consumer; trustworthy provenance must survive queues, retries and child orders.
- Final authority, freshness, size/envelope, quantity budget, audit, expiry and independent risk checks; revocation must serialize with dispatch. Missing or contradictory required state blocks entry.

## Reviewed route map — incomplete inventory

Paths below are relative to `artifacts/api-server/src/`. Source inspection identifies dependencies; it is not proof of every production caller, historical queued state or broker execution. Implementation-owner assignments remain unfilled and are qualification blockers.

| Surface | Reviewed path | Current boundary and missing evidence |
| --- | --- | --- |
| Governed PAPER | `lib/safety/entryPolicy.ts:11`; `lib/tradeEngine/paperVenue.ts:243` | Supplied AI decision IDs cannot become manual/api/system; Safety Core is rechecked at atomic booking. No Revision 3 context resolver or qualified final-booking gate exists. |
| Trade Action Center / Ruby | `lib/tradeAction/confirm.ts:106`; `lib/tradeAction/route.ts:60` | Confirmation maps ai_suggested to ruby and decision_engine to automation, then the pending-policy hold applies. SIMULATED preserves typed origin. Broker routing has the provenance loss described below. |
| Ruby instant entry | `lib/live/instantTrade.ts:464` | Draft → confirmation → dispatch; downstream source-text inference needs replacement by durable trusted lineage. |
| Autonomous self-trading | `lib/selfTrade/agentExecutor.ts:433`; `lib/selfTrade/entryAuthority.ts:218` | Agent, decision, execution and idempotency references plus narrower account/volume/expiry/funding/switch checks exist. They do not constitute a Revision 3 approval. |
| LIVE and DEMO consumers | `lib/live/liveCommandPipeline.ts:3780`; `lib/mt5/demoCommandConsumer.ts:290` | Origin partly inferred from source text. Pickup, retries, mirrors, child orders and final terminal boundaries need their own coverage. |
| OMS / research | `lib/oms.ts:500` | AI_ASSIST → ruby and AI_AUTO/SCANNER → automation at OMS governor calls. Research and pure preview outputs confer no execution authority. |

## Findings and closure criteria

| ID | Finding / status | Required closure |
| --- | --- | --- |
| ACR3-01 | **Observed source-level provenance loss; active bypass not demonstrated.** `decision_engine` is automation at confirmation, but `tradeAction/route.ts:60–63` maps it to `TRADE_ACTION_CENTER`; `routeOpen:116–122` forwards no typed AI origin/decision identity. The LIVE and DEMO classifiers infer manual from that generic label without separate self-trade identity. Current pending-policy confirmation blocks new attempts on this path. Historical/queued reachability remains unverified. | Preserve authenticated, immutable AI OPEN lineage through every producer, confirmation, persisted command, retry, replacement and child. Reproduce consumer-level refusals in disposable/offline tests, including pre-existing queued work. Do not broaden confidence gates for verified manual or protective flows. |
| ACR3-02 | No immutable qualified-context/evidence/approval registry or scoped activation state machine identified. | Implement account/context/mode-bound, versioned records and explicit authorities. Test suspension, expiry, revocation, restart restoration and reactivation; default remains BLOCKED. |
| ACR3-03 | No approved actual contexts, datasets, numerical limits or validation packets supplied. | Populate and review the draft's complete profile and reproduce qualification. Missing inputs remain blockers, not defaults. |
| ACR3-04 | Existing heuristic conversion is not calibration: `lib/missionDrafts.ts:229` divides confidence by 100 into `winProbability`. | Prevent heuristic values being accepted as calibrated entry probabilities. Add explicit typed event, units, outcome source, model/calibrator, purpose, horizon and size/cost envelope. |
| ACR3-05 | Complete statistical qualification machinery is not established. | Frozen fit/calibration/selection/final partitions; experiment register; deterministic capacity-aware selection; dependence-aware uncertainty; eligible-range calibration; prospective evidence; retained inputs/model outputs and reconciled outcomes. |
| ACR3-06 | Existing TTL, setup expiry and kill-switch controls are narrower than Revision 3. | Test earliest absolute deadline, equality-at-expiry, clock uncertainty, input age, plan/size mismatch, cumulative unresolved budgets and final authorization serialized against revocation. |
| ACR3-07 | Paper audit atomicity exists, but whole-table audit integrity is not proven; legacy raw writers bypass common serialization. Protective audit failures can refuse/roll back operations. | Inventory/migrate relevant writers under a reviewed integrity design; preserve current protective failure semantics. No assumed emergency fallback. |
| ACR3-08 | Refusal side effects, complete tenant isolation, reservation lifecycle, EA pickup, cancellation/late-fill/restart mechanics and all additional entry callers are not exhaustively verified. | Compare row values/statuses as well as counts, inject failures and races in disposable systems, and retain pass/fail/skip evidence for each adapter. Broker runtime validation requires separate authorization. |

## Statistical acceptance example from the owner draft

The supplied 500-observation example has two tie-preserving groups: 400 scores of 0.50 with 200 successes, and 100 scores of 0.95 with 78 successes. The eligible high-score group is miscalibrated by 17 percentage points. Its weighted contribution makes aggregate ECE `0.2 × 0.17 = 0.034` (3.4 percentage points). Brier score is `(400 × 0.25 + 78 × 0.05² + 22 × 0.95²) / 500 = 0.2401`, versus `0.25` for a fixed 0.5 baseline. Those aggregate metrics do not establish eligible-range acceptance. This arithmetic is a required regression fixture, not a fitted model, justified tolerance, statistical qualification or activation record.

## Milestones and next work

1. **Document receipt: complete.** Original preserved with checksum and reviewed against the identified code snapshot.
2. **Route/control inventory: partial.** ACR3-01 and ACR3-08 require further caller and persisted-lineage investigation before any hold replacement.
3. **Shared Revision 3 gate: not implemented.** Retain the unconditional pending-policy hold while developing schemas, qualification tooling and final-boundary tests.
4. **Statistical qualification: blocked on actual contexts and evidence.** No numeric default or estimated completion percentage.
5. **Activation: absent.** No automatic transition from software/test success to paper, demo or live authority.

This pass performed read-only source review and preserved the specification; it ran no policy-control or broker tests. The prior PR 102 safety receipts remain tied to their original commits and do not validate Revision 3. Continue the Smart Chart work independently; chart analysis scores, patterns and screenshots must not become execution permissions.
