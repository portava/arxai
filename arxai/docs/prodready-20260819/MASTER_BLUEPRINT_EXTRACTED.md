# ARX AIMaster Architecture, Intelligenceand Research Blueprint

Complete product, intelligence, risk, execution, evidence, research and delivery reference

Analyze  |  Risk  |  eXecute

Owner reference guide  |  August 2026

# How to use this guide

This document describes the major ARX product, trading-engine, broker, account, safety, learning, and operator functions discussed in the product vision, AXIOM build specification, and multi-broker design. It is a function encyclopedia, not a promise that every listed capability is already deployed.

Function: A named capability with one job and a defined boundary.

Primary use: How the capability behaves in the complete ARX workflow.

Inputs and outputs: The information it consumes and the evidence or action it produces.

Dependencies: Other services that must be healthy or available.

Safety / failure behavior: What happens when evidence, permission, or system state is insufficient.

Place in ARX: Whether the capability is core, a safety gate, an interface, or a later-stage function.

## The governing rule

Deterministic risk rules  >  AI reasoning  >  strategy  >  execution

ARX may analyze, explain, propose, and learn, but capital exposure is controlled by deterministic permissions, data-health checks, risk authorization, broker capability checks, and audited execution. WAIT, SUSPEND, UNKNOWN, and COMPLIANCE_HOLD are valid results.

## The complete operating loop

Layer

Question answered

Typical result

Cannot do

SENSE

What is happening and can the data be trusted?

Market/data context

Authorize capital

SIGNAL

Is there a validated opportunity now?

Candidate or WAIT

Submit an order

RISK

May capital be exposed, and how much?

Approve, reduce, reject, pause

Expand owner limits

EXECUTE

Did the broker receive and fill the authorized order?

Verified order/fill state

Reinterpret the trade

GUARD

How must an open position be protected or closed?

Hold, reduce, close, emergency exit

Move loss boundaries outward

MEMORY

What evidence must be retained?

Immutable case file

Rewrite history

REVIEW

What can be learned from the evidence?

Analysis and promotion proposal

Change live rules directly

COMMAND

What does the authorized operator need to see or control?

Dashboard, explanation, action

Bypass server controls

# Function index

The catalog contains the following functions, grouped by responsibility. Numbering is stable within this edition for discussion and implementation planning.

## ARX SENSE - Market intelligence and data truth

1. Broker Connection Manager  |  2. Broker Adapter Registry  |  3. Runtime Symbol Discovery  |  4. Canonical Symbol Registry  |  5. Broker-Native Candle Service  |  6. Tick-to-Candle Aggregator  |  7. Market Data Router  |  8. Tick Ingest and Immutable Store  |  9. Data Quality Monitor  |  10. Change Detector and Event Bus  |  11. Account and Position Snapshot Ingest

## ARX SIGNAL - Features, market state, and opportunities

12. Quantitative Feature Engine  |  13. Market State Engine  |  14. Market Structure Interpreter  |  15. Cross-Market Intelligence  |  16. Production Edge Library  |  17. Edge Matcher  |  18. Probability and Expectancy Engine  |  19. Opportunity and Timing Gate  |  20. Market Scanner  |  21. Strategy Modules  |  22. WAIT and SUSPEND Decisions

## ARX RISK - Deterministic capital defense

23. Hard Risk Kernel  |  24. Fixed-Fractional Position Sizing  |  25. Per-Trade and Aggregate Exposure Limits  |  26. Correlation and Concentration Guard  |  27. Drawdown and Loss-Streak Guard  |  28. Execution Quality Guard  |  29. Circuit Breakers and Global Kill Switch  |  30. Risk Reservation and Concurrency Lock

## ARX EXECUTE - Orders, fills, and broker truth

31. Trade Intent and Confirmation  |  32. Execution Orchestrator  |  33. Order Request Factory  |  34. Idempotency and Duplicate Prevention  |  35. Order State Machine  |  36. Partial Fill and Cancel/Replace Handling  |  37. Protective Stop and Target Placement  |  38. MT5 Expert Advisor Command Channel  |  39. Broker Event Ingest and Fill Verification  |  40. Reconciliation and Orphan Detection

## ARX GUARD - Live position supervision

41. Position Lifecycle Manager  |  42. Frozen Thesis and Invalidation Monitor  |  43. Partial Profit and Trailing Policy  |  44. Emergency Exit  |  45. Independent Re-entry Qualification

## ARX MEMORY and REVIEW - Evidence, learning, and validation

46. Immutable Decision and Trade Ledger  |  47. Structured Trade Journal  |  48. Post-Trade Review  |  49. Ruby Trading Assistant  |  50. Private Conversation Memory  |  51. Anonymous Aggregate Learning  |  52. Research Lab  |  53. Replay and Determinism  |  54. Shadow and Demo Validation  |  55. Strategy Arena and Allocation Review  |  56. Model, Edge, and Configuration Registry

## ARX COMMAND - Operator experience and controls

57. Command Center Dashboard  |  58. Smart Chart and Chart Truth Gate  |  59. Trade Ticket  |  60. Orders, Positions, and History Center  |  61. Watchlists and Workspace Search  |  62. Notifications and Incident Alerts  |  63. Explainability and Rejection Reasons

## Accounts, workspaces, and managed allocation

64. Self-Trading Mode  |  65. Managed Allocation Mode  |  66. Master User Control Plane  |  67. Workspace Roles and Permissions  |  68. Per-User Usage and Risk Limits  |  69. Assignment Isolation and Credential Shielding  |  70. Compliance and Eligibility Gate  |  71. Broker Capability and Entitlement Service

## Operations, security, and release controls

72. Health, Heartbeat, and Dependency Monitor  |  73. Observability and Incident Control  |  74. Secrets and Authorization Vault  |  75. Adapter Certification Suite  |  76. Release Promotion Pipeline  |  77. Backup, Recovery, and Restart Reconciliation  |  78. LLM Provider Abstraction

# Detailed function catalog

Each entry defines the capability boundary and the behavior that other parts of ARX are allowed to rely on.

## ARX SENSE - Market intelligence and data truth

### 1. Broker Connection Manager

Creates, verifies, refreshes, suspends, and removes each broker connection.

Primary use

Keeps credentials server-side, separates demo from live, and exposes a stable connection ID to every downstream service.

Who uses it

Self-traders, master users, operations

Inputs

OAuth authorization or API credentials; broker; environment; account selection

Outputs

Connection record, capability profile, health state, last successful sync

Dependencies

Secrets vault; broker adapter; eligibility service; audit ledger

Safety / failure behavior

Never reveals credentials to assigned users. Authentication failure blocks trading and raises an operator alert.

Place in ARX

Core platform function

### 2. Broker Adapter Registry

Presents one canonical interface over brokers with different APIs, symbols, order types, and event models.

Primary use

Routes requests only to a certified adapter and records the adapter/schema version used for every decision and order.

Who uses it

Execution services and integration engineers

Inputs

Broker identifier; adapter version; certified capability matrix

Outputs

Canonical market-data, account, order, position, reconciliation, and health methods

Dependencies

Adapter certification suite; domain schemas; version registry

Safety / failure behavior

Unsupported capabilities fail explicitly. No silent emulation of broker features.

Place in ARX

Core platform function

### 3. Runtime Symbol Discovery

Finds the broker's real, currently tradable symbol identifiers instead of relying on guessed codes.

Primary use

Queries instruments/active-symbol endpoints, filters by entitlement and account type, and refreshes on broker metadata changes.

Who uses it

Market-data router, scanner, execution core

Inputs

Connected broker; account jurisdiction; product permissions

Outputs

Normalized instrument records mapped to broker-native symbols

Dependencies

Broker adapter; symbol registry; eligibility service

Safety / failure behavior

A missing or ambiguous mapping makes the instrument unavailable; ARX does not guess.

Place in ARX

Required before live data or execution

### 4. Canonical Symbol Registry

Gives the same economic instrument a stable ARX identity across brokers.

Primary use

Normalizes precision, tick size, contract size, quote currency, sessions, and order constraints while preserving the raw broker identity.

Who uses it

All analytics, risk, execution, and reporting services

Inputs

Broker symbol metadata; asset class; currency; contract specifications

Outputs

ARX symbol key plus broker-specific aliases and trading constraints

Dependencies

Runtime discovery; database; adapter metadata

Safety / failure behavior

Mappings are versioned and reviewed. Cross-broker equivalence is never inferred from a similar ticker alone.

Place in ARX

Core platform function

### 5. Broker-Native Candle Service

Supplies charts and models with candles from the connected broker wherever available.

Primary use

Uses the broker as the primary truth source so displayed and traded prices share the same venue context.

Who uses it

Charts, scanner, Ruby, strategies, research

Inputs

Connection, normalized symbol, timeframe, time range

Outputs

OHLCV candles with source, timestamps, completion state, and provenance

Dependencies

Broker adapter; market-data entitlements; cache

Safety / failure behavior

No fabricated candles. Partial candles are labeled; missing entitlements produce unavailable state.

Place in ARX

Owner-directed market-data design

### 6. Tick-to-Candle Aggregator

Constructs candles only when a broker offers ticks but no usable historical candle endpoint.

Primary use

Builds bars using broker timestamps, persists gaps, and applies the same algorithm in replay and production.

Who uses it

Market-data service and research

Inputs

Validated tick stream; timeframe boundary; broker clock

Outputs

Deterministic OHLCV bars with lineage to raw ticks

Dependencies

Tick ingest; clock service; immutable tick store

Safety / failure behavior

Never interpolates silent gaps. Output is blocked when source quality falls below threshold.

Place in ARX

Fallback, not preferred source

### 7. Market Data Router

Chooses the best authorized data path for each broker, symbol, and use case.

Primary use

Prioritizes broker-native data, falls back only to certified alternatives, and keeps provenance attached end to end.

Who uses it

All product surfaces that need prices or candles

Inputs

Connection health; adapter capabilities; entitlements; symbol; timeframe

Outputs

Selected source, data stream, quality state, and reason code

Dependencies

Connection manager; adapters; candle/tick services

Safety / failure behavior

A route change is logged. If no trustworthy source exists, the result is UNKNOWN rather than synthetic data.

Place in ARX

Core platform function

### 8. Tick Ingest and Immutable Store

Captures raw broker ticks as the evidence base for replay, features, and incident reconstruction.

Primary use

Preserves broker time and ingest time, records reconnect boundaries, and retains lineage into every derived dataset.

Who uses it

Quant engine, audit, research, operations

Inputs

Broker tick event and receive timestamp

Outputs

Deduplicated tick record, sequence number, source connection, archive pointer

Dependencies

Market gateway; PostgreSQL/Parquet; event bus

Safety / failure behavior

Duplicates, regressions, and gaps are recorded; raw evidence is append-only.

Place in ARX

AXIOM production foundation

### 9. Data Quality Monitor

Determines whether market data is fresh, ordered, complete enough, and safe to use.

Primary use

Uses instrument-specific expected cadence rather than one universal timeout and emits quality events on material change.

Who uses it

Risk kernel, scanner, strategies, operations

Inputs

Tick/candle cadence; sequence; gaps; clock offset; latency

Outputs

HEALTHY, DEGRADED, STALE, or UNAVAILABLE plus reason codes

Dependencies

Tick/candle services; clock sync; observability

Safety / failure behavior

STALE or UNAVAILABLE blocks new entries. Gaps are never silently hidden.

Place in ARX

Hard safety dependency

### 10. Change Detector and Event Bus

Recomputes expensive state only when a meaningful market or system change occurs.

Primary use

Separates noise from material changes while a heartbeat independently checks liveness and timeouts.

Who uses it

Feature, state, edge, risk, and operations services

Inputs

Validated market events and configured change thresholds

Outputs

Typed, versioned event envelopes with correlation IDs and importance

