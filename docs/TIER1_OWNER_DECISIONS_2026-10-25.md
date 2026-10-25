# Tier 1 owner decisions (2026-10-25)

The owner (Portava) made these decisions on 2026-10-25 in the project thread.
The text of each decision is kept as given. Where each one was implemented is
recorded in the domain docs (`docs/TIER1_*.md`, "Round 5") and in
`docs/TIER1_OWNER_RUNBOOK.md` section 8. ARX Tier 1 Scorecard v2
(`docs/scorecard/v2/`) cites this file for its criteria.

The Codex worktree mentioned by the owner (`~/arx-position-ledger` on the
owner's Mac) is outside this repository and must be preserved; it is not
applied wholesale.

The owner's "No score claims" limit below applied to the missing original
scorecard. On 2026-10-25 the owner retired that scorecard and authorized ARX
Tier 1 Scorecard v2 with its own baseline (`docs/scorecard/v2/README.md`).

## Platform Safety
1. Live activation must NOT release an emergency stop. Create one explicit, authorized, audited release operation. Release the selected stop consistently across all applicable settings rows; clear its active reason/time while retaining the audit history. Do not clear another stop or re-arm trading implicitly.
2. Broker-health executionEnabled and maintenanceMode must affect the applicable DEMO/LIVE venue verdict. Platform Safety owns the operator-control decision; Broker Hub supplies health facts. Disabled execution or maintenance blocks new risk. Preserve existing governed close/cancel/protection paths and their checks.
3. Make the four legacy gates action-aware. New-risk commands and /execute-trade must honour both applicable install-wide stops. Reconnect may remain available for recovery, but cannot clear stops, arm trading, or dispatch queued orders. PAPER keeps its documented exemption from the broker emergency stop; it still honours the safety-core stop. Do not apply a blanket block to every endpoint.
4. Include the safety-core kill switch in the safety envelope. Report both sources and derive new-risk permission from the common authority. Keep the actual emergency-stop field truthful; do not relabel the combined result as that individual switch. Preserve existing close/protection restrictions without adding accidental blanket refusals.
5. Install-wide stops should block automatic EA updates. Keep all existing checks for open positions, in-flight commands, trader stops and maintenance. Diagnostics remain available. Do not introduce an automatic recovery bypass.

## Risk Governor
6. Keep UNCLOSED as the governor's conservative position-count basis. An IGNORED or EXTERNAL reconciliation label is not broker-confirmed closure. Align the self-trade risk cap with this conservative basis. Do not exclude DEMO stop/target-hit rows merely because of their label when closure is unconfirmed. Display and advisory views may retain separately named, documented bases.
7. Use paper_orders, through the paper-book authority, for automated PAPER P/L, activity, losing streaks and risk decisions. paper_trades remains a manually entered journal. trades remains historical legacy data. Do not mix these sources or double-count them. Prepare reconciliation and compatibility handling before switching; missing historical coverage must not silently reset losses or restore a risk budget. Do not change DEMO accounting as a side effect.
8. Status views should show the effective limit actually enforced. Show the saved preference separately where useful, including why an operator cap overrides it. Remove contradictory display defaults and duplicate calculations. Keep editing preferences distinct from viewing effective limits.
9. Use the governor's authoritative trading-day definition and activity source for the daily-trade limit. Preserve the existing rolling-24-hour approved-command restriction as a separately named operational rate cap, with its own clear reason. Do not describe these different measurements as the same "trades per day" count or silently remove the stricter cap.
10. Fix the dead pending-order R:R hook. Read the real configured min_reward_risk_ratio through the risk authority. Apply the same calculation and refusal semantics as the governor, including missing/invalid inputs. This intentionally adds refusals where the configured floor previously did not run.

## Position Guardian
11. Keep alerts' stricter eligibility. Do not broaden trader alerts to ownerless or closed DEMO rows. Express alert eligibility through the central read model as a named, tested rule. Ownerless rows belong in authorized operator diagnostics, never an inferred trader account.
12. Choose option A for now: retain both physical position tables behind one ledger/read model. Do not start physical migration solely to improve the score. Record the merge-plan decisions:
- D1: No physical merge in this phase.
- D2: Preserve decision 6 and the explicitly named view semantics.
- D3: Preserve NULL ownership; never guess or auto-claim an owner.
- D4: If a future merge is separately approved, shadow-write failure uses savepoint-and-continue, with alerts and a cutover block until reconciled.
- D5: Timestamp zone and conversion correctness require P0 evidence; do not assume UTC. Float widening must preserve represented values.
- D6: Verify the production PostgreSQL version and uniqueness support; do not invent these facts.
- D7: Preserve legacy external IDs and references during any future transition.
- D8: A future cutover requires at least one full trading week of clean demo-bridge evidence and passive observation of existing LIVE activity. Never generate real-money trades for validation.
- D9: RLS changes require a separate tenant-security review; preserve current protections.
- D10: Retain legacy data for audit. No table or column drops.

## Trade Engine
13. Confirmed SIMULATED opens should create PAPER orders through the existing pipeline. Apply this to Trade Action Center and My Trades. Previews and drafts must not create positions. Require explicit simulated-mode labeling, normal risk checks, valid price provenance, and retry-safe idempotency. Do not fabricate historical fills.
14. Retire the legacy /execute-trade execution path. Inventory and migrate its callers to the canonical PAPER pipeline, then refuse the retired endpoint with an actionable response. Preserve historical trades rows and explain that their old mode field represented Safety Core state, not actual broker execution. Never silently convert a requested LIVE trade into PAPER.
15. Enable My Trades DEMO opens through the existing governed pipeline. Retain mode, ownership, confirmation, readiness, sizing and Risk Governor checks. Keep My Trades LIVE opens refused until broker validation passes and I separately authorize enabling that surface. Do not turn on live trading in this work.

## Broker Hub
16. Establish one authoritative account snapshot per MT5 connection. Broker Hub owns the balance/equity snapshot, with account identity, provenance and observation time. Legacy fields may remain compatibility projections. Do not substitute platform-account balances for a trader's account, choose a source without identity evidence, or drop columns. Prepare reconciliation before changing consumers.
17. Unify thresholds only where they measure the same concept. For comparable MT5 connection heartbeats, use: age <15 seconds: fresh; age >=15 and <60 seconds: degraded; age >=60 seconds: offline; missing or invalid observation: unknown, never execution-ready. Use one shared pure policy across server, domain and dashboard. Preserve any stricter existing execution requirement. Account snapshots, market prices, position snapshots and escalation timers are distinct concepts; do not force them onto heartbeat thresholds. Document each separately and test exact boundaries.
18. Bridge v2 should use the shared freshness vocabulary for comparable heartbeat facts. Keep stream-specific health separately identified. A healthy stream must not imply that an account is execution-ready. Preserve old response compatibility where needed.
19. Platform Safety should own the shared-live pause decision. Keep its scope limited to the relevant shared-live allocation or pool. Allocation routes call the authorized, audited safety API; Broker Hub retains broker facts. Do not accidentally turn a scoped pause into an install-wide stop.

## Implementation and verification (owner)
Record decisions in the existing docs, including intentional behavior changes and deferred production facts. Small dependency-ordered PRs. One authority per responsibility. Test: tenant and account isolation; stop engagement, explicit release and re-arm requirements; new-risk versus recovery/close behavior; duplicate settings rows; effective limits and counting boundaries; paper accounting, retries and duplicate prevention; freshness boundaries and unavailable inputs. Add meaningful regression coverage for new refusals and changed behavior. Never weaken tests or bypass failed checks.

## Limits (owner)
Do not deploy, apply production migrations, alter production rows, arm live trading, place real-money trades, or run broker actions. Never guess the legacy owner ID. Never bypass RLS or the Risk Governor. Ruby cannot override deterministic controls. No score claims. Keep TIER 1 NOT COMPLETE.

**TIER 1 NOT COMPLETE**
