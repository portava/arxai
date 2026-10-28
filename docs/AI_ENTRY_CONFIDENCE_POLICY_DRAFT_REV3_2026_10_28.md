# ARX Universal AI Entry Confidence Policy Draft Revision 3

Source: [ARX Universal AI Entry Confidence Policy Draft Revision 3](https://chatgpt.com/space/page_25606bacabf0819180f90d12dc57ade9)

Exported: 28 October 2026

**Revision 3 — Shared ARX policy and implementation scope.** Every trader receives the same minimum evidence, authorization and audit requirements. Eligibility adapts to the trading purpose, market, timeframe, execution conditions and account constraints. This policy is intended to support sound decisions across trading styles; it does not establish profitability for every trader or market.

Governed AI entries, including paper and simulated execution, require a supported context, passing validation evidence, scoped approval and all runtime gates. No completed context or activation record accompanies this document. The existing pending-policy hold remains until approved requirements are implemented and the relevant context qualifies. This document neither changes nor verifies running application state.

## Scope and decision authority

The enforcement scope is ARX's known Ruby, automation and strategy `OPEN` intents, including creation, confirmation, queued dispatch, retries and child orders retaining that OPEN lineage. Trusted application logic preserves origin; changing a surface label cannot turn a known AI decision into a manual decision. The implementation reference reviewed is local commit `15b2dcb6eee73e5c6c857451956e4f8aee972d5a`, whose [entry-policy code](https://github.com/portava/arxai/blob/15b2dcb6eee73e5c6c857451956e4f8aee972d5a/artifacts/api-server/src/lib/safety/entryPolicy.ts) contains the existing `AI_ENTRY_POLICY_PENDING` hold. This reference is a code snapshot, not a deployment-status claim.

Manual `OPEN` intents retain their existing ownership, authorization, geometry and risk gates. `CLOSE`, `PARTIAL_CLOSE` and `MODIFY` do not acquire an AI-confidence gate. Confidence expiry does not order liquidation. Verify that existing action invariants prevent a purported protective action from creating an unauthorized OPEN; any failure is a separate safety dependency to resolve, not permission to silently widen this confidence gate.

Confidence is one eligibility condition. Existing account restrictions, safety mode, position sizing, leverage, loss limits and other risk controls remain authoritative. The confidence system cannot weaken them. Missing, invalid, unavailable or contradictory required state denies new AI entry dispatch.

## Universal coverage and ARX boundaries

The shared standard follows trading context rather than labels such as beginner, professional, scalper or swing trader. It supports different payoff patterns without requiring a uniformly high win rate. RETURN and HEDGE are distinct, trusted purposes fixed before selection and validation; an AI cannot relabel a losing RETURN strategy as HEDGE. Other purposes require an explicit objective-specific validation contract before AI entry eligibility. Evaluating hedges at the portfolio level reflects their risk-management purpose: [CME's hedging example](https://www.cmegroup.com/education/articles-and-reports/agricultural-commodities-trader-and-hedging-with-futures) shows a hedge-leg loss offsetting a gain in the underlying exposure.

| Surface or dependency | Required boundary |
| --- | --- |
| Governed PAPER | `POST /api/paper/orders`; confidence applies to known AI OPEN lineage and is rechecked at transactional booking. Existing Safety Core and Risk Governor rules remain authoritative. |
| Trade Action Center | `POST /api/me/trade-actions` and `POST /api/me/trade-actions/:id/confirm`; a draft may exist as a proposal without execution authority. Creation or confirmation does not bypass the final route-specific entry check. SIMULATED, DEMO and LIVE retain their separate permissions. |
| Queues and autonomous consumers | Preserve context, actor, account, decision, purpose, quantity budget and expiry through enqueue, pickup, retry and dispatch. Existing paper checks do not prove this coverage. |
| Pure shadow and backtesting | Research outputs only. They cannot write execution permission or convert simulated outcomes into broker evidence. |
| Manual and protective actions | Preserve existing separate gates. Test interactions and shared account exposure; add no AI-confidence requirement to manual OPEN, CLOSE, PARTIAL_CLOSE or MODIFY. |
| Expansion | A new market, timeframe, account-cost condition, model or purpose needs demonstrated coverage or a new qualified context. Unsupported segments are not implicitly approved. |

The route mapping comes from the reviewed [governed-path helper](https://github.com/portava/arxai/blob/15b2dcb6eee73e5c6c857451956e4f8aee972d5a/artifacts/api-server/tests/support/governed.mjs). The implementation must inventory every production caller and final mutation boundary; that helper alone is not proof of complete coverage.

Each market adapter must declare relevant session calendars, halts, bar semantics, tick and contract units, currency conversion, settlement, expiry/exercise and corporate-action treatment, liquidity, fees, spread, funding and borrow assumptions. Applicability decisions must be explicit. No market inherits another market's defaults merely because a field is missing.

Each timeframe uses a declared outcome horizon and validated information age, signal lifetime and order deadline. Specify whether durations refer to wall time or trading time, and how session changes and market closures affect validity. The final deadline is an absolute time; refreshing a response never refreshes old market information.

Account permissions, costs, capacity, idempotency keys and records remain isolated by trader and account. Shared evidence cannot transfer another trader's approval or capital. Cost differences may require different calibrated probabilities because they change whether net profit is positive. Shared models may use only authorized data; evidence sharing does not grant access to another trader's private orders.

Refuse only the unsupported or invalid context unless a shared dependency makes wider containment necessary. Record the dependency and affected accounts or contexts. This prevents one thin-data market from disabling unrelated validated markets while preserving account-wide risk containment.

The current document task covers policy and acceptance design. It does not authorize repository changes, main merges, deployment, existing-database migrations, worker activation or broker operations. Those remain governed by the applicable task and owner permissions.

## Score and outcome definition

Store probability as a finite value from 0 to 1; display it as a percentage only with its named outcome, purpose, horizon and validation status. Conditional on passing the authorization and risk gates independent of this confidence threshold, it estimates the probability of the profile's declared success event using information available at decision time. Fill uncertainty remains included. For a RETURN profile, success means strictly positive net economic profit by the resolution horizon. For a HEDGE profile, success must be an explicitly measurable portfolio-outcome improvement against a frozen benchmark, within the specified cost budget; label the score as hedge-objective probability. Probabilities for different events or horizons are not directly comparable. The API schema must declare calibrated-probability type and 0-to-1 units; reject undeclared scales or heuristic weights. Only an explicit versioned adapter may convert a declared percentage representation.

The plan fixes entry conditions, order handling, allocation, exits, holding horizon, cost treatment and resolution rules. RETURN profit includes all applicable fees, spread, slippage, impact, funding, borrowing and product-specific costs. Report native currencies and any account-currency conversion rule, valuation time and settlement treatment. An unfilled or canceled-before-fill RETURN attempt has zero trading profit, less incurred costs, and is not positive. Partial fills use executed quantities. Residual positions use a predefined conservative liquidation valuation at the measurement horizon; this measurement rule does not dispatch an order. HEDGE labeling must separately specify actual portfolio outcomes, benchmark construction and the source of any counterfactual estimate. A model-predicted fall in volatility, VaR or another risk estimate is not an observed success label. Use matured outcomes under the declared measurement method; assess uncertainty in modeled comparators and retain their counterfactual status. Benchmark-relative success alone does not prove causal risk reduction.

Record every candidate before its outcome is known, including rejected, unfilled, canceled and unresolved candidates. A proposal rejected before dispatch has no observed attempted-order outcome; rejection is not evidence of a losing trade. Any estimated outcome for that proposal is counterfactual. Tag outcomes as live, simulated or counterfactual, and analyze those sources separately. The executable strategy must respect actual portfolio capacity and competing orders; isolated hypothetical fills cannot all be treated as simultaneously feasible. Missing outcomes cannot be dropped or converted to losses or successes opportunistically. The profile defines maturity, censoring, data-quality limits and deviation handling before evaluation. Every reported metric must identify its population, denominator, outcome source and exclusions so that proposed candidates, eligible candidates and submitted attempts are not conflated.

An LLM's stated certainty, token probability or agreement across repeated answers is not an accepted trading probability by itself. The complete scoring and calibration process must pass validation against this defined event.

## Required strategy approval profile

Each proposed entry must resolve to one immutable, versioned validation context. The context covers purpose, strategy, instrument or multi-leg portfolio, venue, direction, timeframe, resolution horizon, execution plan, model/calibrator identity and relevant costs. Its application to the trader's actual account must be verified. Fields must contain concrete values or justified applicability decisions; a blank, unsupported value or unreviewed exemption is incomplete. The same context may serve multiple traders only within demonstrated economic and operational equivalence.

| Profile area | Required specification |
| --- | --- |
| Scope and accountability | Account, instruments, venues, directions, timeframes, operating conditions, deployment mode and named owner, validation reviewer, activation authority and incident operator. One person may hold these roles, but decisions and evidence remain separate records. |
| Pipeline identity | Policy, strategy, model, prompt, tools, feature definitions, data sources, calibrator, evaluation code and execution adapter versions or content hashes. |
| Outcome and economics | Attempted-order and exit rules, resolution horizon, purpose-specific benefit/risk units, native-currency P&L and any meaningful capital or exposure denominator, costs, fill assumptions, portfolio constraints, economic hurdle and references to risk limits. |
| Entry threshold | Probability threshold, development objective, selection procedure, alternatives examined and sensitivity results. |
| Acceptance criteria | Calibration limits for eligible scores and deployment segments; economic and risk limits; units, comparison operators and rationale for every numerical limit. |
| Statistical design | Data splits, observation unit, dependence and overlap treatment, uncertainty methods and assumptions, precision or power targets, error budget, search and multiple-testing treatment, sample plan and outcome-quality limits. |
| Signal validity | Data-age and quote-age limits, permitted clock skew, signal lifetime, entry-price and cost bounds, invalidating events and outstanding-order deadlines. |
| Monitoring and recovery | Metric windows and schedules, minimum mature information, drift and operational triggers, response deadlines, alert destination, containment scope, recovery procedure and reactivation criteria. |
| Evidence and authorization | Validation evidence identifiers, permitted pilot or deployment limits, approval start and end times, validation freshness requirements and renewal conditions. |
| Recordkeeping | Required records, retention period, access controls, integrity checks and emergency audit procedure. |

Every numerical limit must have a unit, comparison operator, rationale and sensitivity analysis. Calibration tolerance, information requirements, costs and validity periods must fit the context. There is no universal high-win-rate cutoff, fixed observation count, shadow duration, signal lifetime or approval lifetime. Threshold selection follows the procedure below; a trader may impose stricter restrictions, but cannot waive the shared evidence standard or existing risk limits.

## Deterministic threshold selection

1. Register the purpose, comparator, profit or portfolio-benefit units, normalization, risk constraints, calibration tolerances and analysis method before selection. RETURN uses no entry as its comparator unless a different benchmark is explicitly justified. A HEDGE profile names the portfolio and risk objective, unhedged/current-portfolio comparator, costs and measurable success label.

2. Fit and calibrate on the designated data, then construct threshold candidates from distinct calibrated scores in the separate selection partition, together with explicit admit-all and abstain alternatives. A smaller grid is permitted only if its construction was fixed before selection-performance inspection.

3. Evaluate each candidate by chronological policy replay with the actual order plan, competing orders, capacity, independent risk gates and account costs. Define the denominator explicitly; average profit per trade cannot silently substitute for the intended return per unit of capital or time.

4. Discard candidates with inadequate information, unacceptable eligible-range calibration, breached risk limits or unsupported execution assumptions. Abstention is the baseline and does not count as a validated profitable strategy.

5. Choose the eligible candidate maximizing the prespecified conservative estimate of net purpose-specific benefit. Use the declared dependence-aware method. Resolve ties by the lower prespecified, purpose-appropriate risk/exposure measure, then fewer attempted orders, then the declared deterministic threshold ordering. Define that measure before selection; lower gross notional cannot be assumed to mean lower portfolio risk for a hedge. Selection-stage bounds rank candidates; they are not final confidence guarantees.

6. Record the chosen numeric threshold, every candidate result and sensitivity to adjacent thresholds and adverse costs. If none qualifies, record **NO ELIGIBLE THRESHOLD**. Freeze the winner and all methods before the one final acceptance analysis; do not try the runner-up on the same final outcomes.

7. Admit an entry only when finite `p >= threshold` and every other applicable gate passes. A future threshold change creates a new context version requiring appropriate new evidence. No autonomous adjustment may recover a failing approval or increase trading frequency.

Calibration tolerance, the error budget, economic hurdle, sample precision, dependence assumptions, expiry and execution costs remain evidence-backed context inputs. Their absence is an explicit qualification blocker. The procedure establishes how to derive and review them; it does not invent their values.

## Validation protocol

1. **Freeze the candidate.** Separate fitting, calibration, threshold selection and final chronological evaluation. Freeze pipeline versions, scope, analysis methods and all acceptance criteria before final evaluation. The initial qualification uses one fixed final analysis with no interim admission or discretionary reuse of final outcomes. Keep the complete experiment register. A final failure cannot be repaired by trying another threshold on the same results; revised candidates require fresh independent final evidence. Prevent overlapping outcome information from leaking across splits. These controls address [backtest selection effects](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

2. **Establish temporal validity.** Record when input information and model versions became available. Historical market-data splits do not remove future information embedded in an LLM's training. Where this contamination cannot be excluded, historical results support development only; final acceptance requires genuinely prospective predictions from the frozen pipeline. This risk is examined in [Glasserman and Lin's study of GPT trading signals](https://arxiv.org/abs/2309.17322).

3. **Establish sample adequacy.** Use the profile's precision or power requirements, accounting for serial dependence, overlapping trades and clustering. Identify the uncertainty method, its assumptions and diagnostics. Raw counts and elapsed days cannot establish sufficiency. Define relevant market conditions, stress scenarios and scope restrictions where evidence is absent. A failed assumption, inadequate effective information or excessive missing outcomes makes validation inconclusive.

4. **Test the probabilities actually used.** Evaluate calibration for the declared event across the supported candidate population and within eligible score ranges and deployment segments, using explicitly named outcome sources. Prespecify the estimator, partition or smoothing, tie handling, tolerance and uncertainty criterion. Report a proper scoring rule against a baseline fixed without final outcomes. Aggregate calibration error or Brier skill alone is insufficient; [calibration research](https://proceedings.mlr.press/v89/vaicenavicius19a.html) explains limitations of binned summaries. Shared or partially pooled models need transfer evidence, subgroup diagnostics and uncertainty for each supported context. Sparse unsupported contexts remain in research or shadow evaluation; data from another market cannot silently establish their validity.

5. **Test benefit and risk for the declared purpose.** Evaluate the executable policy against its frozen comparator under actual portfolio constraints. RETURN requires the prespecified lower uncertainty bound for net economic benefit to exceed a justified hurdle of at least zero. HEDGE requires its separately defined portfolio-benefit criterion to pass, including a lower uncertainty bound above the declared minimum improvement and compliance with the cost budget; positive standalone hedge profit is not required. The estimator must address benchmark uncertainty and counterfactual limitations. Include adverse costs, tail-loss and drawdown stress, and every independent risk criterion. Explain numerical hurdles, including zero if selected, and control the declared family of admission claims for selection, multiple contexts and repeated evaluations.

6. **Complete prospective shadow evaluation.** Log frozen predictions before outcomes occur and test the same labeling, calibration, economics, monitoring and operational requirements. Completion depends on the profile's information and coverage criteria. Keep simulated execution assumptions visible: paper environments can omit impact, latency slippage and queue position, as illustrated by [Alpaca's documented limitations](https://docs.alpaca.markets/us/docs/paper-trading). Shadow evidence can support a limited pilot under approved assumptions; it cannot establish actual fill quality.

The reviewer records **PASS**, **FAIL** or **INCONCLUSIVE** for each requirement, with reasons. Both FAIL and INCONCLUSIVE prevent activation. The immutable evidence package must contain the profile, data and prediction manifests, pipeline and analysis versions, experiment register, diagnostics, results and review record. Passing schema validation or finishing a backtest is not a validation pass.

## Activation and deployment states

| Policy state | Permitted behavior |
| --- | --- |
| BLOCKED | Implementation and evidence collection; no governed AI entry booking or dispatch. |
| SHADOW | Prospective predictions and pure simulation; no execution authority. |
| QUALIFIED PAPER | Approved contexts may use governed PAPER or SIMULATED execution only when all existing mode, account and final-booking controls pass. |
| DEMO PILOT | Separately authorized broker-demo scope; paper evidence alone does not authorize broker activity. |
| LIVE PILOT | Explicitly authorized live scope with defined exposure, loss, duration and operational limits. |
| LIVE | Approved expansion supported by pilot evidence and all runtime controls. |
| SUSPENDED | Stop affected new AI entries; cancel and reconcile affected unfilled entries under existing protection and audit rules. |

These are required policy states, not a claim that an equivalent state machine is already implemented. The named authority must bind passing evidence to exact context versions, account permissions, mode, limits and validity times. The scoring model cannot approve itself, relabel its purpose or change permissions. A high score, typed confirmation phrase, completed backtest or shadow preview grants no execution authority. Paper qualification does not authorize demo or live execution. Pilot approval and later expansion require separately scoped records supported by appropriate execution evidence.

Record suspension, expiry and revocation reasons durably. Expired or revoked authority cannot dispatch entries. For resumed operation after a suspension, the operator must resolve the cause, supply required revalidation evidence and obtain the scoped reactivation specified by the profile. Ordinary recovery may reuse existing valid authority only under the restart conditions below.

## Signal expiry and the final order gate

Each decision has a unique identifier, immutable profile and approval references, the input event and bar times, data availability times, generation time and an absolute UTC expiry. Define expiry from the approved lifetime and the age of the underlying information; generating a new response must not make old inputs fresh. A candle-based rule must name the exact boundary, such as the next bar close after the observed closed bar. At current time equal to or later than expiry, the decision is invalid. Clock uncertainty beyond the profile's limit also blocks entry.

Expiry is the earliest applicable signal deadline, input-validity deadline or approval end time. Entry-zone departure, excessive cost or spread, invalidated input, version mismatch and other profile-defined conditions can invalidate the decision sooner. A fresh decision requires fresh evaluation; editing a timestamp or reusing an expired score cannot renew it.

Every in-scope AI OPEN submission, replacement and child order must pass the authoritative gate immediately before final paper booking or broker dispatch. Verify current deployment authority, version binding, the context's probability threshold and economic-purpose requirements, expiry, data freshness, entry conditions, remaining authorized quantity, durable audit availability and every independent risk gate. Bind the result to the exact permitted order intent and execution bounds; the risk engine determines allowable size. The score and economic validation must cover that final size and order plan, either exactly or through a validated sizing and execution envelope. Changes outside that envelope require a fresh evaluation; even a reduced size can change costs and economics.

Within each affected execution scope, serialize dispatch authorization with suspension and revocation so that dispatch ordered after revocation cannot use the revoked authority. Enforce validity at the final execution boundary and reject stale queued work. An order already transmitted may still fill; cancellation and reconciliation remain necessary. Final-path controls address a failure mode identified in the [SEC's Knight Capital findings](https://www.sec.gov/newsroom/press-releases/2013-222).

## Decision result contract

The confidence evaluator returns **PASS**, **BLOCK** or **NOT APPLICABLE**, together with context/version, trader/account, OPEN-lineage decision, exact intent, quantity budget, timestamps, all evaluated conditions and stable reason identifiers. NOT APPLICABLE is reserved for trusted manual or exempt action types; it never grants permission from other gates. Unresolved or contradictory known-AI provenance blocks the affected entry. Existing trusted manual flows retain their current identification and authorization requirements; absence of AI-specific metadata alone does not add a confidence gate to a valid manual request.

Retain `AI_ENTRY_POLICY_PENDING` while no approved policy/context is integrated. The implemented reason catalogue must separately identify missing or unsupported context, invalid score, failed calibration/economic evidence, stale data, expired decision, invalidated approval, plan mismatch, insufficient quantity budget, independent safety refusal, unavailable audit and unknown execution state. Human-readable messages must state the failed condition without exposing another account's data.

A PASS is eligibility for one bound intent at the evaluated time, not an unrestricted reusable token. Final paper booking or dispatch rechecks authority and validity. Returning an already-booked result for an idempotent request is a replay; it must neither create a new order nor refresh expired authority.

## Outstanding orders and uncertain broker outcomes

On expiry, decision invalidation, suspension or revocation, stop further affected entry dispatches and initiate cancellation of their unfilled quantities. Invalidation includes breached entry conditions, stale or invalid inputs, excessive execution costs and mismatched versions. Monitor resting orders for these conditions within the profile's response deadlines. Track acknowledgements, partial fills and late fills until broker state is reconciled. A cancellation request is not confirmation that the order cannot fill. Preserve protective coverage for filled positions, including verified broker-specific bracket and OCO behavior. Follow existing authorized incident procedures if protection cannot be maintained; do not presume an emergency fallback exists or bypass mandatory protective-action audit writes.

Use a stable client order identifier for each submission and an explicit cumulative quantity budget for its decision and child orders. Before retrying an uncertain submission, query and reconcile the existing identifier. Filled, open and unresolved quantities count against that budget and applicable exposure limits. Heterogeneous multi-leg plans require per-instrument and per-leg budgets plus portfolio risk controls; unlike contract quantities or currencies must not be added into one scalar allowance. Unknown outcomes block potentially duplicative or exposure-increasing actions in the affected scope; widen containment when shared account state makes narrower isolation unsafe.

On startup or reconnection, AI entry dispatch stays blocked until durable authority and policy state are restored, broker orders and positions are reconciled, validity and versions are checked, and required monitoring is available. Restart never clears a recorded suspension, expiry or revocation. A previously active scope may resume under existing unexpired authority only if all checks pass and no incident requires reactivation.

## Monitoring and change control

The profile must distinguish synchronous order checks, continuous operational monitoring and statistical review of mature outcomes. Define numeric deadlines, windows, thresholds, minimum information and owners for each. Operational triggers include stale data, invalid clocks, lost broker state, rejected version bindings, audit failure and breached independent risk limits. Statistical triggers include unacceptable calibration in eligible segments, economic deterioration, excessive missing outcomes and conditions outside the validated operating scope.

Operational incident checks remain continuous. Statistical monitoring must use mature outcomes and a prespecified evaluation schedule, information threshold, error allocation and reactivation rule. No opportunistic repeated check may turn an unqualified context into a qualified one. Fixed-time intervals do not supply guarantees across arbitrary repeated looks; an alternative time-uniform method requires its own reviewed assumptions and versioned protocol, as discussed in [confidence-sequence research](https://arxiv.org/abs/1810.08240). Missing or immature outcomes follow the context's evidence-freshness rule and never count as a pass.

Any change to model, prompt, tools, calibrator, threshold, features, data semantics, outcome rules, execution assumptions or deployment scope invalidates the affected approval unless it falls within an explicitly validated change envelope. Administrative edits may follow a separate documented process. For vendor models, specify version pinning or change detection and response; inability to establish the approved model identity blocks new AI entries. Calendar renewal cannot replace fresh evidence or resolve an invalidation.

## Audit records and failure behavior

For transactional PAPER booking, the order mutation and mandatory decision/placement evidence must commit or roll back together. For external dispatch, durable authorization and dispatch-intent evidence must exist before transmission. Required records include the candidate, decision and order-intent identifiers; policy, pipeline, profile, evidence and approval references; input provenance and timestamps; score and expiry; gate results and reason codes; authorized quantity; and dispatch intent. Record blocked candidates and decisions as well as approved ones.

Append correlated broker requests, acknowledgements, amendments, cancellations, retries, fills, costs, outcome labels and their source, deviations, operator actions and state changes. Retain the original model recommendation, relevant tool outputs, score and supporting data or reproducible references needed to reconstruct each decision and validation result, subject to the profile's access and retention controls. Rerunning a stochastic or vendor-hosted model is not a substitute for retaining its actual output. Protect record integrity and detect gaps or alterations.

If required durable entry evidence cannot be written, block further affected AI entries and reconcile any already-dispatched orders. Current ARX governed protective decisions and mutations also depend on successful vault/audit persistence; failure can refuse or roll back the operation. This confidence policy preserves those gates and does not assert an audit-outage fallback. Any future continuity mechanism requires an explicit design, owner, durability contract and failure tests before it can be claimed. The [reviewed safety document](https://github.com/portava/arxai/blob/15b2dcb6eee73e5c6c857451956e4f8aee972d5a/docs/SELF_TRADING_SAFETY_POLICY_2026_10_28.md) also identifies legacy writers outside chain serialization: whole-table integrity remains an open dependency, not an assumed property.

## Implementation acceptance

Acceptance is conjunctive: every applicable route, statistical requirement, account boundary and lifecycle invariant must pass on the recorded build. A passing average score cannot compensate for a failing entry-control or protective-path requirement. The concrete tests below are mandatory; additional context-specific cases may be required.

| Test family | Required observable result |
| --- | --- |
| Origins and route parity | Ruby, automation and strategy OPEN attempts face equivalent policy on PAPER, Action Center confirmation and every final consumer. Known AI lineage cannot escape through manual/api/system labels or a confirmation phrase. |
| Independent modes and tenant isolation | Confidence PASS never bypasses Safety Core, Risk Governor or account ownership. Another trader's profile, quote, costs, permission or idempotency key cannot authorize the intent. |
| Boundary and validity | Invalid or nonfinite scores fail; the probability boundary is inclusive; expiry at `now >= expires_at` fails. Session changes, stale quotes, purpose mismatch and changed order size outside the validated envelope are handled explicitly. |
| Concurrency and retries | Revocation while queued prevents later authorization. Concurrent keyed retries create at most one booking and placement trail. Filled, open and unresolved quantities consume the same authorized budget. |
| Refusal side effects | Refusals create no unintended order, queue, reservation or position mutation. Compare row values and statuses as well as counts; a linked refusal audit is permitted. |
| Audit and protection | Inject entry-audit failures and verify no unaudited booking. Preserve and accurately test current protective rollback/refusal semantics; do not count a nonexistent emergency fallback as coverage. |
| Eligible-score calibration | The 500-case reference dataset—400 predictions of 50% with 200 successes, and 100 predictions of 95% with 78 successes—must expose eligible-range miscalibration. Using two fixed-score, tie-preserving reliability groups gives ECE of 3.4 points. Against a fixed 0.5 baseline the Brier score improves from 0.25 to 0.2401. Neither aggregate result can by itself yield PASS. |
| Purpose and payoff | A high-win-rate, negative-net-benefit RETURN policy fails. A HEDGE is evaluated against its registered portfolio objective and costs; post-result relabeling cannot rescue a failure. |
| Dependence and contamination | Duplicating an observation cannot manufacture independent information. Final-data tuning invalidates acceptance evidence. Simulated or counterfactual outcomes cannot become live fills or observed losses. |
| Recovery and market mechanics | Exercise partial fills, cancellation races, broker uncertainty, restarts, market closures, stale queues and relevant product events for every supported adapter. Unsupported mechanics block that context. |
| Reproduction | Retained inputs, model outputs, labels, analysis version and frozen criteria reproduce the reported result and decision. All exclusions and missing outcomes reconcile. |

## Deliverables and completion boundaries

| Deliverable | Completion rule |
| --- | --- |
| ARX route and dependency manifest | Every known AI OPEN producer, confirmation route, final consumer and relevant audit/risk/protection dependency has a code reference and assigned owner. Missing routes or unresolved bypasses block control acceptance. |
| Shared gate implementation | The decision contract, provenance preservation, context resolution, account isolation and final-boundary checks pass the mandatory route and fault tests on an identified build. |
| Context qualification packet | Each requested market/timeframe/purpose has a populated context, deterministic threshold-selection record, frozen analysis plan, data/outcome manifests and PASS/FAIL/INCONCLUSIVE report. No pooled average may hide an unsupported segment. |
| Operational readiness packet | Adapter-specific lifecycle evidence, expiry rules, monitoring ownership, incident containment and known protective/audit dependencies are documented and tested. |
| Scoped activation record | The authorized reviewer binds passing evidence to specific contexts, accounts, mode, limits and validity times. Nothing activates automatically. |

The present unresolved inputs are the actual strategy/context identities and datasets, justified numerical parameters, production route inventory, verified execution mechanics and the protective-audit/legacy-chain dependencies identified above. Each implementation owner must turn these into named findings with evidence and closure criteria. Documentation completion, software-control acceptance, statistical qualification and activation are distinct milestones; completing one cannot be reported as completing the others.

The acceptance packet must include the context manifest; decision schema and route map; deterministic labeler and evaluation version; full experiment and outcome manifests; control-test receipts; statistical report; dependency ledger; and scoped reviewer decision. Every result names the exact commit/build, mode, adapter, data version, method, numerator/denominator, expected versus observed behavior, comparison limit, result and reason. Retain failed and skipped checks. Another evaluator must reproduce the same calculations and acceptance outcome from retained inputs. No unresolved defect affecting entry control, isolation, evidence integrity or protection may be recorded as a pass.

The controls in this policy are implementation requirements for this application. Regulatory materials supply engineering lessons within their own scopes. The Federal Reserve's current model-risk guidance explicitly excludes generative and agentic AI in [footnote 3](https://www.federalreserve.gov/frrs/guidance/supervisory-guidance-on-model-risk-management.htm); it does not establish approval of this trading agent or prescribe these parameters.