Dependencies

Market gateway; schema registry; event queue

Safety / failure behavior

Events are ordered per source where required, idempotent, and replayable.

Place in ARX

AXIOM operating model

### 11. Account and Position Snapshot Ingest

Maintains ARX's current view of balances, buying power, orders, and positions.

Primary use

Refreshes on broker events and scheduled polls, preserving broker-native IDs and timestamps.

Who uses it

Dashboard, risk, execution, reconciliation

Inputs

Broker account endpoints and streaming account events

Outputs

Canonical account snapshot and position/order state

Dependencies

Broker adapter; account registry; ledger

Safety / failure behavior

Local state is never assumed authoritative after reconnect; discrepancies trigger reconciliation.

Place in ARX

Core platform function

## ARX SIGNAL - Features, market state, and opportunities

### 12. Quantitative Feature Engine

Turns validated prices into a minimal, reproducible set of trading features.

Primary use

Uses identical formulas in research, replay, shadow, and production, across validated time and tick horizons.

Who uses it

State engine, edge matcher, probability models, research

Inputs

Raw ticks/candles; feature configuration; symbol metadata

Outputs

Versioned feature snapshots such as returns, directional efficiency, volatility, compression, persistence, and normalized slope

Dependencies

Data-quality gate; math library; configuration registry

Safety / failure behavior

No hidden magic numbers. Any feature that fails ablation or stability testing is removed.

Place in ARX

AXIOM core

### 13. Market State Engine

Classifies current conditions so strategies operate only in regimes they understand.

Primary use

Prefers the simplest calibrated model that survives out-of-sample testing and exposes uncertainty directly.

Who uses it

Scanner, edge matcher, decision core, dashboard

Inputs

Feature snapshots; calibrated state model; reliability thresholds

Outputs

TREND, RANGE, COMPRESSION, EXPANSION, TRANSITION, INDECISION, or UNKNOWN with reliability

Dependencies

Feature engine; model registry; calibration service

Safety / failure behavior

TRANSITION and INDECISION default to WAIT; UNKNOWN suspends new entries.

Place in ARX

ARX SENSE/SIGNAL boundary

### 14. Market Structure Interpreter

Describes directional structure and location in operator-readable terms.

Primary use

Produces structured facts rather than free-form stories; strategies may consume only versioned, tested facts.

Who uses it

Ruby, scanner, strategy modules, review

Inputs

Price series; extrema; volatility scale; state snapshot

Outputs

Structure facts such as higher highs/lows, boundaries, breakouts, rejection, exhaustion, and invalidation levels

Dependencies

Feature engine; state engine

Safety / failure behavior

Structure language cannot override quantitative gates or risk.

Place in ARX

Product intelligence function

### 15. Cross-Market Intelligence

Measures relationships between instruments without assuming they are permanent.

Primary use

Tracks dynamic relationships separately per horizon and disables the result when alignment or sample quality is weak.

Who uses it

Edge matcher and risk kernel

Inputs

Synchronized feature/state snapshots across symbols

Outputs

Rolling dependence, lead/lag evidence, dispersion, cluster state, reliability

Dependencies

Clock alignment; feature store; statistical validation

Safety / failure behavior

Correlation is treated as time-varying evidence, not a fixed causal claim.

Place in ARX

AXIOM core

### 16. Production Edge Library

Stores the exact, validated conditions under which a strategy has demonstrated an edge.

Primary use

Separates research candidates from production-approved logic and records minimum reliability and cost assumptions.

Who uses it

Edge matcher, decision core, research lab

Inputs

Versioned edge definition; eligible symbols/regimes; entry/exit rules; validation report

Outputs

Active/retired edge versions and machine-readable contracts

Dependencies

Model registry; validation artifacts; configuration control

Safety / failure behavior

No edge reaches production without promotion gates; retirement is immediate when a breaker fires.

Place in ARX

Core strategy platform

### 17. Edge Matcher

Detects when current evidence satisfies a production edge contract.

Primary use

Evaluates only eligible edge versions for that symbol and regime and captures the exact evidence that matched.

Who uses it

Probability engine and decision core

Inputs

Market state, feature snapshot, cross-market context, active edge versions

Outputs

EdgeActivated or EdgeInvalidated event with evidence snapshot

Dependencies

Feature/state engines; edge library; event bus

Safety / failure behavior

A partial match is not a signal. Missing inputs invalidate or suspend the edge.

Place in ARX

AXIOM core

### 18. Probability and Expectancy Engine

Estimates whether a candidate is likely to reach its target before stop and whether its net value is positive.

Primary use

Includes spread, commissions, slippage, timeouts, and model reliability; calibration is evaluated against observed outcomes.

Who uses it

Opportunity gate and decision core

Inputs

Active edge; calibrated model; target/stop geometry; costs; timeout outcome

Outputs

Calibrated probability, conservative expected value, reliability, and confidence bounds

Dependencies

Model registry; cost model; edge validation

Safety / failure behavior

If the lower confidence bound is not positive or calibration is poor, the result is WAIT.

Place in ARX

AXIOM core

### 19. Opportunity and Timing Gate

Separates a valid setup from a valid entry at this moment.

Primary use

Allows a strong setup to remain visible without authorizing a mistimed order.

Who uses it

Decision core and scanner

Inputs

Edge activation; probability/EV; risk availability; entry-window rules

Outputs

EARLY, READY, LATE, or EXPIRED plus a canonical candidate record

Dependencies

Edge library; probability engine; clock service

Safety / failure behavior

Only READY proceeds. Expired candidates cannot be revived without a fresh qualification.

Place in ARX

AXIOM core

### 20. Market Scanner

Shows qualified and developing opportunities across connected, eligible instruments.

Primary use

Supports in-page Buy/Sell with editable risk and order fields while keeping signal and execution permissions separate.

Who uses it

Self-traders, master users, assigned users with view rights

Inputs

Market state; opportunities; account eligibility; user workspace filters

Outputs

Ranked opportunity cards, reason codes, freshness, and optional trade-ticket launch

Dependencies

SENSE/SIGNAL services; account assignment; Ruby rationale; chart truth

Safety / failure behavior

Never labels a prediction as guaranteed. Stale data disables action controls.

Place in ARX

Operator-facing function

### 21. Strategy Modules

Encapsulate different edge families without duplicating execution, risk, memory, or controls.

Primary use

Each module is independently versioned, tested, enabled, capped, and attributable.

Who uses it

Quant researchers and the decision system

Inputs

Validated module contract and eligible regimes

Outputs

Momentum, breakout, mean-reversion, continuation, reversal, or volatility-expansion candidates

Dependencies

Edge library; shared feature/state services

Safety / failure behavior

A strategy cannot submit an order directly or change risk limits.

Place in ARX

ARX platform capability

### 22. WAIT and SUSPEND Decisions

Make refusal and uncertainty explicit, observable system outcomes.

Primary use

Records why no trade occurred and exposes rejected/withheld opportunities in COMMAND.

Who uses it

Decision core, operators, review

Inputs

Failed qualification gates or operational uncertainty

Outputs

WAIT for insufficient trade evidence; SUSPEND for unsafe system state; reason codes

Dependencies

All upstream gates; decision ledger

Safety / failure behavior

Neither state may be converted to BUY/SELL by an LLM or UI shortcut.

Place in ARX

Non-negotiable behavior

## ARX RISK - Deterministic capital defense

### 23. Hard Risk Kernel

Makes the final deterministic decision about whether capital may be exposed.

Primary use

Applies the same rule hierarchy to every channel and produces a single-use authorization tied to a decision and expiry.

Who uses it

Every manual and automated trading path

Inputs

Candidate decision; account snapshot; limits; exposure; health; mission state

Outputs

APPROVED, APPROVED_REDUCED, REJECTED, or SYSTEM_PAUSE with immutable authorization

Dependencies

Risk configuration; account state; correlation engine; health services

Safety / failure behavior

Risk outranks AI, strategy, and execution. No downstream service can expand an authorization.

Place in ARX

Central safety authority

### 24. Fixed-Fractional Position Sizing

Calculates quantity from the permitted loss at the protective stop.

Primary use

Caps quantity by account, symbol, margin, assignment, and liquidity constraints.

Who uses it

Risk kernel and trade ticket

Inputs

Account equity; risk fraction; entry/stop distance; contract size; broker increments

Outputs

Rounded, broker-valid quantity and worst-case stop loss estimate

Dependencies

Symbol registry; account state; broker capability profile

Safety / failure behavior

No martingale, doubling, or loss-recovery sizing. Falling behind never increases risk.

Place in ARX

Default v1 sizing

### 25. Per-Trade and Aggregate Exposure Limits

Prevents one trade or the combined portfolio from exceeding approved risk.

Primary use

Counts open and reserved risk before an order is sent, including concurrent requests.

Who uses it

Risk kernel and managed allocation

Inputs

Proposed stop loss; open-position risk; pending reservations; account limits

Outputs

Approval, reduced size, or rejection with remaining risk budget

Dependencies

Position ledger; reservation service; assignment ceilings

Safety / failure behavior

Reservations are atomic and released on terminal failure/cancel to prevent race-condition over-allocation.

Place in ARX

Hard control

### 26. Correlation and Concentration Guard

Limits multiple positions that are economically the same bet.

Primary use

Uses validated dynamic relationships and conservative fallback groupings when evidence is unavailable.

Who uses it

Risk kernel and master account controls

Inputs

Dynamic clusters; symbols; sides; position risks; user/account ceilings

Outputs

Cluster exposure and approval/reduction/rejection

Dependencies

Cross-market intelligence; symbol taxonomy; portfolio state

Safety / failure behavior

Unknown correlation does not create extra capacity; conservative caps apply.

Place in ARX

Hard control

### 27. Drawdown and Loss-Streak Guard

Reduces or stops activity when realized outcomes breach approved tolerance.

Primary use

Evaluates daily, mission, rolling, and total drawdown independently.

Who uses it

Risk kernel, mission manager, operations

Inputs

Realized/unrealized P&L; rolling windows; consecutive losses; owner limits

Outputs

Normal, reduced-risk, close-only, or paused state

Dependencies

Trade ledger; account snapshots; configuration registry

Safety / failure behavior

A loss deficit cannot trigger larger size. Limit increases require owner authorization.

Place in ARX

Hard control

### 28. Execution Quality Guard

Blocks new exposure when slippage, latency, rejections, or broker behavior deteriorate.

Primary use

Compares live distributions with certified tolerances per broker, symbol, and order type.

Who uses it

Risk kernel and operations

Inputs

Observed send/ack/fill times; requested/fill prices; reject rates

Outputs

Healthy, degraded, or suspended execution state

Dependencies

Execution telemetry; adapter certification; alerts

Safety / failure behavior

Persistent deterioration triggers circuit breakers and requires explicit recovery evidence.

Place in ARX

Hard control

### 29. Circuit Breakers and Global Kill Switch

Stops a narrow component or the entire platform when a critical invariant fails.

Primary use

Supports graduated containment before global shutdown while preserving the most conservative active state.

Who uses it

Owner, operations, automated guards

Inputs

Per-edge, per-symbol, per-broker, per-account, or global fault condition

Outputs

Disabled scope; close-only option; reason; actor; timestamp

Dependencies

Health monitor; risk kernel; command center; audit log

Safety / failure behavior

Activation is immediate and durable across restarts. Clearing requires authorized, audited action.

Place in ARX

Emergency control

### 30. Risk Reservation and Concurrency Lock

Prevents simultaneous users or strategies from spending the same risk capacity.

Primary use

Serializes risk capacity without forcing the entire platform into one queue.

Who uses it

Self-trading and managed allocation execution paths

Inputs

Account ID; assignment; proposed risk; idempotency key

Outputs

Atomic reservation or rejection; reservation expiry

Dependencies

Transactional database; risk kernel; order state machine

