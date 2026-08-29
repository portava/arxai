// ── Existing tables ─────────────────────────────────────────────────────────
export * from "./botSettings";
export * from "./riskSettings";
export * from "./strategies";
export * from "./signals";
export * from "./trades";
export * from "./backtests";
export * from "./performanceDaily";
export * from "./mt5Commands";
export * from "./alerts";
export * from "./watchlists";
export * from "./tradeJournal";

// ── Phase A core schema additions (May 2026) ────────────────────────────────
export * from "./users";
export * from "./userSettings";
export * from "./arxVoiceAdminSettings";
export * from "./symbols";
export * from "./tradePlans";
export * from "./tradeManagementEvents";
export * from "./learningInsights";
export * from "./mt5Connection";
export * from "./aiDecisionLog";

// ── Phase 1 Safety Core (May 2026) ──────────────────────────────────────────
export * from "./safetyCore";

// ── Per-user Trading Readiness (14-status engine, May 2026) ──────────────────
export * from "./userReadinessState";

// ── Private Beta 10 cohort invites (May 2026) ────────────────────────────────
export * from "./betaInvites";
export * from "./joinRequests";

// ── Opportunity Radar / AI Scanner Brain (May 2026) ──────────────────────────
export * from "./opportunityRadar";

// ── Phase 2 SHADOW: event-sourced Black Box Vault ───────────────────────────
export * from "./auditEvents";

// ── Build D — Risk Lock & Trading Permission System (May 2026) ──────────────
export * from "./riskLocks";

// ── Build F — Live Execution Safety Layer (May 2026) ────────────────────────
export * from "./executionConfirmations";

// ── Build TT — Live Trading Activation Infrastructure (May 2026) ────────────
export * from "./liveTrading";

// ── Phase A — ARX Live Trading Enablement (per-user, May 2026) ──────────────
export * from "./arxLiveExecution";

// ── Task #30 — Broker symbol specifications (per-user EA-reported truth) ─────
export * from "./arxSymbolSpecs";

// ── Task #371 — ARX Bridge v2 event trace + per-stream integrity state ──────
export * from "./bridgeV2Events";

// ── Task #397 — ARX Bridge v2 remote-config manifest (per-user, versioned) ──
export * from "./bridgeV2Config";

// ── Live Test Cycle (OWNER-only single-shot verification, May 2026) ─────────
export * from "./arxLiveTestCycles";

// ── Build G — Broker/MT5 Connection Health Monitor (May 2026) ───────────────
export * from "./brokerHealth";

// ── Build H — Live Position Management (May 2026) ───────────────────────────
export * from "./livePositions";

// ── Build I — Trade Journal & Review Center (May 2026) ──────────────────────
export * from "./journalEntries";

// ── Build J — Weekly Performance Review & AI Improvement Plan (May 2026) ────
export * from "./weeklyReviews";

// ── Build M — Multi-Timeframe Analysis Engine (May 2026) ────────────────────
export * from "./multiTimeframeReports";

// ── Build N — News & Economic Calendar Risk Filter (May 2026) ───────────────
export * from "./economicEvents";

// ── Build O — Portfolio & Exposure Risk Engine (May 2026) ───────────────────
export * from "./portfolioRisk";

// ── Build P — Backtesting & Strategy Validation Engine (May 2026) ───────────
export * from "./backtestRuns";

// ── Build Q — Paper Trading Sandbox (May 2026) ──────────────────────────────
export * from "./paperTrading";

// ── Build R — Prop Firm Challenge Mode (May 2026) ───────────────────────────
export * from "./propChallenges";

// ── Build S — AI Accountability & Rule Contract System (May 2026) ───────────
export * from "./ruleContracts";

// ── Build T — Session Preparation & Trading Readiness (May 2026) ────────────
export * from "./tradingReadiness";

// ── Build U — AI Post-Trade Debrief System (May 2026) ───────────────────────
export * from "./postTradeDebriefs";

// ── Build V — Personal Trading Playbook System (May 2026) ───────────────────
export * from "./tradingPlaybooks";

// ── Build W — AI Edge Discovery Engine (May 2026) ───────────────────────────
export * from "./edgeDiscovery";

// ── Build X — Trader Benchmark & Skill Level System (May 2026) ──────────────
export * from "./traderSkill";

// ── Build Y — AI Mentor Mode (May 2026) ─────────────────────────────────────
export * from "./aiMentor";

// ── Build Z — Institutional Analytics & Command Center (May 2026) ───────────
export * from "./analytics";