Safety / failure behavior

A request cannot reach the broker without a valid reservation and authorization.

Place in ARX

Required for multi-user accounts

## ARX EXECUTE - Orders, fills, and broker truth

### 31. Trade Intent and Confirmation

Captures exactly what the operator or automation is asking ARX to trade.

Primary use

Manual orders show a final confirmation; automated orders require an active automation authorization.

Who uses it

Self-traders and authorized automations

Inputs

Symbol; side; order type; quantity/risk; entry; stop; target; account

Outputs

Immutable intent linked to user, workspace, decision, and confirmation

Dependencies

Trade ticket; permissions; risk kernel

Safety / failure behavior

Confirmation cannot waive risk, health, eligibility, or broker constraints.

Place in ARX

Entry point to execution

### 32. Execution Orchestrator

Moves an authorized intent through validation, submission, acknowledgement, fill, and final state.

Primary use

Calls only the adapter, preserves one correlation chain, and never reinterprets strategy direction or size upward.

Who uses it

All trading channels

Inputs

Decision ID; risk authorization; broker connection; trade intent

Outputs

Canonical order and event timeline

Dependencies

Risk kernel; broker adapter; durable ledger; reconciliation

Safety / failure behavior

Expired or mismatched authorization is rejected. Unknown broker outcomes enter UNKNOWN, not automatic retry.

Place in ARX

Core execution function

### 33. Order Request Factory

Translates a canonical order into the exact broker payload permitted by that account.

Primary use

Applies precision, lot steps, time-in-force, order-class, and protective-order rules.

Who uses it

Execution orchestrator

Inputs

Canonical intent; symbol mapping; capability/constraint profile

Outputs

Validated broker-native request and normalized local representation

Dependencies

Adapter; symbol registry; capability service

Safety / failure behavior

Unsupported combinations fail before submission; no silent substitution that changes economics.

Place in ARX

Broker abstraction function

### 34. Idempotency and Duplicate Prevention

Ensures retries and repeated clicks do not create duplicate exposure.

Primary use

Deduplicates at the ARX boundary and, where supported, supplies broker client-order IDs.

Who uses it

UI, API, orchestrator, adapters

Inputs

Idempotency key; account; intent hash; prior order state

Outputs

Original result or one new canonical order

Dependencies

Order ledger; transactional locks; adapter capabilities

Safety / failure behavior

UNKNOWN submission is reconciled before any resubmission.

Place in ARX

Hard execution control

### 35. Order State Machine

Provides one consistent lifecycle across brokers.

Primary use

Allows only legal transitions and records every transition as an event.

Who uses it

Dashboard, execution, reconciliation, audit

Inputs

Broker acknowledgements, fills, cancels, rejects, polls

Outputs

CREATED, VALIDATED, SUBMITTING, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, UNKNOWN

Dependencies

Execution orchestrator; broker event ingest; database

Safety / failure behavior

Terminal states are immutable; out-of-order broker events are retained and reconciled.

Place in ARX

Core execution function

### 36. Partial Fill and Cancel/Replace Handling

Manages orders that fill in pieces or need a controlled amendment.

Primary use

Recalculates protected quantity and risk without exceeding the original authorization.

Who uses it

Execution core and position manager

Inputs

Fill events; remaining quantity; broker amendment capabilities

Outputs

Updated order/position quantities, cancel/replace chain, residual risk

Dependencies

Order state machine; risk reservation; adapter

Safety / failure behavior

No replacement may increase exposure without a new risk authorization.

Place in ARX

Core execution function

### 37. Protective Stop and Target Placement

Applies the approved loss boundary and exit policy at or immediately after entry.

Primary use

Prefers broker-native protection and tracks whether the position is actually protected.

Who uses it

Execution and position lifecycle services

Inputs

Authorized stop; target policy; broker order capabilities; filled quantity

Outputs

Native bracket/OCO orders or certified emulation state

Dependencies

Adapter; order state machine; guard service

Safety / failure behavior

An unprotected live position is critical and triggers emergency handling.

Place in ARX

Hard safety function

### 38. MT5 Expert Advisor Command Channel

Allows ARX to trade an MT5 terminal when the broker exposes no suitable direct API.

Primary use

Uses a thin EA as the terminal-side executor while ARX retains decision, risk, permissions, and audit.

Who uses it

MT5-connected self-traders and operators

Inputs

Server command queue; EA heartbeat; account/symbol mapping; signed command

Outputs

EA receipt, MT5 OrderSend result, ticket/fill/reject, and correlated UI state

Dependencies

MT5 EA; authenticated command transport; heartbeat; reconciliation

Safety / failure behavior

No fresh heartbeat means no new orders. The same command ID must be visible from dashboard to MT5 result.

Place in ARX

Adapter path, not a replacement for risk

### 39. Broker Event Ingest and Fill Verification

Turns broker responses into canonical evidence that an order or fill truly exists.

Primary use

Correlates asynchronous events and verifies quantities/prices against account state.

Who uses it

Execution, positions, ledger, UI

Inputs

Streaming events, REST polls, MT5 replies, broker IDs

Outputs

Normalized acknowledgement, fill, fee, position, and rejection records

Dependencies

Adapter; order state machine; account snapshot ingest

Safety / failure behavior

A client timeout is not proof of failure. Uncertain outcomes remain UNKNOWN pending reconciliation.

Place in ARX

Core execution function

### 40. Reconciliation and Orphan Detection

Repairs or contains differences between ARX records and broker truth.

Primary use

Runs after reconnect, periodically, and on uncertainty; shows broker positions ARX did not create.

Who uses it

Operations, execution, account owners

Inputs

Broker open orders/positions/history; ARX ledger

Outputs

Matched, missing, duplicated, or orphaned records plus critical incidents

Dependencies

Broker adapter; ledger; incident system

Safety / failure behavior

Any unresolved material mismatch blocks new entries on the affected account.

Place in ARX

Non-negotiable control

## ARX GUARD - Live position supervision

### 41. Position Lifecycle Manager

Supervises every open position from first fill through final close.

Primary use

Applies explicit precedence: emergency, hard stop, thesis invalidation, timeout, target, then validated adaptive exit.

Who uses it

Automated strategies and operators

Inputs

Position state; frozen thesis; market/risk events; protective-order state

Outputs

Hold, reduce, move protection within policy, close, or emergency-exit actions

Dependencies

Execution core; risk; state/edge events; ledger

Safety / failure behavior

Cannot widen the original loss boundary merely because a trade may recover.

Place in ARX

Core live-management function

### 42. Frozen Thesis and Invalidation Monitor

Preserves the evidence and rules that justified entry and detects when they no longer hold.

Primary use

Evaluates the original contract rather than inventing a new explanation after price moves.

Who uses it

Position manager, review, operator

Inputs

Edge version; expected behavior; invalidation; timeout; feature/state snapshots

Outputs

Thesis-valid, degraded, invalidated, or expired state

Dependencies

Edge library; market state; immutable decision record

Safety / failure behavior

Invalidation action follows the edge contract; an LLM cannot rewrite the thesis.

Place in ARX

Core discipline function

### 43. Partial Profit and Trailing Policy

Reduces or protects a winning position only when its edge version authorizes the behavior.

Primary use

Treats adaptive management as strategy logic that must be researched and versioned.

Who uses it

Position manager and operators

Inputs

Position MFE; target stages; validated trailing rules; quantity

Outputs

Reduction/stop-adjustment order intent and updated protected quantity

Dependencies

Position lifecycle; execution orchestrator; edge library

Safety / failure behavior

Never expands loss or total exposure; amendments remain inside authorization bounds.

Place in ARX

Optional per-edge function

### 44. Emergency Exit

Attempts the safest available closure when protection, connectivity, or account integrity is threatened.

Primary use

Chooses the certified close path and keeps retry/reconciliation bounded and observable.

Who uses it

Automated guards and authorized owner

Inputs

Critical incident; open position; broker health; available close methods

Outputs

Close request, outcome, residual exposure, incident timeline

Dependencies

Kill switch; adapter; reconciliation; alerting

Safety / failure behavior

Does not assume a failed client response means the position is closed.

Place in ARX

Emergency function

### 45. Independent Re-entry Qualification

Requires a fresh decision after a position closes, even at the same zone and direction.

Primary use

Prior reaction, zone age, and touch count are features only if validated.

Who uses it

Strategies and decision core

Inputs

New market evidence; prior zone/trade context; active edge

Outputs

New BUY/SELL/WAIT/SUSPEND decision with a new ID

Dependencies

Full SENSE-to-RISK pipeline; memory

Safety / failure behavior

No unconditional scalp loop and no automatic revenge/recovery trade.

Place in ARX

Core discipline function

## ARX MEMORY and REVIEW - Evidence, learning, and validation

### 46. Immutable Decision and Trade Ledger

Makes every consequential action reconstructable from evidence.

Primary use

Records detection, state, signal, risk verdict, submission, acknowledgement, fills, management, and result.

Who uses it

Owner, operators, auditors, research, support

Inputs

Events from SENSE through close; code/model/config versions; actor IDs

Outputs

Append-only timeline joined by correlation and decision IDs

Dependencies

All production services; PostgreSQL; event schemas

Safety / failure behavior

No destructive rewriting of history. Corrections are new linked events.

Place in ARX

ARX Black Box

### 47. Structured Trade Journal

Turns each completed trade into a reusable case file.

Primary use

Separates setup quality, risk quality, execution quality, and exit quality so profit alone does not define correctness.

Who uses it

Self-traders, assigned users, Ruby, research

Inputs

Pre-trade thesis; during-trade path; final fills/P&L; MFE/MAE; reasons

Outputs

Searchable journal entry and review dataset

Dependencies

Ledger; feature/state snapshots; account permissions

Safety / failure behavior

Users see only authorized accounts. Private notes remain private.

Place in ARX

Operator and learning function

### 48. Post-Trade Review

Explains what worked or failed using the actual decision record.

Primary use

Analyzes thesis correctness, regime fit, risk discipline, costs, and management without inventing missing facts.

Who uses it

Owner, trader, strategy reviewer

Inputs

Trade case file; expected vs. observed behavior; execution telemetry

Outputs

Evidence-based review, issue classification, and follow-up actions

Dependencies

Journal; ledger; review models; metrics

Safety / failure behavior

LLM narrative is clearly separated from deterministic facts and cannot modify live logic.

Place in ARX

ARX REVIEW function

### 49. Ruby Trading Assistant

Lets users ask natural-language questions about ARX state, trades, refusals, and system health.

Primary use

Uses retrieval from structured records and explains non-guaranteed trade rationale in operator language.

Who uses it

Self-traders, master users, permitted assigned users

Inputs

Authorized live/read models; decision evidence; user question; conversation context

Outputs

Concise explanation, rationale, navigation help, or research summary

Dependencies

Permissions; ARX APIs; model-provider abstraction; memory controls

Safety / failure behavior

No direct order placement or risk-limit changes through free text. Ruby must say when evidence is unavailable.

Place in ARX

COMMAND/REVIEW interface

### 50. Private Conversation Memory

Keeps useful per-user context across Ruby sessions while allowing the user to clear it.

Primary use

Stores only scoped context needed for continuity and never treats memory as market evidence.

Who uses it

Individual users

Inputs

Authorized chat history; explicit preferences; retained summaries

Outputs

Private memory entries and deletion controls

Dependencies

User identity; encrypted storage; retention policy

Safety / failure behavior

Memory is user-isolated, permission-aware, auditable, and clearable.

Place in ARX

User experience function

### 51. Anonymous Aggregate Learning

Learns broad product and strategy patterns without exposing one user's private account history to another.

Primary use

Uses minimum cohort and privacy rules before aggregation.

Who uses it

Research and product analytics

Inputs

De-identified, policy-approved outcome features

Outputs

Aggregate metrics or research datasets

Dependencies

Data governance; journal; research lab

Safety / failure behavior

No raw credentials, personal notes, or re-identifiable account details enter shared learning.

Place in ARX

Governed future capability

### 52. Research Lab

Tests hypotheses offline without access to live execution credentials.

Primary use

Uses chronological splits, purging/embargo, walk-forward evaluation, untouched holdout, sensitivity, and ablation.

Who uses it

Quant researchers and engineering agents

Inputs

Copied market data; preregistered hypothesis; features; labels; cost model

Outputs

Reproducible experiment, report, artifacts, and REJECT/RETEST/SHADOW_CANDIDATE decision

Dependencies

Immutable datasets; model/edge registries; compute environment

Safety / failure behavior

Cannot promote itself or call live trading endpoints.

Place in ARX

Separated research plane

### 53. Replay and Determinism

Proves that the same evidence and versions produce the same ordered decisions.

Primary use

Runs the production algorithms over recorded evidence with controlled time and version inputs.

Who uses it

Engineering, certification, incident review

Inputs

Frozen ticks; code commit; model package; config hash

Outputs

Replayed events/decisions and deterministic comparison report

Dependencies

Tick archive; event bus; version registry; test harness

Safety / failure behavior

Any unexplained divergence blocks promotion or release.

Place in ARX

Certification function

### 54. Shadow and Demo Validation

Tests live decisions and execution behavior before real capital is exposed.

Primary use

Shadow sends no orders; demo uses broker practice funds; both use the real production path otherwise.

Who uses it

Owner, research, operations

Inputs

Live market data; production candidate; demo connection; predefined gates

Outputs

Shadow decisions, demo orders, calibration, slippage, latency, and reconciliation evidence

Dependencies

Full platform; validation plan; observability

Safety / failure behavior

Failure returns the edge or adapter to research. Real money remains off.

Place in ARX

Mandatory promotion stages

### 55. Strategy Arena and Allocation Review

Compares production strategies and adjusts permitted allocation within owner-approved caps.

Primary use

Rewards stable, well-sampled performance and penalizes degradation, concentration, and weak evidence.

Who uses it

Owner and research governance

Inputs

Expectancy; drawdown; profit factor; calibration; costs; sample size; regime performance

Outputs

Evidence ranking and proposed allocation changes

Dependencies

Edge health; trade journal; risk kernel; owner limits

Safety / failure behavior

Experimental strategies remain tightly capped; the arena cannot raise global risk ceilings.

Place in ARX

Later-stage ARX capability

### 56. Model, Edge, and Configuration Registry

Keeps every production behavior tied to immutable versions and promotion evidence.

Primary use

Records exactly which versions made each decision and prevents unreviewed mutable settings.

Who uses it

All services, engineering, audit

Inputs

Model artifacts; edge contracts; configuration; hashes; validation reports

Outputs

Active/retired versions, lineage, approvals, and rollback targets

Dependencies

Database; artifact storage; CI/CD; owner approvals

Safety / failure behavior

Risk-limit increases and live promotions require explicit authorization.

Place in ARX

Core governance function

## ARX COMMAND - Operator experience and controls

### 57. Command Center Dashboard

Shows system, market, risk, account, and strategy state at a glance.

Primary use

Prioritizes decision readiness and safety over decorative chart density.

Who uses it

Master user, self-trader, operations

Inputs

Health, states, opportunities, positions, P&L, risk use, versions

Outputs

ACTIVE/PAUSED/DEGRADED view, live positions, opportunity queue, rejections, alerts

Dependencies

Read APIs from every control plane; permissions

Safety / failure behavior

Stale panels show age/source and disable action. Rejected trades remain visible with reasons.

Place in ARX

Primary operator surface

### 58. Smart Chart and Chart Truth Gate

Displays broker-consistent candles and annotations only when their source is trustworthy.

Primary use

Uses the connected broker's data by default and aligns signal, order, and fill timestamps.

Who uses it

Traders, scanner, Ruby, review

Inputs

Broker-native candles; data quality; orders/fills; signals; positions

Outputs

Interactive chart with provenance, freshness, and decision annotations

Dependencies

Market data router; order ledger; symbol registry

Safety / failure behavior

If chart truth fails, Ruby, Scanner, Self-Trade, AACI, and Risk Governor must not act on the chart.

Place in ARX

Owner-directed control

### 59. Trade Ticket

Lets an authorized user prepare and confirm an order without bypassing system controls.

Primary use

Shows broker constraints and editable fields, then sends the intent through eligibility, risk, and execution.

Who uses it

Self-traders and permitted managed users

Inputs

Account; symbol; side; order type; risk/quantity; stop/target

Outputs

Validated trade intent, cost/risk preview, confirmation, and status link

Dependencies

Account assignment; capabilities; risk preview; execution API

Safety / failure behavior

No credential exposure; no submit when connection, data, permission, or risk state is unsafe.

Place in ARX

Operator-facing function

### 60. Orders, Positions, and History Center

Provides one broker-normalized view of live and historical trading activity.

Primary use

Preserves broker-native identifiers while using consistent ARX states and reason codes.

Who uses it

All authorized users

Inputs

Canonical orders, fills, positions, reconciliation, journal

Outputs

Filterable lists, detail timelines, close/cancel actions, and orphan warnings

Dependencies

Ledger; broker snapshots; permissions

Safety / failure behavior

At least 50 recent command/order events remain inspectable; discrepancies are prominent.

Place in ARX

Operator-facing function

### 61. Watchlists and Workspace Search

Organizes the instruments and accounts a user is allowed to monitor.

Primary use

Filters the product without changing the underlying account permissions or risk eligibility.

Who uses it

Self-traders and assigned users

Inputs

Authorized instruments; workspace membership; user selections

Outputs

Watchlists, filters, recent items, and scanner scope

Dependencies

Symbol registry; workspace permissions; user preferences

Safety / failure behavior

An item may be visible but non-tradable; the UI states the reason.

Place in ARX

Convenience function

### 62. Notifications and Incident Alerts

Delivers action-worthy trading and system events through approved channels.

Primary use

Separates expected trade outcomes from engineering incidents and avoids duplicate delivery.

Who uses it

Owner, traders, operations

Inputs

Order/fill events; risk pauses; auth failures; mismatches; data gaps

Outputs

In-app, email, push, or webhook notification with severity and correlation link

Dependencies

Event bus; notification preferences; incident service

Safety / failure behavior

Critical alerts cannot be suppressed by ordinary user preferences; secrets and sensitive payloads are redacted.

Place in ARX

Operations function

### 63. Explainability and Rejection Reasons

Answers why ARX acted, refused, reduced size, paused, or marked an outcome unknown.

Primary use

Reconstructs the actual path rather than generating a plausible post-hoc story.

Who uses it

All authorized operators

Inputs

Immutable decisions, gate results, risk verdicts, health events

Outputs

Evidence-linked explanation and stable reason codes

Dependencies

Ledger; Ruby; decision/risk services

Safety / failure behavior

The explanation layer cannot alter the underlying record or hide a hard-control rejection.

Place in ARX

Core product promise

## Accounts, workspaces, and managed allocation

### 64. Self-Trading Mode

Lets a user connect and trade their own eligible broker accounts under ARX controls.

Primary use

The user retains trading control while ARX supplies analysis, deterministic risk, execution, and audit.

Who uses it

Individual account owner

Inputs

Owned broker connection; permissions; risk profile; market data

Outputs

Personal workspace, scanner, ticket, positions, journal, and automation settings

Dependencies

Broker hub; COMMAND; full decision loop

Safety / failure behavior

Live execution stays off until connection, heartbeat, account, symbol, risk, and confirmation gates pass.

Place in ARX

Primary product mode

### 65. Managed Allocation Mode

Lets a master user assign specific connected accounts or true broker subaccounts to selected users.

Primary use

Separates account ownership from delegated usage without sharing credentials.

Who uses it

Master user and invited users

Inputs

Master-owned connections; invitations; assignments; role and limit policy

Outputs

User workspaces scoped to assigned accounts with server-enforced ceilings

Dependencies

Identity; workspace service; account assignment; risk kernel; audit

Safety / failure behavior

Exclusive live assignment by default unless the broker provides genuine subaccounts. Shared netting is demo/shadow only.

Place in ARX

Second product mode

### 66. Master User Control Plane

Gives the account owner authority to invite, assign, cap, freeze, revoke, and monitor delegated usage.

Primary use

Master limits are ceilings; a child user can choose less risk but never more.

Who uses it

Master user

Inputs

Users; accounts; permissions; risk ceilings; active sessions

Outputs

Assignments, limit policies, freezes, revocations, and oversight reports

Dependencies

Managed allocation; permissions; audit; alerts

Safety / failure behavior

Kill/freeze/revoke is immediate and durable. Credential material never leaves the server.

Place in ARX

Managed allocation authority

### 67. Workspace Roles and Permissions

Controls which users may view, analyze, prepare, submit, cancel, close, or administer.

Primary use

Enforces permissions on the server for every read and write, not only in the interface.

Who uses it

Master users, users, support

Inputs

Workspace membership; role; account assignment; action; environment

Outputs

Allow/deny decision with reason and audit event

Dependencies

Identity provider; policy engine; account registry

Safety / failure behavior

Default deny; removal or downgrade takes effect immediately.

Place in ARX

Security function

### 68. Per-User Usage and Risk Limits

Constrains delegated users within the master account's approved exposure and activity.

Primary use

Calculates the most restrictive intersection of platform, account, master, user, broker, and regulatory rules.

Who uses it

Master user and risk kernel

Inputs

Account ceiling; user ceiling; symbols; order types; trading hours; loss limits

Outputs

Effective limit set used by risk and permissions

Dependencies

Policy engine; risk kernel; broker capabilities

Safety / failure behavior

Users cannot bypass limits by changing devices, APIs, or workspaces.

Place in ARX

Managed allocation control

### 69. Assignment Isolation and Credential Shielding

Prevents one delegated user from affecting or discovering another account beyond their assignment.

Primary use

Uses server-side account IDs and policy checks; broker secrets are never sent to clients.

Who uses it

All managed-allocation users

Inputs

Authenticated user; workspace; requested account/resource

Outputs

Scoped data and action access

Dependencies

Secrets vault; permission service; row-level data controls

Safety / failure behavior

Cross-assignment access is denied and logged as a security event.

Place in ARX

Non-negotiable security function

### 70. Compliance and Eligibility Gate

Determines whether an account, user, jurisdiction, product, and delegation model may trade.

Primary use

Keeps personal self-trading separate from discretionary management of outside-client funds.

Who uses it

Onboarding, managed allocation, execution

Inputs

Broker terms; account type; jurisdiction; KYC/AML state; product permissions; counsel/broker approvals

Outputs

ELIGIBLE, RESTRICTED, COMPLIANCE_HOLD, or INELIGIBLE with reasons

Dependencies

Broker metadata; identity/KYC; policy registry; legal approvals

Safety / failure behavior

Outside-client managed accounts remain COMPLIANCE_HOLD until the required approvals exist.

Place in ARX

Business and regulatory gate

### 71. Broker Capability and Entitlement Service

Determines which data and trading features are actually available on a specific connection.

Primary use

Combines adapter certification with live account entitlements and displays the reason for unavailable features.

Who uses it

UI, market-data router, trade ticket, execution

Inputs

Broker, account, jurisdiction, subscription, instrument

Outputs

Capabilities for data, orders, shorting, options, fractional size, streaming, and live/demo

Dependencies

Connection manager; adapter registry; broker metadata

Safety / failure behavior

The UI and API both enforce the same capability result.

Place in ARX

Core multi-broker function

## Operations, security, and release controls

### 72. Health, Heartbeat, and Dependency Monitor

Continuously checks broker, market data, database, queue, model, clock, and execution health.