// ── Build AA — Trade Decision Orchestrator (May 2026) ───────────────────────
export * from "./tradeDecisionLogs";

// ── Build CC — Learning Feedback Engine (May 2026) ──────────────────────────
export * from "./learningEvents";
export * from "./strategyEdges";
export * from "./mistakePatterns";

// ── T019 — Owner/Admin Live Governance (per-user toggles, May 2026) ─────────
export * from "./ownerGovernance";

// ── Build EE — Paper Execution Engine (May 2026) ────────────────────────────
export * from "./paperExecutions";

// ── Build FF — Safe Paper Autopilot / Sniper Practice Loop (May 2026) ───────
export * from "./paperAutopilot";

// ── Build GG — Trading Calendar + AI Performance Command Center (May 2026) ──
export * from "./performanceCommandCenter";

export * from "./riskGovernor";

// ── Build II — Trader Coach + Playbook Generator (May 2026) ─────────────────
export * from "./traderCoach";

// ── Phase 28-MT5-DEMO-ARMING (May 2026) ─────────────────────────────────────
export * from "./mt5DemoExecution";

// ── Build JJ — Replay Simulator + Strategy Lab (May 2026) ───────────────────
export * from "./replaySim";

// ── Build KK — Data Import + Broker Read-Only Connector (May 2026) ──────────
export * from "./dataImportBroker";

// ── Build LL — Notification Center + Safety Alerts (May 2026) ───────────────
export * from "./notifications";

// ── Build MM — System Health, Audit, and Admin Control Center (May 2026) ────
export * from "./systemHealth";

// ── Build NN — Security, Roles, Permissions, and Data Protection (May 2026) ─
export * from "./security";

// ── Build OO — Final Integration Test Suite + Production Readiness Gate ─────
export * from "./readiness";

// ── Build PP — Controlled Paper Testing Launch Mode + Session Manager ───────
export * from "./paperSessions";

// ── Build RR — Guided Onboarding + Smart Help System ───────────────────────
export * from "./onboarding";

// ── Feature announcements / "What's New" popups (additive) ────────────────
export * from "./featureAnnouncements";

// ── Build TT — Live Intent Queue (FULL TESTER ACCESS, MT5-deferred) ───────
export * from "./liveIntents";

// ── Build UU — Beta tester feedback + issue tracker ─────────────────────
export * from "./feedback";

// ── ARX AI Paper Trade Ideas (May 2026) ─────────────────────────────────
export * from "./paperTradeIdeas";

// ── Per-user auth + activity (Phase 1 of per-user isolation, May 2026) ──
export * from "./authUserSessions";
export * from "./userActivityEvents";

// ── Task #202 — Self-serve password reset tokens (hashed, single-use) ───
export * from "./passwordResetTokens";

// ── Task #210 — Durable/shared password-reset rate-limit throttle ───────
export * from "./passwordResetThrottle";

// ── Phase 3A — Per-user trading sessions (May 2026) ─────────────────────
export * from "./tradingSessions";

// ── Phase 5A — Per-user paper trades (May 2026) ─────────────────────────
export * from "./paperTrades";

// ── Phase 6A — Per-user AI trade reviews (May 2026) ─────────────────────
export * from "./aiTradeReviews";

// ── Phase 7A — Per-user playbooks/rules/pre-trade checks (May 2026) ────
export * from "./userPlaybooks";

// ── Phase 8A — Per-user Risk Governor settings/events (May 2026) ───────
export * from "./userRiskGovernor";

// ── Phase 9E — Per-user dashboard alerts (May 2026) ────────────────────
export * from "./userAlerts";

// ── Phase 10 — Per-user notifications/preferences/push/activity (May 2026) ─
export * from "./userNotifications";
export * from "./userReports";

// ── Phase 13 — ARX AI Live Assistant (May 2026) ────────────────────────
export * from "./conversations";
export * from "./messages";
export * from "./arxAssistantMemory";

// ── Phase 23 — Admin-controlled DEMO/LIVE trading mode (May 2026) ──────
// SAFETY: see SAFETY_NOTES.md and docs/PHASE3_BROKER_PLACEMENT.md.
// Default state is fail-closed: platform_mode='OFF', kill_switch=true,
// all users suspended, live_approved=false. Order guard chain is the
// only path that may write status='APPROVED' to the trade audit log,
// and even an APPROVED row currently cannot reach a real broker because
// the broker placement layer is still locked (Phase 3 work).
export * from "./adminTrading";

// ── Phase UX2 — Live Trade Intelligence + Sniper Exit Alerts ────────────────
export * from "./tradeIntelligence";