Primary use

Runs independently of price-change events so a quiet market cannot hide a dead service.

Who uses it

Risk kernel, operations, dashboard

Inputs

Service heartbeats; error rates; latency; freshness; dependency checks

Outputs

ACTIVE, DEGRADED, PAUSED, or SUSPENDED status with affected scope

Dependencies

Observability stack; event bus; configuration

Safety / failure behavior

Critical uncertainty defaults to STOP NEW TRADES.

Place in ARX

Core fail-safe function

### 73. Observability and Incident Control

Makes faults diagnosable through structured logs, metrics, traces, and incident timelines.

Primary use

Tracks latency and slippage distributions, not just averages, and links user-visible failures to internal evidence.

Who uses it

Engineering and operations

Inputs

Correlation IDs; service events; broker responses; versions; health changes

Outputs

Dashboards, alerts, incident records, and replay links

Dependencies

OpenTelemetry-compatible tooling; ledger; alerting

Safety / failure behavior

Sensitive values are redacted; incident controls can rotate credentials and freeze affected scope.

Place in ARX

Operations foundation

### 74. Secrets and Authorization Vault

Stores broker and platform secrets with least-privilege access.

Primary use

Separates demo/live credentials and supports rotation without rebuilding the application.

Who uses it

Connection manager and execution service only

Inputs

OAuth tokens, API keys, refresh tokens, MT5 channel keys

Outputs

Encrypted secret references and controlled runtime injection

Dependencies

Secrets manager; identity; network policy

Safety / failure behavior

Research and LLM processes have no access to real execution credentials.

Place in ARX

Security foundation

### 75. Adapter Certification Suite

Proves each broker integration behaves correctly before users rely on it.

Primary use

Tests auth, symbols, candles/ticks, order types, events, partial fills, cancellation, reconciliation, rate limits, and failure mapping.

Who uses it

Integration engineering and release governance

Inputs

Adapter build; broker sandbox/live-read test account; contract fixtures

Outputs

Capability certification, schema results, latency/reconnect evidence, and version status

Dependencies

CI; broker environments; canonical adapter contract

Safety / failure behavior

Uncertified or regressed capabilities are disabled, not assumed.

Place in ARX

Required per broker

### 76. Release Promotion Pipeline

Moves code, strategies, models, and adapters through progressively stronger evidence.

Primary use

Keeps real-money enablement a deliberate owner action after machine-verifiable gates pass.

Who uses it

Owner, engineering, research

Inputs

Versioned artifact; test results; replay; shadow/demo evidence; approvals

Outputs

RESEARCH, HISTORICAL, WALK_FORWARD, HOLDOUT, SHADOW, DEMO, LIMITED_LIVE, or PRODUCTION state

Dependencies

CI/CD; registries; audit; owner control

Safety / failure behavior

No force promotion and no autonomous risk increase. Failed gates return the artifact to research or retirement.

Place in ARX

Core governance function

### 77. Backup, Recovery, and Restart Reconciliation

Restores durable state without assuming an interrupted order or position outcome.

Primary use

Rebuilds local state from durable evidence and broker truth before accepting new entries.

Who uses it

Operations and execution

Inputs

Encrypted backups; ledger; broker snapshots; deployment versions

Outputs

Restored service state, reconciliation report, and safe resume decision

Dependencies

Database backup; object archive; adapters; incident service

Safety / failure behavior

Restore procedures are tested; unresolved order/position state keeps trading paused.

Place in ARX

Operational resilience function

### 78. LLM Provider Abstraction

Allows Ruby, review, and engineering analysis to use different model providers without coupling live trading to one vendor.

Primary use

Routes non-latency-critical analytical tasks while deterministic services retain authority.

Who uses it

Product engineering and analysis services

Inputs

Task type; authorized context; provider policy; model availability

Outputs

Structured model response, trace, provider/model version, and fallback state

Dependencies

Model APIs; policy layer; observability

Safety / failure behavior

LLMs cannot hold broker credentials, call live execution directly, change risk, or promote strategies.

Place in ARX

Replaceable intelligence layer

# Two product modes, one control system

Self-Trading and Managed Allocation share SENSE, SIGNAL, RISK, EXECUTE, GUARD, MEMORY, REVIEW, and COMMAND. The difference is who owns the broker account and how authority is delegated.

Dimension

Self-Trading

Managed Allocation

Account owner

The user trading the account

Master user

Credential access

Server-side connection for that owner

Server-side only; never given to assigned users

Who may act

Owner and explicitly authorized automation

Selected users within assigned accounts and roles

Risk limits

Platform + owner profile + broker constraints

Platform + master ceiling + user ceiling + broker constraints

Live account sharing

Not applicable

Exclusive assignment unless broker-native subaccounts exist

Outside-client funds

Not part of personal self-trading

COMPLIANCE_HOLD until legal and broker approvals exist

Emergency authority

Owner kill/freeze

Master kill/freeze/revoke plus platform controls

# Live-money readiness rule

Real-money execution remains disabled until invariant tests, broker contract tests, replay determinism, edge validation, shadow duration/sample gates, demo cost and reconciliation gates, kill-switch testing, and explicit owner enablement have all passed. The staged path is: replay -> historical validation -> shadow -> demo -> limited live -> production.

# Known issues, constraints, and open decisions

This register captures the recurring problems and unresolved decisions discussed during the ARX rebuild. “Constraint” means the platform must be designed around it; “open gap” means implementation or proof is incomplete; “owner decision” means engineering should not choose the business outcome; and “launch blocker” means live-money use must remain disabled until resolved.

Issue

Type

Why it matters

Required resolution / operating rule

MT5 has no universal cloud trading API

Constraint

A web app cannot reliably place trades into arbitrary MT5 broker accounts without a terminal-side EA, broker-specific API, or third-party gateway.

Use the thin ARX EA command channel where direct broker APIs are unavailable; require heartbeat, signed commands, and full reconciliation.

True end-to-end live execution proof is incomplete

Launch blocker

A green UI or queued command does not prove the broker/MT5 accepted and filled the order.

Prove dashboard command -> queue/poll -> EA or adapter receipt -> broker order call -> fill/reject -> UI using one correlation ID.

Broker APIs are not interchangeable

Constraint

Authentication, symbols, order types, positions, event streams, rate limits, and errors differ materially by venue.

Maintain certified adapters and a live capability matrix; never advertise or emulate an unsupported feature silently.

Broker-native candle availability and entitlements vary

Open gap

Some accounts lack historical candles, volume, or real-time subscriptions; different brokers can show different prices.

Route to the connected broker first, preserve provenance, label partial/delayed data, and block action when chart truth is unavailable.

Symbol identifiers cannot be safely hard-coded

Open gap

Deriv and other brokers can expose product identifiers that differ from familiar display names or change by environment/jurisdiction.

Resolve through active-symbol/instrument APIs at runtime, version mappings, and stop when the mapping is missing or ambiguous.

Market-data quality can silently corrupt downstream decisions

Launch blocker

Stale feeds, gaps, duplicate ticks, reconnects, and clock drift can make charts and models look valid while they are not.

Persist quality events and lineage; gate Scanner, Ruby, Self-Trade, automation, and Risk on freshness and source integrity.

Unknown order outcomes make naive retry dangerous

Launch blocker

A timeout can occur after the broker accepted the order; retrying may double exposure.

Use idempotency keys, an UNKNOWN state, broker client-order IDs where available, and reconciliation before retry.

Local order/position state can diverge from broker truth

Launch blocker

Reconnects, out-of-band manual trades, partial fills, and delayed events create mismatches and orphan positions.

Poll broker truth after reconnect and periodically; display orphans; block new entries until material discrepancies are resolved.

Manual and automated paths can drift into different safety rules

Open gap

A UI shortcut, scanner action, Ruby request, or automation endpoint can accidentally bypass the common risk path.

Require every path to produce the same trade intent, permission result, risk authorization, order state machine, and audit chain.

Managed allocation on shared netting accounts is unsafe

Owner decision / constraint

Multiple users trading one live netting account cannot be cleanly isolated, attributed, or liquidated independently.

Use exclusive live assignments unless the broker provides genuine subaccounts; allow shared netting only in demo/shadow.

Discretionary trading for outside clients changes the regulatory product

Owner decision / launch blocker

Assigning third parties to managed accounts can trigger broker terms, licensing, KYC/AML, suitability, reporting, and custody obligations.

Keep outside-client managed accounts in COMPLIANCE_HOLD until jurisdiction-specific counsel and broker approval are documented.

Credential handling is easy to get wrong in Replit or clients

Security gap

Pasting database or broker credentials into commands, browser code, logs, or shared shells can expose production access.

Use Replit Secrets or a dedicated secrets manager, server-side references, least privilege, rotation, and separate demo/live credentials.

Master-user delegation needs server-side enforcement

Open gap

Hiding controls in the UI does not prevent an assigned user from calling APIs directly or exceeding limits concurrently.

Enforce account assignment, role, per-user ceiling, and atomic risk reservation on every server read/write.

Risk limits still need owner-approved production values

Owner decision / launch blocker

The mechanism can be built without guessing safe dollar, percentage, drawdown, slippage, or latency thresholds.

Validate values in replay, shadow, and demo; record immutable owner approval; prohibit autonomous limit increases.

The initial Deriv universe still requires runtime verification

Open gap

The intended Volatility 25 (1s), Volatility 50 (1s), Volatility 75, and Volatility 75 (1s) set must be matched to real active symbols and permissions.

Discover and verify on the target account/environment; do not ship guessed identifiers.

Research and production can accidentally diverge

Open gap

Different feature formulas, candle construction, time alignment, or cost assumptions produce backtests the live engine cannot reproduce.

Share versioned implementations, require deterministic replay and shadow equivalence, and keep dataset/code/config hashes.

Backtest overfitting and unrealistic costs remain material risks

Research risk

A high in-sample win rate can disappear under chronology, slippage, latency, missed fills, and multiple testing.

Use walk-forward tests, untouched holdout, purging/embargo, sensitivity, ablation, and worse-than-observed cost scenarios.

Trade-count or profit targets can pressure the system to invent trades

Product risk

A quota such as 150 trades/day or a daily dollar goal is not evidence that enough valid opportunities exist.

Treat targets as capacity/objectives only; WAIT and zero trades remain correct when conservative EV is not positive.

LLM explanations can sound certain without evidence

Product and safety risk

Ruby or a review model can generate a convincing story that is not the actual decision path.

Retrieve immutable facts, separate facts from model interpretation, expose missing evidence, and forbid direct execution/risk changes.

Real-money mode is not yet authorized

Launch blocker

The planned system has not completed all invariant, broker-contract, replay, shadow, demo, reconciliation, and kill-switch gates.

Keep live trading disabled until evidence is complete and the owner explicitly enables LIMITED_LIVE with minimal caps.

Restart and disaster recovery need broker-aware proof

Open gap

Restoring a database snapshot alone cannot settle orders that were in flight when the service stopped.

Restore durable state, query broker truth, reconcile every nonterminal order and open position, then decide whether safe resume is possible.

System scope has been drifting between product vision and engine specification

Documentation / governance gap

ARX, AXIOM, broker hub, scanner, Ruby, self-trading, and managed allocation have been described in separate documents and conversations.

Treat this encyclopedia plus the authoritative build spec and versioned decisions as the product map; record changes rather than silently redefining boundaries.

## Issue priority for the rebuild

P0 - keep live money off: Complete the common risk path, data-truth gates, end-to-end broker proof, unknown-order handling, reconciliation, kill switches, and owner authorization.

P1 - make read-only multi-broker trustworthy: Certify connections, runtime symbols, broker-native candles, account snapshots, entitlements, and permission isolation.

P2 - prove execution safely in demo: Run adapter contract tests, partial-fill/cancel scenarios, restart recovery, slippage/latency measurement, and durable command history.

P3 - enable controlled product modes: Finish self-trading workspaces first; enable managed allocation only with exclusive/subaccount isolation and compliance gates.

P4 - promote intelligence from evidence: Only then expand strategies, Strategy Arena allocation, Ruby analysis, and limited live operation.

# What ARX deliberately is not

Not a market-to-LLM-to-trade shortcut.

Not a promise to reach a trade quota or profit target.

Not a system that invents candles, symbols, broker capabilities, or order outcomes.

Not a credential-sharing tool for delegated users.

Not a social-trading network, indicator marketplace, news terminal, or generic financial chatbot.

Not permitted to widen risk, martingale, or recover losses by increasing size.

# Source basis and interpretation

This guide consolidates the ARX AI Product Vision and System Architecture, AXIOM Master Build Specification v1, AXIOM Claude Handoff v1, the ARX Multi-Broker Execution System implementation plan, and the owner decisions captured during product planning. Later-stage, optional, gated, and owner-directed distinctions are preserved.

# Part II — Complete ARX improvement program

Part I defines the 78 core functions and the current known-issues register. Part II consolidates the architectural and intelligence improvements discussed afterward. These are not all simultaneous build requirements. Each improvement has an evidence requirement, an authority boundary and a recommended stage so the vision can grow without granting unearned live authority.

Central rule: More intelligence does not automatically earn more authority. Every added component must improve measured decisions, remain reproducible, preserve deterministic risk, and be removable without endangering positions or economic truth.

## Coverage map

Capability family

What ARX must own

Market intelligence

Broker-native data, quality, features, state, structure, cross-market evidence, market selection and Scanner.

Decision intelligence

Edges, probability, conservative EV, timing, uncertainty, disagreement, challenge and abstention.

Capital intelligence

Hard risk, portfolio admission, correlation, scheduling, risk of ruin, capacity and mission planning.

Execution intelligence

Typed intents, capability tokens, order planning, fills, protection, reconciliation and economic settlement.

Institutional intelligence

Immutable evidence, research, negative knowledge, certification, owner decisions and release safety cases.

Self-intelligence

Health, OOD detection, structural breaks, contradictions, maturity, degradation and recovery probation.

Self-Trading

Personal constitution, guided mode, bounded autonomy, discipline, review and direct broker escape route.

Managed Allocation

Master controls, risk cells, assignment isolation, ownership, compliance and institutional roles.

## Intelligence quality and epistemic control

### 1. Intelligence Council

Replace a single confidence-producing brain with independent state, edge, timing, cost, uncertainty and adversarial-critic components.

System improvement

Require agreement from distinct evidence channels and expose the disagreements rather than averaging them away.

Evidence required

Calibration, ablation, out-of-sample performance, disagreement outcomes and decision-boundary behavior.

Authority boundary

The council may propose BUY, SELL or WAIT; deterministic Risk alone authorizes capital.

Recommended stage

After trustworthy market data and replay

### 2. Uncertainty Decomposition

Treat uncertainty as a structured system result.

System improvement

Separate data, model, regime, execution, portfolio and operational uncertainty and subtract them from a confidence budget.

Evidence required

Coverage tests, calibration curves, false-certainty incidents and abstention value.

Authority boundary

Uncertainty may reduce authority automatically; it may never increase size.

Recommended stage

Core intelligence v2

### 3. Out-of-Distribution Detection

Recognize when current conditions differ materially from validated experience.

System improvement

Compare live volatility, tick cadence, costs, feature combinations, transitions and broker behavior with certified distributions.

Evidence required

Known-shift replay, synthetic stress, shadow outcomes and false-positive rate.

Authority boundary

Unfamiliar conditions move affected edges to shadow, WAIT or SUSPEND.

Recommended stage

Before limited live

### 4. Conformal Decision Bounds

Replace decorative confidence percentages with empirically covered outcome sets or intervals.

System improvement

Return plausible outcomes and coverage level for barrier, timeout and cost-adjusted predictions.

Evidence required

Coverage on chronological holdouts and regime-specific reliability.

Authority boundary

If the required outcome cannot be excluded at the configured coverage, ARX abstains.

Recommended stage

Research, then shadow

### 5. Counterfactual Decision Engine

Compare the proposed trade with waiting, smaller size, alternative execution and no trade.

System improvement

Evaluate a bounded set of preapproved counterfactual actions using the same cost and risk assumptions.

Evidence required

Historical/replay accuracy of counterfactual estimates and stability under worse costs.

Authority boundary

Counterfactuals inform decisions; they do not bypass edge or risk requirements.

Recommended stage

Intelligence v2

### 6. Information-Value Engine

Estimate whether waiting for more evidence is worth the lost entry opportunity.

System improvement

Measure expected uncertainty reduction, setup expiry, price movement and obtainable information.

Evidence required

Replay of WAIT_FOR_EVIDENCE versus immediate action across regimes.

Authority boundary

May recommend waiting; cannot extend an expired setup.

Recommended stage

Later intelligence

### 7. Model Disagreement Engine

Use disagreement as risk information instead of averaging incompatible predictions.

System improvement

Classify direction, timing, regime, cost and uncertainty disagreement and map each class to abstention or size reduction.

Evidence required

Disagreement-conditioned performance and calibration.

Authority boundary

Only Risk may apply the final reduced size.

Recommended stage

Core intelligence v2

### 8. Evidence Diversity Scoring

Prevent correlated models from masquerading as independent confirmation.

System improvement

Score overlap in data, features, horizons, model classes and training samples.

Evidence required

Marginal contribution, ablation and conditional dependence studies.

Authority boundary

Low diversity limits confidence contribution.

Recommended stage

Research and model governance

### 9. Change-Point and Structural-Break Detection

Detect that the generating process has changed before losses alone reveal it.

System improvement

Monitor features, model residuals, costs, state transitions, order quality and broker behavior.

Evidence required

Known-break benchmarks, time-to-detection, false alarms and response value.

Authority boundary

May reduce allocation or suspend an edge; recertification is required for return.

Recommended stage

Before scaling live

### 10. Multi-Horizon Cognition

Represent microstructure, entry, position, session, regime, strategy and capital horizons separately.

System improvement

Require the relevant horizons to be compatible and preserve horizon-specific state age and reliability.

Evidence required

Per-horizon calibration, transition analysis and ablation.

Authority boundary

Fast evidence cannot overrule a higher-level safety or portfolio restriction.

Recommended stage

Quant core evolution

### 11. Market Ecology Engine

Estimate which behavioral processes best explain observed conditions without pretending to identify actual participants.

System improvement

Model momentum participation, two-sided liquidity, forced movement and mean-reversion pressure as probabilistic behavior.

Evidence required

Falsifiable hypotheses, regime stability and incremental value over simpler state labels.

Authority boundary

Advisory until independently validated; never presented as fact.

Recommended stage

Research frontier

### 12. Negative-Knowledge Library

Remember failed features, strategies, assumptions and broker interpretations.

System improvement

Search prior rejected hypotheses before launching new research and preserve the evidence that falsified them.

Evidence required

Reproduction of prior failures and duplicate-hypothesis detection.

Authority boundary

Cannot permanently ban a hypothesis without evidence; retests require a stated new reason.

Recommended stage

Research foundation

## Strategy, opportunity and portfolio intelligence

### 13. Strategy Constitution and Compiler

Express strategies as controlled contracts rather than unrestricted application code.

System improvement

Compile eligibility, entry, invalidation, risk, exit, breaker and explanation rules into testable artifacts.

Evidence required

Generated invariant tests, replay equivalence and behavioral diffs.

Authority boundary

Compiled strategies cannot call brokers or create risk authorizations.

Recommended stage

After domain contracts stabilize

### 14. Strategy Behavioral Diff

Show how a new version changes actual decisions, not only code.

System improvement

Compare trade frequency, WAIT-to-trade changes, stops, holding time, drawdown, costs and affected regimes.

Evidence required

Frozen replay across representative datasets and exact changed-decision inventory.

Authority boundary

Material changes require renewed owner authority.

Recommended stage

Before strategy updates reach live

### 15. Champion-Challenger System

Run alternatives alongside the active production model without exposing capital.

System improvement

Keep one authorized champion and multiple shadow challengers evaluated on identical events.

Evidence required

Sustained superiority across regimes, costs and operational constraints.

Authority boundary

Challengers receive no live authority until the full promotion path passes.

Recommended stage

Core continuous improvement

### 16. Meta-Strategy Controller

Determine which certified strategies are eligible in current conditions.

System improvement

Enable, reduce, prepare, shadow or disable strategies using state, health, evidence age and portfolio context.

Evidence required

Replay and shadow evidence showing incremental benefit over static eligibility.

Authority boundary

It allocates eligibility, not capital authority.

Recommended stage

Portfolio intelligence stage

### 17. Opportunity Lifecycle Manager

Own each setup from detection through readiness, expiry, invalidation, rejection, execution or missed status.

System improvement

Use typed states and preserve first detection, evidence changes, entry window and failure reasons.

Evidence required

State-machine tests and full event reconstruction.

Authority boundary

Cannot revive expired evidence or submit directly.

Recommended stage

Core product gap between Scanner and Risk

### 18. Opportunity Deduplication

Prevent several strategies from multiplying one economic idea into duplicate exposure.

System improvement

Cluster candidates by instrument, direction, time horizon, evidence and thesis similarity.

Evidence required

Replay of known duplicates and false-merge analysis.

Authority boundary

Merged evidence does not automatically receive multiple risk budgets.

Recommended stage

Before multi-strategy live

### 19. Opportunity Conflict Resolver

Handle opposing or incompatible candidate actions.

System improvement

Classify horizon and thesis conflicts and prefer WAIT when the conflict is not resolvable by validated rules.

Evidence required

Conflict-conditioned outcome analysis.

Authority boundary

Cannot choose a trade merely because one score is slightly higher.

Recommended stage

Before multi-strategy live

### 20. Capital Scheduler and Decision Market

Allocate scarce risk capacity among simultaneous qualified opportunities.

System improvement

Rank requests using conservative utility, reliability, duration, optionality, concentration and capacity.

Evidence required

Portfolio replay, missed-opportunity accounting and stress tests.

Authority boundary

Divides only the owner-approved envelope; cannot create risk.

Recommended stage

Portfolio intelligence v2

### 21. Position Admission Controller

Decide whether a risk-fitting trade belongs in the current portfolio.

System improvement

Evaluate portfolio role, concentration, broker dependency, opportunity cost and operational load.

Evidence required

Portfolio-level counterfactuals and stress tests.

Authority boundary

Risk remains the final capital authority.

Recommended stage

Before multi-account scaling

### 22. Portfolio Intelligence

Treat all personally owned or managed accounts as one economic exposure graph.

System improvement

Normalize account, currency, strategy, symbol, broker and beneficial-owner relationships.

Evidence required

Reconciled positions, scenario loss and attribution accuracy.

Authority boundary

Account-level limits remain in force; portfolio constraints can only be stricter.

Recommended stage

High-value phase after execution proof

### 23. Risk-of-Ruin and Capacity Simulator

Estimate survival and strategy capacity before enabling a risk profile.

System improvement

Simulate losing streaks, cost shocks, correlation, liquidity, partial fills and broker failures.

Evidence required

Robustness across distributions and comparison with realized demo/live outcomes.

Authority boundary

Advisory for owner limit selection; never guarantees safety.

Recommended stage

Before limited live

### 24. Market Selection Engine

Choose which connected markets deserve active monitoring, shadow observation or exclusion.

System improvement

Score data quality, execution, edge coverage, evidence maturity, capacity, correlation and broker trust.

Evidence required

Outcome by selection state and comparison with scanning the full universe.

Authority boundary

Sets the playing field; Scanner finds plays and Risk authorizes capital.