// ── Phase UX6 — Market Context Engine ───────────────────────────────────────
export * from "./marketContext";
export * from "./tradeDecisions";
export * from "./tradeActionRequests";
export * from "./playbookSettings";

// ── Phase 13 — Protective Auto-Close (opt-in, default OFF) ─────────────────
export * from "./protectiveAutoClose";
export * from "./userActivity";

// ── Phase 28-MT5-DEMO-ARMING (May 2026) ────────────────────────────────────
export * from "./mt5DemoExecution";

// ── Master Live — per-user access gate + audit (May 2026) ──────────────────
export * from "./masterLiveAccess";
export * from "./oneClickTrade";

// ── Phase SLOT — Per-user slot allocation against shared master (May 2026) ──
export * from "./userSlotAllocation";

// ── Task #1 — Shared bridge: MT5 is source of truth ────────────────────────
export * from "./arxMasterBridgePool";

// ── Admin User Control Center — Risk Templates + per-user advanced perms ───
export * from "./riskTemplates";
export * from "./userAdvancedPermissions";

// ── Trade History Import ─────────────────────────────────────────────────────
export * from "./importedTrades";

// ── Trade History Import ──────────────────────────────────────────────────
export * from "./importedTrades";

// ── Shadow Predictions ──────────────────────────────────────────────────────
export * from "./shadowPredictions";

// ── Trader DNA Profile Cache ─────────────────────────────────────────────────
export * from "./traderDnaProfiles";

// ── Global Learning Layer ────────────────────────────────────────────────────
export * from "./globalLearning";

// ── TradingView Alerts ───────────────────────────────────────────────────────
export * from "./tradingviewAlerts";

// ── Mood Check-Ins ───────────────────────────────────────────────────────────
export * from "./moodCheckIns";
export * from "./tradingSchoolProgress";

// ── Learning Model Versions ──────────────────────────────────────────────────
export * from "./learningModelVersions";

// ── Task #32 — Remote EA configuration (per-user, audited delivery) ──────────
export * from "./eaRemoteConfig";

// ── Task #32 — EA update manager (manifest + approval + self-update audit) ───
export * from "./eaUpdateManifest";

// ── Task #72 — Investor Portal (view-only) ──────────────────────────────────
export * from "./investor";

// ── Agent Ecosystem (Layer 1) — registry + truth-locked prediction journal ──
// ADVISORY / SHADOW ONLY. Never gates, slows, or blocks any live/demo path.
export * from "./agents";
export * from "./agentPredictions";
export * from "./agentPredictionReviews";
export * from "./agentLearningCampRecords";
export * from "./agentLifecycleEvents";
// ── Agent Ecosystem (Layer 3) — Governed Agent Factory creation requests ─────
// ADVISORY / SHADOW ONLY. A request never auto-activates an agent; approval mints
// a SHADOW agent at 0% authority. Never gates, slows, or blocks any live/demo path.
export * from "./agentCreationRequests";

// Agent Ecosystem (Layer 3) — Agent Court disagreement records. OBSERVATION /
// LEARNING ONLY. Never gates, slows, or blocks any live/demo execution path.
export * from "./agentDisagreements";
export * from "./agentEcosystemSettings";

// ── Agent Ecosystem (Layer 4) — daily Household Report (§17) ────────────────
// ADVISORY / OBSERVATION ONLY. A point-in-time aggregate of ecosystem activity;
// never gates, slows, or blocks any live/demo path.
export * from "./agentHouseholdReports";

// Agent Ecosystem — persisted per-action governance trace. ADVISORY /
// OBSERVATION ONLY. Never gates, slows, or blocks any live/demo path; exists to
// PROVE governance involvement (and that AI never blocked the live path).
export * from "./agentGovernanceTraces";

// ── Task #79 — Ruby Flame Scalp Phase 2: failed-flame lockout ───────────────
export * from "./scalpManage";

// ── Task #80 — Ruby Flame Scalp Phase 3: journal + per-symbol personality ────
export * from "./scalpJournal";

// ── ARX Fund Book Phase 1 — strategy pools, unit-based NAV accounting,
// per-investor pool holdings, append-only unit-event ledger, trade→pool
// allocation. Accounting overlay only; never touches any execution path.
export * from "./fundbook";

// ── ARX Fund Book — Capital movements & fee engine (Task #132). Deposit /
// withdrawal request → approval → settle lifecycle that issues/redeems units via
// the NAV engine, with speed tiers, a configurable fee engine, per-deposit
// 30-day locks, disclosure acks, and advisory profit/loss preferences.
export * from "./fundbookCapital";