Recommended stage

Read-only multi-broker stage

## Execution, resilience and economic truth

### 25. Proof-Carrying Decisions

Require each executable action to include valid evidence for data, eligibility, edge, timing, permission, risk and broker capability.

System improvement

Bind short-lived proofs to the same decision, account, intent and policy versions.

Evidence required

Tamper, expiry, mismatch and replay-attack tests.

Authority boundary

Execution rejects incomplete, expired or mismatched proof packages.

Recommended stage

Advanced control-plane hardening

### 26. Single-Use Capability Tokens

Constrain exactly what Execution may do after Risk approval.

System improvement

Encode account, symbol, side, maximum quantity/loss/slippage, expiry and use count.

Evidence required

Security and duplicate-command tests.

Authority boundary

Execution may do less, never more; reuse is rejected.

Recommended stage

Before significant live capital

### 27. Execution Policy Intelligence

Choose among certified market, passive, aggressive, staged and cancel/replace policies.

System improvement

Condition selection on broker, symbol, urgency, spread, quantity and fill history.

Evidence required

Fill quality and residual edge after costs in shadow/demo.

Authority boundary

Cannot exceed the original quantity, loss, slippage or expiry.

Recommended stage

After baseline execution is proven

### 28. Independent Protection Watchdog

Monitor live exposure even if the primary application is unhealthy.

System improvement

Use a separately deployed, limited-authority process to verify positions and protective orders.

Evidence required

Outage drills, false-positive tests and emergency-close certification.

Authority boundary

May reduce authority or execute preapproved emergency actions only.

Recommended stage

Before meaningful live scale

### 29. Bitemporal Economic Ledger

Preserve when broker/account events happened and when ARX learned them.

System improvement

Store valid time, recorded time, corrections, economic postings and reconciliation lineage.

Evidence required

Statement reconciliation and delayed-event incident tests.

Authority boundary

Corrections append new entries; history is never rewritten.

Recommended stage

Core accounting evolution

### 30. Double-Entry Capital Accounting

Make cash, reservations, margin, fees, P&L, funding and allocations balance.

System improvement

Post every economic movement to balanced accounts with broker and strategy attribution.

Evidence required

Daily broker-statement reconciliation and invariant checks.

Authority boundary

Trading state cannot silently alter accounting truth.

Recommended stage

Before managed or multi-currency scale

### 31. Truth Hierarchy

Resolve disagreements consistently among broker, operational, accounting and explanatory sources.

System improvement

Define deterministic precedence separately for positions, prices, risk, decisions and explanations.

Evidence required

Contradiction scenarios and incident replay.

Authority boundary

No service may invent its own precedence.

Recommended stage

Core architecture rule

### 32. Degraded-Mode Matrix

Continue only the functions that remain safe during partial failure.

System improvement

Define allowed behavior for Ruby, data, broker, model, reconciliation, risk and database outages.

Evidence required

Chaos tests and operator drills.

Authority boundary

Risk uncertainty stops new exposure; optional intelligence failure does not endanger positions.

Recommended stage

Before limited live

### 33. Fault-Containment Cells

Keep a narrow failure from unnecessarily disabling healthy accounts and brokers.

System improvement

Partition by broker, connection, account, symbol, strategy, workspace and region.

Evidence required

Blast-radius tests and shared-dependency analysis.

Authority boundary

Global pause still applies when shared risk or economic truth is uncertain.

Recommended stage

Operational maturity

### 34. Recovery Probation

Restore authority gradually after a breaker or outage.

System improvement

Apply temporary size, position-count, strategy and duration limits until health evidence accumulates.

Evidence required

Recovery drills and recurrence analysis.

Authority boundary

A second failure returns immediately to suspension.

Recommended stage

Before live automation

### 35. Time-Travel Debugger

Reconstruct exactly what ARX knew at a historical timestamp.

System improvement

Load bitemporal market, account, policy, model, health and pending-order state without future leakage.

Evidence required

Incident reproduction and deterministic replay.

Authority boundary

Read-only diagnostic function.

Recommended stage

Evidence platform v2

### 36. Incident Counterfactual Replay

Test which proposed safeguard would actually have prevented an incident.

System improvement

Replay the same event with alternative stale limits, reconciliation cadence, idempotency and risk policies.

Evidence required

Reproducible incident fixtures and comparative outcomes.

Authority boundary

Produces remediation evidence; does not rewrite production history.

Recommended stage

Operational learning

## Self-Trading product system

### 37. Bounded Autonomy Levels

Let the account owner grant Observe, Prepare, Confirm, Demo Auto, Limited Live, Close-Only or Frozen authority.

System improvement

Scope authority per account, strategy, instrument and mission with automatic expiry.

Evidence required

Permission tests, UI/API parity and expiry behavior.

Authority boundary

New connections default to Observe; authority never rises automatically.

Recommended stage

Self-Trading foundation

### 38. Personal Trading Constitution

Convert the owner’s non-negotiable rules into enforceable policy.

System improvement

Define markets, strategies, hours, loss ceilings, stop requirements, leverage and automation conditions.

Evidence required

Policy-as-code tests and shadow impact reports.

Authority boundary

User can make it stricter; critical relaxations require deliberate authorization.

Recommended stage

Self-Trading foundation

### 39. Mission Builder

Give automation a short-lived objective and risk envelope instead of an indefinite switch.

System improvement

Bind account, duration, markets, strategies, entry count, loss budget and end behavior.

Evidence required

Mission state tests and session reconciliation.

Authority boundary

Cannot exceed account constitution or platform limits.

Recommended stage

Guided/automated Self-Trading

### 40. Trade-With-Me Guided Mode

Create a complete assisted loop for users who want intelligence without full automation.

System improvement

Scanner finds, Ruby explains, ticket prepares, user confirms, ARX executes, protects and reviews.

Evidence required

User-flow tests and decision-fidelity checks.

Authority boundary

All actions pass the same data, permission, risk and execution path.

Recommended stage

Primary consumer experience

### 41. Personal Discipline Guard

Help the owner enforce their own rules during manual trading.

System improvement

Support cooling-off, session duration, rapid-entry limits, stop protection and size-increase restrictions.

Evidence required

Behavioral simulations and override analysis.

Authority boundary

Uses observable actions, not psychological diagnosis; hard limits remain server-enforced.

Recommended stage

Self-Trading differentiator

### 42. Risk Vault and Delayed Increases

Make impulsive risk expansion difficult while allowing immediate reductions.

System improvement

Require delay, fresh authentication and optional extra approval for ceiling increases.

Evidence required

Policy and security tests.

Authority boundary

No automated or conversational path may raise the vault ceiling.

Recommended stage

Before live Self-Trading

### 43. Approval Inbox and Expiring Tickets

Centralize scanner, Ruby and automation drafts awaiting owner action.

System improvement

Show thesis, maximum loss, entry range, risk result and expiry.

Evidence required

Stale-confirmation and multi-device tests.

Authority boundary

Expired or changed evidence requires a new ticket and risk decision.

Recommended stage

Guided trading UX

### 44. Manual Takeover

Let the owner assume control of an automated position without disabling safety.

System improvement

Stop strategy management, preserve protection, mark manual control and continue reconciliation.

Evidence required

Concurrent-command and state-transition tests.

Authority boundary

Manual control cannot disable Risk, protection or audit.

Recommended stage

Position management

### 45. Performance and Decision-Quality Intelligence

Measure whether ARX and the user followed a sound process independently of P&L.

System improvement

Compare manual, assisted, modified and automated trades across timing, risk, execution and override behavior.

Evidence required

Sufficient samples, uncertainty bands and reproducible attribution.

Authority boundary

No gamification that rewards trade volume.

Recommended stage

Review product

### 46. Broker-Native Escape Route

Ensure the account owner is never trapped behind the ARX interface.

System improvement

Show broker identity, direct-access instructions, last confirmed positions and emergency procedure.

Evidence required

Operational drills and account-offboarding tests.

Authority boundary

ARX does not custody or conceal broker access.

Recommended stage

Non-negotiable user safety

## Managed allocation and institutional evolution

### 47. Risk Cells

Partition master-approved risk among assigned users or broker-native subaccounts.

System improvement

Track account, user, symbols, strategies, limits, reservations and freeze state atomically.

Evidence required

Concurrency and cross-assignment penetration tests.

Authority boundary

User ceilings can only be lower than master/platform ceilings.

Recommended stage

Managed Allocation foundation

### 48. Assignment Isolation

Prevent delegated users from seeing credentials or acting outside assigned accounts.

System improvement

Apply server-side permissions to every read, action and stream.

Evidence required

Synthetic-user adversarial tests.

Authority boundary

Default deny; revocation is immediate.

Recommended stage

Managed Allocation foundation

### 49. Position Ownership Resolver

Give each position exactly one controlling thesis and attributable owner.

System improvement

Resolve strategy/user ownership, netting effects, management authority and P&L attribution.

Evidence required

Partial-fill, netting and conflicting-command scenarios.

Authority boundary

Ambiguous ownership blocks automated management.

Recommended stage

Before multi-user execution

### 50. Institutional Hierarchy

Support organization, legal entity, portfolio, account, subaccount, risk cell and role relationships.

System improvement

Model beneficial ownership, policies, approvals and consolidated exposure.

Evidence required

Authorization, accounting and reporting reconciliation.

Authority boundary

Does not remove jurisdiction-specific compliance gates.

Recommended stage

Later institutional stage

### 51. Separation of Duties

Prevent one compromised identity from authoring, approving, funding and deploying risk.

System improvement

Distinct strategy author, validator, risk approver, account admin, deployer and auditor roles.

Evidence required

Role-conflict tests and immutable administrative history.

Authority boundary

Two-person approval becomes optional or mandatory by account policy.

Recommended stage

Institutional security

### 52. Compliance and Jurisdiction Policy

Make eligibility depend on user residence, broker entity, product, account mode and legal approvals.

System improvement

Return eligible, restricted, read-only, compliance hold or ineligible with explicit reasons.

Evidence required

Counsel-approved policy artifacts and broker-term verification.

Authority boundary

Engineering cannot decide whether outside-client management is lawful.

Recommended stage

Business gate before managed live

## Governance, operations and product integrity

### 53. Capital Constitution

Define the rules ordinary configuration and AI may never weaken.

System improvement

Encode capital preservation, uncertainty, attribution, reconciliation, refusal and authority limits.

Evidence required

Architecture fitness tests and policy audits.

Authority boundary

Changes require explicit owner/governance procedure.

Recommended stage

Immediate governance artifact

### 54. Owner Decision Registry

Preserve business, risk, regulatory and product rulings with rationale and review date.

System improvement

Link each ruling to policies, implementation and affected components.

Evidence required

Drift checks between decision, code and deployment.

Authority boundary

Agents may surface decisions but not silently replace them.

Recommended stage

Immediate governance artifact

### 55. Safety Case Per Release

Require evidence that a release is safe for its intended authority.

System improvement

Package change scope, new failure modes, tests, replay, shadow/demo, rollback and approvals.

Evidence required

Machine-verifiable artifacts and independent review.

Authority boundary

Green CI alone does not grant live authority.

Recommended stage

Before limited live

### 56. Continuous Certification

Expire broker, strategy, model and recovery authority unless evidence remains current.

System improvement

Attach review periods and automatic authority reduction to certifications.

Evidence required

Expiry and recertification drills.

Authority boundary

Expiration reduces authority; it never silently renews live access.

Recommended stage

Operational maturity

### 57. Architecture Fitness Functions

Continuously prove that module boundaries remain intact.

System improvement

Test that only Risk authorizes, only Execution calls brokers, and Research/LLMs cannot reach live credentials.

Evidence required

CI dependency and forbidden-import checks plus runtime policy tests.

Authority boundary

Violations block release.

Recommended stage

Immediate engineering control