// ── ARX Fund Book — Discrepancy & controls center (Task #133). Admin
// reconciliation + safety-net engine: persisted discrepancy records (deduped on
// the logical entity), scoped freezes/locks, capacity/liquidity limits, and
// full-pool waitlist routing. DETECTION ONLY — never auto-edits balances, never
// touches any execution path.
export * from "./fundbookControls";

// ── Chart Brain v2 — Task 2: market-memory store for level personality.
// Meaningful chart events (held / rejected / breakout / failed_breakout /
// retest / wick_trap) keyed by symbol/timeframe. Market facts, not user data.
export * from "./chartMarketEvents";

// ── Chart Brain v2 — Task 5: per-user decision memory, immutable decision
// receipts (+ append-only outcome/review), and setup fingerprints. SLOW BRAIN
// learning layer — strictly per-user, never on the live path, never blocks
// candle render or order dispatch. Receipts are immutable after creation.
export * from "./chartDecisionMemory";
export * from "./chartInteractive";

// ── Signal Intelligence Core — Task #194: per-user market memory for the Ruby
// Market Edge "what changed since last read" diff. One row per
// (user_id, symbol, timeframe). Strictly per-user; never a live execution input.
export * from "./signalMemory";

// ── ARX Handshake System — cross-layer readiness check-in evidence (Task #193).
// Append-only log of advisory handshake outcomes for the admin System Handshake
// Monitor. ADVISORY ONLY — never gates execution, never on a hot path. Evidence
// rows are never auto-deleted.
export * from "./handshake";

// ── Task #199 — Outcome Learning & Admin Quality. Per-user signal-outcome
// tracking (truth-locked at-signal snapshot + evidence-resolved outcome),
// append-only post-trade self-reviews (user-simple + admin-detail), and
// admin-tunable learning thresholds. OBSERVATION ONLY — read-only over trade
// results; never gates, slows, or blocks any live/demo execution path.
export * from "./rubySignalOutcomes";
export * from "./rubySignalReviews";
export * from "./rubyQualityThresholds";

// ── Task #211 — Self-Trade AI (autonomous trading-agent ecosystem) Foundation.
// Operator-managed agent fleet (per-user future-ready): identity/state, settings/
// permissions, per-agent ledger + append-only entries, allocations linked to the
// existing slot-allocation system, multi-scope kill switches, and an append-only
// self-trade audit log. ADDITIVE — no autonomous execution in this phase.
export * from "./selfTradeAgents";

// ── Task #220 — Ruby Market Timing Brain heat snapshots (advisory, never execution gate)
export * from "./heatSnapshots";
export * from "./heatSnapshotRetentionRuns";

// ── Task #230 — ARX Adaptive Cohesion Intelligence (AACI 2.0) decisions.
// Append-only, per-user persistence of advisory cohesion decisions. ADVISORY /
// OBSERVATION ONLY — never an execution gate, never on a hot path.
export * from "./aaciDecisions";

// ── Task #232 — AACI Learning, Trust & Drift (Phase 6). Per-entity Bayesian
// trust (alpha/beta, 0.50 prior) evolving from REAL reconciled outcomes,
// append-only learning audit (versioning/rollback), and clamped adaptive
// weights. ADVISORY ONLY — shapes the learnedTrust (L) and drift (D) AACI
// sub-scores; never a gate, never auto-loosens a limit.
export * from "./aaciLearning";

// ── Task #319 — Ruby AI-Assisted execution ledger + watch/monitor lifecycle.
// Per-user command ledger with in-flight dedupe (no second execution path —
// these rows wrap the existing instant-trade → 16-gate pipeline) and a
// single-fire (CAS) watch/monitor instruction table. Evidence; never auto-deleted.
export * from "./rubyExecution";

// ── Task #432 — Persisted candle cache for deep, scrollable history.
// Durable OHLCV store keyed by (symbol, timeframe, source, barTime) with
// dedupe + upsert-newer + backfill-older. MARKET-DATA / TELEMETRY ONLY —
// never touches execution, the 16-gate pipeline, arx_live_*, balances, or fills.
export * from "./marketCandles";

// ── Task #469 — Broker-native candle store + backfill state machine.
// Durable, bridge-scoped OHLC store keyed by
// (bridge_connection_id, broker_symbol, timeframe, open_time_utc) with a
// per-series backfill status row. The CANONICAL system of record for EA
// CopyRates bars; accepted closed bars are mirrored into market_candles for the
// read path. MARKET-DATA / TELEMETRY ONLY — never touches execution, the
// 16-gate pipeline, arx_live_*, balances, or fills.
export * from "./brokerCandles";
export * from "./brokerCandleBackfillStatus";