### 58. Intelligence ROI Ledger

Measure whether each intelligent component earns its complexity.

System improvement

Track losses avoided, profits missed, costs, incidents, latency and incremental decision value.

Evidence required

Ablation and baseline comparison.

Authority boundary

Low-value components are simplified or removed.

Recommended stage

Ongoing product governance

### 59. Minimum-Intelligence Baseline

Maintain the simplest safe system as the benchmark.

System improvement

Compare every added model with trustworthy data, one edge, hard risk, deterministic execution and reconciliation.

Evidence required

Cost-adjusted performance and operational burden.

Authority boundary

Complexity must prove incremental value.

Recommended stage

Immediate research discipline

### 60. Graceful Simplification

Allow ARX to shed optional intelligence while preserving safety.

System improvement

Define full, reduced and safety-only modes.

Evidence required

Load, outage and dependency-failure tests.

Authority boundary

If the hot path misses deadlines, new entries stop before position protection degrades.

Recommended stage

Operational resilience

### 61. Deletion Discipline

Improve architecture by removing dead, duplicated, unobserved and unvalidated components.

System improvement

Require a removal review in major releases and preserve historical explainability.

Evidence required

Usage evidence, dependency scans and rollback plans.

Authority boundary

Removal cannot erase financial/audit history.

Recommended stage

Ongoing maintenance

# Part III — Research backlog not previously explored

The following subjects were intentionally not part of the preceding ARX discussion. They are included for research completeness, not as commitments. Most become relevant only after the deterministic core, broker truth, demo execution, reconciliation and governance system are proven.

#

New research area

What to investigate

Why / when it matters

1

Formal verification of order and position protocols

Apply TLA+, PlusCal or equivalent model checking to idempotency, partial fills, cancel/replace, leader failover and reconciliation state machines.

Useful because concurrency defects may survive example-based tests. Start only after the canonical state machines stabilize.

2

Adversarial machine-learning defense

Research feature poisoning, malformed broker streams, prompt injection into Ruby, model artifact tampering and poisoned research datasets.

Treat model and data supply chains as security boundaries; build signed artifacts and provenance verification.

3

Model and software supply-chain attestations

Create SBOMs, signed model packages, reproducible builds and dependency provenance for every live release.

Especially valuable before third-party adapters or strategy packages are accepted.

4

Confidential computing for credential use

Evaluate hardware-backed enclaves or isolated signing services so the main application never directly handles reusable broker secrets.

Research feasibility per broker; do not add complexity unless the threat model justifies it.

5

Trade-surveillance and market-abuse controls

Detect wash-like behavior, self-trading across accounts, manipulation patterns, abusive automation and prohibited order behavior.

Required if ARX expands beyond personal self-trading or supports certain regulated venues.

6

Communications supervision and retention

Govern trading instructions, Ruby conversations, approvals and disclosures when regulation requires archival or review.

Policy depends on jurisdiction and product role; avoid retaining unnecessary private conversation by default.

7

Derivatives risk surfaces

Add Greeks, volatility surfaces, assignment/exercise, liquidation and nonlinear scenario risk for options, futures and leveraged derivatives.

Out of scope for the initial Deriv synthetic-index universe but necessary before supporting these products.

8

Liquidity-provider and toxic-flow analysis

Study adverse selection, queue position, maker/taker economics and post-fill price movement where order-book data exists.

Could improve execution policy but requires venue-specific evidence and entitlements.

9

Simulation fidelity scoring

Measure how closely historical, synthetic, demo and digital-twin environments reproduce live execution and market behavior.

Prevents high-confidence conclusions from low-fidelity simulations.

10

Federated or privacy-preserving learning

Explore learning across user accounts without centralizing raw histories, using secure aggregation or federated methods.

Only worthwhile after a multi-user dataset exists and governance is mature.

11

Data licensing and redistribution governance

Track whether broker market data may be cached, derived, displayed, shared or used for model training.

A necessary commercial control for a multi-broker product, separate from technical access.

12

Strategy intellectual-property protection

Define encryption, access control, licensing, export and revocation for private or third-party strategies.

Needed only if ARX becomes a strategy distribution platform.

13

Cross-border tax and reporting engine

Research tax lots, withholding, reporting currencies, entity treatment and jurisdiction-specific exports.

Preserve raw economic events now; implement tax conclusions only with qualified guidance.

14

Capital-transfer and treasury security

Design multi-approval, withdrawal allowlists, delays, fraud controls and separate custody authority if ARX ever moves funds.

Keep read-only/advisory until a much stronger security and regulatory program exists.

15

Operational dependency graph and systemic failure modeling

Model shared cloud, DNS, secrets, database, AI, data and broker dependencies across otherwise diversified accounts.

Adds operational concentration to portfolio risk.

16

Energy, compute and inference-cost governance

Measure the monetary and latency cost of every model and research process and route work to the cheapest sufficient method.

Supports commercial scale and the intelligence ROI ledger.

17

Human-factors laboratory

Study how real users interpret confidence, risk, unknown states, alerts and confirmation under time pressure.

Use observed usability tests rather than assuming technically correct wording is understood.

18

Accessibility under urgent trading conditions

Research screen-reader, motor, color, cognitive-load and emergency-action requirements during volatile markets.

Accessibility defects can become execution and safety defects.

19

Voice and multimodal command safety

If voice, screenshots or chart annotations are accepted, define transcription confidence, confirmation, provenance and action boundaries.

Multimodal input should create drafts, never hidden live authority.

20

External audit and assurance program

Define when independent security, financial-control, model-risk and penetration audits are required.

Internal evidence is not always sufficient once outside capital or substantial live authority is involved.

21

Regulatory change intelligence

Track broker-term, jurisdiction and market-rule changes and identify affected policies and accounts.

Changes should create review tasks, not automatically rewrite compliance policy.

22

Customer support evidence console

Provide privacy-scoped diagnostics that let support resolve connection, order and reconciliation problems without viewing secrets or unrelated accounts.

Needed for scale; must preserve least privilege and immutable access logs.

23

Commercial unit economics and risk pricing

Model market-data, broker integration, support, compute, incident and compliance cost per user/account.

Prevents features from scaling operational loss even when trading logic works.

24

Insurance and operational-risk transfer

Explore whether cyber, errors-and-omissions, crime or other coverage is appropriate for the eventual business model.

A business-governance question, not a substitute for controls.

25

Post-quantum and long-term cryptographic migration

Inventory long-lived signatures, encrypted archives and secrets that may need future algorithm migration.

Low immediate priority, but design cryptographic agility instead of hard-coding one algorithm forever.

# Part IV — Evidence and research operating system

ARX should not treat research as a notebook that occasionally produces code. Research is a governed production pipeline with explicit questions, frozen evidence, independent validation, and a default outcome of rejection.

## Research lifecycle

Observe a measurable problem, anomaly or opportunity without deciding the conclusion.

Search the negative-knowledge library and prior experiments.

Write a falsifiable hypothesis and the evidence that would reject it.

Approve the dataset, labels, cost assumptions, sample boundaries and search budget.

Register the experiment before reading the final holdout.

Run chronological development tests with leakage controls.

Run walk-forward, sensitivity, ablation and materially worse-cost tests.

Use the untouched final holdout once after the design is frozen.

Reject, retest with a stated reason, or send to shadow; never promote directly.

Collect live shadow and demo evidence, including execution and reconciliation.

Produce a safety case, behavioral diff and owner review packet.

Promote only to the maximum authority earned by the evidence, with automatic expiry and retirement rules.

## Minimum evidence package

Preregistered hypothesis, decision target and falsification criteria.

Dataset provenance, hashes, time ranges, exclusions and data-quality report.

Exact feature, label, cost and execution assumptions.

Train, validation, walk-forward and final-holdout boundaries.

Calibration, conservative EV, drawdown, tail, capacity and abstention results.

Sensitivity to parameters, latency, slippage, missed fills and missing data.

Ablation of every feature and comparison with the minimum-intelligence baseline.

Code commit, model artifact, configuration hash and deterministic replay result.

Shadow/demo sample, broker behavior and reconciliation evidence.

Known limitations, unsupported regimes, breakers, expiry and rollback path.

## Research questions that must remain open

Whether any candidate edge remains positive after realistic costs and sufficient out-of-sample evidence.

Whether the intended opportunity rate supports the original trade-throughput objective without manufacturing trades.

Whether performance transfers across Deriv instruments, brokers or account environments.

Whether complex models add durable value over interpretable baselines.

Whether observed market relationships are stable mechanisms or temporary correlations.

Whether the product can support meaningful live capital within the approved drawdown and operational constraints.

# Part V — Authoritative delivery sequence

The correct implementation sequence is determined by dependency and risk, not by feature excitement. Later-stage intelligence remains documentation or research until earlier truth and control layers are verified.

Phase

Exit condition / deliverable

Phase 0 — Constitution and repository truth

Canonical domain language, owner decisions, policy-as-code, architecture boundaries, CI, invariant tests and one authoritative repository.

Phase 1 — Read-only broker truth

Connections, secrets, account discovery, runtime symbols, broker-native candles/ticks, capabilities, entitlements, snapshots and data quality.

Phase 2 — Evidence foundation

Immutable event ledger, bitemporal records, replay clock, feature parity, state snapshots, decision graph and time-travel diagnostics.

Phase 3 — Research and first validated edge

Research registry, cost model, baseline models, abstention, walk-forward/holdout and first validation report. No trading.

Phase 4 — Common decision and risk path

Opportunity lifecycle, typed decisions, permissions, personal/master limits, portfolio exposure, reservations, breakers and refusal reasons.

Phase 5 — Demo execution truth

Certified adapter, idempotent orders, partial fills, protection, UNKNOWN handling, reconciliation, accounting and restart recovery.

Phase 6 — Self-Trading guided mode

Scanner, broker-native chart, Ruby explanation, risk-first ticket, confirmation, position center, mission, journal and debrief.

Phase 7 — Shadow and controlled demo automation

Champion/challenger, OOD, structural breaks, execution-quality monitoring, adversarial scenarios and continuous certification.

Phase 8 — Limited live

One owner account, one broker, one strategy, minimal canary capital, expiring authority, recovery probation and explicit owner enablement.

Phase 9 — Portfolio and multi-broker intelligence

Market selection, capital scheduling, portfolio admission, account topology, venue comparison and global personal portfolio.

Phase 10 — Managed Allocation

Risk cells, exclusive/subaccount assignment, ownership, segregation, compliance approvals, institutional roles and external audit.

Phase 11 — Advanced autonomous research

Strategy compiler, discovery, evidence weighting, policy shadowing, intelligence ROI, continuous retirement and carefully bounded optimization.

## Immediate decisions and holds

Real money remains OFF until evidence, demo execution, reconciliation, recovery and owner authorization gates pass.

MT5 requires a terminal-side EA or another certified connector when the broker exposes no suitable direct API.

Broker-native market data is primary; no fabricated candles or guessed symbol identifiers.

Self-Trading is the first complete product mode. Managed Allocation follows only after account isolation and compliance are proven.

Shared live netting among assigned users remains prohibited unless true broker-native subaccounts or equivalent isolation exist.

Outside-client discretionary management remains COMPLIANCE_HOLD pending jurisdiction-specific counsel and broker approval.

The original trade-count and dollar targets remain objectives/capacity ideas, never quotas or evidence of available edge.

# Definition of ARX

Final definition: ARX is an evidence-driven capital operating system. It observes broker truth, recognizes qualified opportunities, challenges its own conclusions, authorizes only bounded risk, executes deterministically, protects and reconciles positions, preserves every consequential fact, learns through governed research, and gives the owner explicit control over every increase in authority. Further ideas enter the roadmap only when they solve a measured problem, have an evidence plan, preserve the authority hierarchy, and identify what can be removed or simplified in exchange.