// ── Task #617 — Chart Pattern Truth learning loop. Append-only, per-user
// observation of detected chart patterns and their evidence-resolved outcomes.
// Feeds ONLY Ruby's bounded confidence adjustment (still display/decision-support
// only); never an execution path, never the 16-gate pipeline, never a fill.
export * from "./patternOutcomes";
export * from "./trendlineOutcomes";

// ── Profit Mission Phase 1 — Planner, Feasibility & Dashboard Shell ──────────
// Per-user stated goal + SERVER-COMPUTED feasibility/probability/pace read.
// PLANNING + DISPLAY ONLY — never gates, relaxes, or touches any execution path.
export * from "./profitMissions";

// ── Task #705 — Claude Backend Fix Agent run ledger. Append-only record of
// admin-initiated backend-error DIAGNOSES and DRY-RUN patch proposals. ADVISORY
// / DIAGNOSTIC ONLY — never an execution path, never the 18-gate live pipeline,
// never a fill; inputs are redacted before persistence; no APPLY path exists.
export * from "./aiFixAgentRuns";

// ── Task #752 — Admin Cockpit control-room audit, alerts, and operator notes.
// Pure READ-aggregation + operator-control evidence. admin_cockpit_audit_log is
// append-only and mirrors (never replaces) the canonical admin audit when a
// mutation is initiated from the cockpit. ADVISORY / DISPLAY / AUDIT ONLY —
// never an execution path, never the 18-gate live pipeline, never a fill.
export * from "./adminCockpit";

// ── Session 2 Phase 6 — the Black Box. Append-only, BITEMPORAL, hash-chained
// record of every DECISION, the OBSERVATIONs behind it, and the OUTCOME that
// followed. Distinct from audit_events / security_events, which chain in
// APPLICATION code: event_log's row_hash is computed inside Postgres via
// pgcrypto, carries the full as-of feature vector + gate verdicts, and pins
// content-addressed lineage so a decision can be RE-DERIVED, not just re-read.
// APPEND-ONLY and inert — never gates, sizes, or places a trade.
export * from "./eventLog";

// ── Session 2 Phase 8 — discovery pipeline + FDR ledger. Four APPEND-ONLY
// tables whose prereg_hash + monotonic created_tx are the anti-fabrication
// spine: a hypothesis and its full parameter set are inserted BEFORE any metric
// exists, so a hypothesis invented after its results carries a higher created_tx
// than the trials that supposedly tested it — a contradiction visible in the
// table rather than a matter of trust. INERT: the terminal output is a
// CANDIDATE, written at DATA/WALK_FORWARD with liveAllowed=false; nothing here
// can reach live without the existing human SHADOW + ADMIN stages.
export * from "./discoveryPipeline";

// ── Phase 0 (prodready-20260819) — Owner Decision Registry (Blueprint #54).
// APPEND-ONLY rulings ledger; forward-fix via supersedesId, no UPDATE/DELETE.
export * from "./ownerDecisions";

// R2-S2 — append-only execution evidence log (unique(command_id, sequence_no)).
export * from "./executionEvents";
// Economic truth spine (#29/#30/#31) — APPEND-ONLY bitemporal double-entry
// postings + reconciliation discrepancy records. Corrections are reverse-and-
// repost journals, never UPDATE (check-vault-mutations guards both symbols).
export * from "./economicPostings";
// R2-S4 — persisted reconciliation runs (freshness gate input).
export * from "./reconciliationRuns";
// R4 slice 7 — per-connection market-data entitlement records.
export * from "./marketDataEntitlements";
// R6 — per-user broker eligibility; COMPLIANCE_HOLD is the fail-closed default.
export * from "./brokerEligibility";
// R7 step 6 — production edge library; rows are born with every live gate false.
export * from "./edgeLibrary";
// ── Multi-broker Phase 0B — tenant-owned, disabled metadata only ────────────
// Does not replace MT5 bridge state or permit connection/execution behavior.
export * from "./brokerHubMetadata";
export * from "./phase6GuidedExecution";
// ── Engine drivers (capabilities #58/#34/#15/#16/#5) — evidence + probation ──
// Additive-only; applied via docs/migrations-pending/build-engine-drivers.sql.
export * from "./engineDrivers";
// ── Opportunity Spine (#17/#18/#19) — owning per-setup lifecycle objects ─────
// Additive-only; applied via docs/migrations-pending/build-opportunity-spine.sql.
export * from "./opportunitySpine";
