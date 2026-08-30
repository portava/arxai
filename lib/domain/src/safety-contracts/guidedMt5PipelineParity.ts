// Guided-path parity with the MT5 dispatchLiveCommand pre-gates.
//
// THE ARTIFACT THE AUDIT SAID DID NOT EXIST. PROJECT_STATE.md called the
// missing mapping "the single largest open architectural question": the guided
// Deriv-demo path deliberately does not enter dispatchLiveCommand, and nothing
// recorded whether its walls are equivalent to the ~40 blocking checks the
// MT5 pipeline runs. This file is that record, produced 2026-08-30 by a
// 20-agent enumerate→map→adversarially-verify sweep in which every GAP,
// EQUIVALENT and NOT_APPLICABLE claim was independently attacked against code
// (all 25 dangerous claims survived; zero were corrected).
//
// The two GAPs the sweep found — operator risk locks and close-only mode not
// binding guided dispatch — were FIXED the same day (guidedDispatchEntry
// operator-stop wall, pre-claim, same pure deciders as MT5), so no GAP
// disposition remains. WEAKER dispositions are stated, not hidden: each names
// precisely what is weaker so a reader can judge whether it matters for a
// demo-only venue.
//
// Contract-only: importing this dispatches nothing. Line numbers reference
// artifacts/api-server/src/lib/live/liveCommandPipeline.ts at the audit
// commit; they drift with edits — the CHECK NAMES are the stable spine.

export type GuidedParityDisposition =
  | "EQUIVALENT"      // the guided path enforces the same protection
  | "STRICTER"        // the guided path enforces more than MT5 does
  | "WEAKER"          // guided has a weaker version — the reason says what is weaker
  | "NOT_APPLICABLE"; // the risk cannot arise on the guided Deriv-demo path — the reason proves why

export interface GuidedParityEntry {
  /** Where the MT5 check lived at audit time. */
  mt5Lines: string;
  disposition: GuidedParityDisposition;
  /** What enforces it on the guided path (EQUIVALENT / STRICTER / WEAKER). */
  guidedEnforcedBy: string | null;
  reason: string;
}

export const GUIDED_MT5_PIPELINE_PARITY: Readonly<Record<string, GuidedParityEntry>> = {
  OWNED_COMMAND_LOOKUP: {
    mt5Lines: "2247-2248",
    disposition: "STRICTER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:211-212 (load), /private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scra…",
    reason: "MT5 enforces ownership once, at the initial read; the guided path enforces the identical query-level ownership at load AND re-enforces it in the pure authorization AND inside the atomic claim UPDATE's own WHERE clause, so ownership cannot be lost to a TOCTOU between read and write. MT5's post-lookup blocking UPDATEs (liveCommandPipeline.ts:2272-2285, 2331-2342, 2379-2390) filter by commandId alone and rely on the si…",
  },
  APPROVED_STATUS_REPLAY_GUARD: {
    mt5Lines: "2249-2260",
    disposition: "STRICTER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/lib/domain/src/safety-contracts/approvalTicket.ts:189-212 (state machine + prior-claim refusal), /private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97b…",
    reason: "MT5's guard is a check-then-act read: it reads row.status, refuses BAD_STATE if not LIVE_APPROVED, and fire-and-forgets a security event — the read itself provides no atomicity for this named check. Guided enforces the same only-APPROVED-passes rule three ways, the last atomic: a total state machine with a named refusal per non-APPROVED state, a refusal on any prior dispatchClaimedAt even in dispatchable states, and…",
  },
  COMMAND_INTEGRITY_PRE_GATE: {
    mt5Lines: "2268-2305",
    disposition: "WEAKER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/lib/domain/src/safety-contracts/approvalTicket.ts:234-239 (fingerprint binding, called from guidedExecutionService.ts:260-265) + 203-205 (dispatch-clock expiry…",
    reason: "The guided path covers the check's drift/expiry/replay components as well or better — TERMS_CHANGED_SINCE_APPROVAL re-derives every material field from the persisted row and compares to the approval-time fingerprint; expiry is enforced at both the dispatch clock and the database clock with a 5-minute TTL (meApprovalInbox.ts:220) vs MT5's 600s freshness — but it is WEAKER on the tamper/forgery/source axis, which is t…",
  },
  ALLOCATION_FREEZE_PRE_GATE: {
    mt5Lines: "2318-2357",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The asset this gate protects cannot be reached by a guided dispatch. The freeze reads user_slot_allocation — the operator-funded live slot allocation — and blocks a frozen user's live MT5 commands so frozen operator money cannot be spent or newly exposed. On the guided path no allocation exists to freeze-protect: (a) nothing in the guided/deriv execution code reads user_slot_allocation or tradingFrozen (grep over ar…",
  },
  OPERATOR_FUNDED_PILOT_GATE: {
    mt5Lines: "2373-2404",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "Every condition this gate enforces exists to control who may spend the operator's live money in a 10-user pilot: master pilot switch, accepted ARX_PRIVATE_BETA_10 invite, compliance review flag, operator-assigned allocation > 0 (virtual_trading_accounts), a cohort-cap defense, and a VERSION-pinned operator-funded disclosure. That scenario cannot arise on the guided path, proven by executed code: no operator-funded l…",
  },
  EMERGENCY_KILL_SWITCH_PRE_GATE: {
    mt5Lines: "2432-2469",
    disposition: "STRICTER",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:210-212 (predicate 205-223), consulted at artifacts/api-server/src/lib/phase6/derivDependencyResolver.ts:146-148, wired at guidedDispatchEntry.ts:726",
    reason: "The guided path reads the same global_trading_settings.emergency_kill_switch column with the identical fail-closed polarity as the MT5 pre-gate, before any frame can be written, and enforces MORE: (a) the same predicate also blocks on the per-user arming switch and the Phase 1 safety-core switch; (b) any read failure blocks; (c) the MT5 gate's one relaxation — the killSwitchCloseBypass marker for admin emergency-clo…",
  },
  SAFETY_CORE_KILL_SWITCH_PRE_GATE: {
    mt5Lines: "2480-2526",
    disposition: "WEAKER",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:217-219 (inside liveKillSwitchEngaged 205-223, consulted via derivDependencyResolver.ts:146-148)",
    reason: "The core protection — an engaged safety_core.kill_switch_engaged blocks dispatch pre-transmission, and a query failure blocks — IS enforced on the guided path. But the guided read is weaker than the MT5 pre-gate in two executed ways: (1) zero-row table: MT5 treats a never-initialised safety_core as UNKNOWN and refuses (readSafetyCoreKillSwitchEngaged returns null on no row, and the pure helper blocks on `!== false`)…",
  },
  RISK_LOCK_PRE_GATE: {
    mt5Lines: "2541-2583",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts operator-stop wall (activeRiskLockBlockReason, the same pure decider MT5 uses)",
    reason: "GAP closed 2026-08-30: active risk locks (user-owned or legacy ownerless) refuse every guided dispatch pre-claim; expired/inactive locks release.",
  },
  CLOSE_ONLY_PRE_GATE: {
    mt5Lines: "2594-2632",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts operator-stop wall (closeOnlyBlocksDispatch, the same pure decider MT5 uses)",
    reason: "GAP closed 2026-08-30: close_only_mode refuses every guided dispatch pre-claim (every guided order is an entry).",
  },
  PRICE_COLLAR_PRE_GATE: {
    mt5Lines: "2649-2700 (refusal block continues past 2700; condition and block entry are in-…",
    disposition: "STRICTER",
    guidedEnforcedBy: "artifacts/api-server/src/lib/deriv/execution/derivGuidedBuy.ts:178-192 (ceiling wired to the approved stake at guidedDispatchEntry.ts:769; venue-side ceiling in the BUY frame via artifacts/api-server/src/lib/deriv/newApi/wire.ts:82-93)",
    reason: "The MT5 collar is OPT-IN: it runs only when the user set maxEntryDeviationBps (the pure helper returns false on a null cap) and otherwise delegates slippage entirely to the EA. The guided path enforces its price protection on EVERY dispatch, fail-closed, in three layers: (1) the quote is fetched fresh at dispatch and an unreadable/null ask refuses — the exact 'cannot prove the price' fail-closed posture the demanded…",
  },
  SIGNAL_AGE_PRE_GATE: {
    mt5Lines: "2721-2762",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/approvalTicket.ts:203-205 (expiry at the DISPATCH clock) + lib/db/src/repositories/approvalTicketsRepo.ts:159 (DB-clock claim predicate)",
    reason: "Same protection class — a fail-closed, dispatch-time staleness bound on the authorizing artifact — with two precise deltas that offset. Guided is unconditional where MT5 is opt-in: signalAgeBlocksDispatch is skipped entirely when settings.maxSignalAgeMs is unset (liveCommandPipeline.ts:2722-2726), while every guided ticket carries a hard 5-minute expiry enforced at three independent layers (pure authorization at the…",
  },
  CORRELATION_CLUSTER_PRE_GATE: {
    mt5Lines: "2774-2849",
    disposition: "WEAKER",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:273-281 (position count + per-symbol exposure incl. new stake), fed by artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:121-152,168",
    reason: "The risk CAN arise on guided (several open multiplier contracts on correlated instruments stacking directional exposure) and guided bounds it only with correlation-BLIND aggregates: a global simultaneous-position cap, a per-symbol exposure cap that includes the NEW stake, and daily/weekly ceilings that count every open stake as a loss. What is precisely weaker: nothing on the guided path computes a cluster key or ca…",
  },
  BROKER_CONFIRMED_FEED_PRE_GATE: {
    mt5Lines: "2861-2923",
    disposition: "STRICTER",
    guidedEnforcedBy: "artifacts/api-server/src/lib/deriv/execution/derivGuidedBuy.ts:125-184 (connect readiness + proposal reply + ask validation), refusal made definite at artifacts/api-server/src/lib/deriv/execution/derivExecutionAdapter.ts:169-171",
    reason: "The MT5 gate blocks entries when broker-confirmed pricing for the symbol cannot be evidenced (candle-recency/feed-source facts via resolveBrokerConfirmedFeed), because an MT5 market order executes at broker prices sight-unseen; and its enforcement can be explicitly disabled via env to observe-only. The guided path enforces the underlying protection — no entry without the executing broker's own confirmed price for th…",
  },
  RECONCILIATION_FRESHNESS_PRE_GATE: {
    mt5Lines: "2934-3005",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:215-222 (unresolved-intent hard block) + artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:99-152 (open-until-RECONCILED, stake-as-loss observed state)",
    reason: "The guarded risk — dispatching a new entry while the system's picture of existing exposure is stale and possibly rosier than reality — is guarded on guided by an inverted, always-on mechanism: instead of demanding a recent affirmative reconciliation run, guided assumes the worst about everything unreconciled, so staleness can only TIGHTEN the gates, never loosen them. Concretely: (1) any attempt with an unknown outc…",
  },
  ARX_FOCUS_MARKET_BACKSTOP: {
    mt5Lines: "3057-3073",
    disposition: "WEAKER",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:253-258, executed at dispatch by artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:229-244 (and again at proposal, routes/meApprovalInbox.ts:282-306)",
    reason: "Guided does enforce a default-deny instrument wall at dispatch, but it is a per-user, SELF-AUTHORED allow-list, not the platform-authored 36-market approved universe. The trading user writes their own allowedInstruments via POST /me/trading-constitution (meApprovalInbox.ts:355-369, requireUser only; validation is constitutionIsWellFormed, whose list check is just Array.isArray at tradingConstitution.ts:179-183). Not…",
  },
  ENTRY_DATA_SUFFICIENCY_GATE: {
    mt5Lines: "3083-3108",
    disposition: "WEAKER",
    guidedEnforcedBy: "artifacts/api-server/src/lib/deriv/execution/derivGuidedBuy.ts:158-184 (mandatory venue proposal + explicit null/finite ask validation), surfaced as the definite DERIV_NO_ORDER_POSSIBLE refusal at artifacts/api-server/src/lib/deriv/execution/derivExecutionAda…",
    reason: "The gate has two halves. The FEED-LIVENESS half is covered on guided by venue truth, unconditionally: an entry cannot proceed unless Deriv itself returns a readable, finite ask for the exact symbol at dispatch time — a dead feed, closed market, or unquotable symbol yields orderPossible:false and a definite pre-BUY-frame refusal, arguably stronger evidence of a live market than ARX's secondhand M1 freshness probe. Th…",
  },
  ARX_FOCUS_MARKET_ENTRY_BACKSTOP: {
    mt5Lines: "3057-3073",
    disposition: "WEAKER",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:253-258 via guidedExecutionService.ts:229-244 (same mapping as ARX_FOCUS_MARKET_BACKSTOP — this inventory entry names the same MT5 code block, liveCommandPipeline.ts:3057-3073)",
    reason: "Duplicate inventory naming of the same MT5 check at liveCommandPipeline.ts:3057-3073 (verified: there is exactly one isApprovedArxMarket dispatch-time block in the file, plus the preflight mirror at :1459). Disposition is identical to ARX_FOCUS_MARKET_BACKSTOP: guided enforces a default-deny instrument allow-list at dispatch (INSTRUMENT_NOT_ALLOWED / INSTRUMENT_FORBIDDEN, forbidden-beats-allowed), but the list is au…",
  },
  SYNTHETIC_DATA_ONLY_LIVE_FLOOR: {
    mt5Lines: "3110-3170",
    disposition: "STRICTER",
    guidedEnforcedBy: "guidedDispatchEntry.ts:664 (venueForTicket: only broker 'deriv' → 'DERIV_DEMO', else null) + derivDependencyResolver.ts:137-141 and 164-167 (VENUE_NOT_DERIV on both hops), 183-195 (proven-demo) and 200-202 (tier); derivGuidedBuy.ts:158-195 (venue's own quote …",
    reason: "Every branch of the MT5 floor has a guided counterpart at least as strong, and the preconditions the MT5 OWNER relaxation merely samples are enforced unconditionally on guided, by the venue itself, for every dispatch. (a) The floor's stated premise — a Deriv synthetic 'is, in general, NOT routable on a standard MT5 broker, so dispatching one would silently fail or route to the wrong instrument' (syntheticLiveFloor.t…",
  },
  USER_MASTER_LIVE_ACCESS_GATE: {
    mt5Lines: "3186-3221",
    disposition: "STRICTER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:267-281 (env-credential owner clamp), :828-835 (disclosure), :205-223 (per-user/global/safety-core k…",
    reason: "The MT5 gate's protection is: no user dispatches via the shared platform account without per-user admin approval + enable toggle, absent suspension/revocation/risk-lock, an accepted-or-waived risk disclosure, and configured risk settings (all fail-closed on no row). Every sub-protection has an executed guided counterpart, and the permitted-user set is clamped harder: the shared env Deriv credential is usable by AT M…",
  },
  MASTER_LIVE_BRIDGE_GATE: {
    mt5Lines: "3222-3253",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/deriv/execution/derivGuidedBuy.ts:106-131 (endpoint liveness on the real socket); derivDependencyResolver.ts:137-141,164-175 + gui…",
    reason: "Read in full (masterLiveBridgeGate.ts:81-155), the gate enforces four protections; each has an executed guided counterpart. (1) Operator enable flags, fail-closed on a missing settings row (SHARED_LIVE_TRADING_DISABLED / MASTER_BRIDGE_LIVE_NOT_ENABLED, loader :138-144) → guided: a venue send requires ARX_EXECUTION_TIER to exactly equal TIER_1_DEMO_GUIDED — unset/unrecognised clamps to TIER_0 and the adapter throws D…",
  },
  MOCK_BRIDGE_SHORT_CIRCUIT: {
    mt5Lines: "3279-3310",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The MT5 risk exists because transports are DATA: mt5ConnectionTable rows (including MOCK placeholders) are selected at dispatch (liveCommandPipeline.ts:3262-3272), the Phase B evaluator never inspects bridge.mode, and MT5 dispatch is a mailbox write — so without the :3279 short-circuit a MOCK row with accountType='live' would absorb a live-believed command as SENT. That risk cannot arise on the guided path, for thre…",
  },
  WEEKLY_DRAWDOWN_CEILING_PRE_GATE: {
    mt5Lines: "3393-3460",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/lib/domain/src/safety-contracts/tradingConstitution.ts:270-272 (WEEKLY_LOSS_LIMIT_REACHED, null cap denies), evaluated at dispatch via guidedExecutionService.t…",
    reason: "Same protection — a weekly loss ceiling that refuses new entries at dispatch (every guided dispatch IS an entry: the surface only places approved buys, so MT5's entry-only carve-out is trivially matched and nothing can be trapped). Parameterization differs (absolute USD cap vs pct-of-reference-equity), with the deltas pointing BOTH ways. Stricter on guided: (a) the cap is MANDATORY — maxWeeklyLossUsd null/non-finite…",
  },
  MAX_OPEN_POSITIONS_CAP: {
    mt5Lines: "3514-3516",
    disposition: "STRICTER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/lib/domain/src/safety-contracts/tradingConstitution.ts:273-275, over the count built at guidedDispatchEntry.ts:121-133,168; TOCTOU closed by guidedDispatchEntr…",
    reason: "Same comparison shape (openCount >= cap → refuse) with three executed strengthenings. (1) The cap is MANDATORY: maxSimultaneousPositions is in the well-formedness ceilings list, so a missing/non-finite cap makes the whole constitution malformed and denies every dispatch (tradingConstitution.ts:185-190 with :227-229), whereas MT5 skips the check entirely when userMasterLiveAccessTable.maxOpenPositions is null (liveCo…",
  },
  MAX_EXPOSURE_PER_SYMBOL_CAP: {
    mt5Lines: "3517-3521",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:278-281 (SYMBOL_EXPOSURE_EXCEEDED), executed at dispatch via artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:229-244, observed figure from artifacts/api-server/src/lib/phase6/guidedDispatchE…",
    reason: "The same protection — a per-user, per-symbol POST-TRADE exposure ceiling that adds the NEW trade and counts in-flight sends — is enforced on every guided dispatch. MT5 blocks when perSymbolLots (open + in-flight for row.symbol) + requestedVolume > cap; guided blocks when openExposureForSymbolUsd + proposal.stakeUsd > maxExposurePerSymbolUsd, where the observed figure sums stake over EXECUTED/DISPATCHING/UNRESOLVED t…",
  },
  USER_MAX_OPEN_POSITIONS_CAP: {
    mt5Lines: "3470-3568",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:273-275 (MAX_SIMULTANEOUS_POSITIONS_REACHED), executed at dispatch via artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:229-244, count from artifacts/api-server/src/lib/phase6/guidedDispatchE…",
    reason: "Same protection: an entry-only per-user concurrency cap that counts open PLUS in-flight so parallel dispatches cannot both pass. MT5 counts arx_live_positions (closedAt null) + SENT_TO_MT5_LIVE commands not filled/rejected and blocks at openCount >= cap; guided counts tickets in EXECUTED/DISPATCHING/UNRESOLVED not venue-RECONCILED plus unresolved intents (openPositionCount = max of the two ledgers, guidedDispatchEnt…",
  },
  USER_PER_SYMBOL_EXPOSURE_CAP: {
    mt5Lines: "3470-3568",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "lib/domain/src/safety-contracts/tradingConstitution.ts:278-281 (SYMBOL_EXPOSURE_EXCEEDED) via artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:229-244 and artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:145-152,169",
    reason: "This inventory entry cites the identical MT5 code block as MAX_EXPOSURE_PER_SYMBOL_CAP (liveCommandPipeline.ts:3517-3521 — I read it; there is one per-symbol arm, not two), so the disposition is the same. The [flagged mt5-specific] concern is only the LOTS denomination — that is MT5/EA mechanics, but the risk the check guards (a user's aggregate per-symbol post-trade exposure exceeding a cap) is venue-neutral, CAN a…",
  },
  DISPATCH_ACTIVATION_GATE_RECHECK: {
    mt5Lines: "3572-3609",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:227-257 (constitution re-evaluated at dispatch + version pin) and 260-265 with lib/domain/src/safety-contracts/approvalTicket.ts:189-212 (state/expiry/claim at the dispatch clock); dispatch-time re…",
    reason: "The MT5 check's protection is TOCTOU: authorization state that can be revoked between draft and dispatch (Full Live Activation revoked, account reclassified bot/agent/system/investor — I read evaluateLiveExecutionActivationGate/decideLiveExecutionActivationGate, approvedTraderLiveState.ts:385-426: it fails on isBotAgentSystem, isInvestor, or !executionActivated where executionActivated = liveExecutionEnabled && !liv…",
  },
  MANAGEMENT_AUTHORITY_CONTENTION_REFUSE: {
    mt5Lines: "3648-3697",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The risk this check guards CANNOT arise on the guided Deriv demo path because the guided surface has no position-management verb at all — there is nothing to contend over. The MT5 check arbitrates only 'when THIS command manages an open position (CLOSE/MODIFY by brokerTicket) while another in-flight command already claims the same position' (liveCommandPipeline.ts:3648-3667). Proof of absence on guided, from execute…",
  },
  MANAGEMENT_AUTHORITY_LOOKUP_FAIL_CLOSED: {
    mt5Lines: "3698-3716",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The check only ever fires for commands that manage an EXISTING open position, and the guided path has no such command verb. managementAuthorityService.ts:38 restricts arbitration to MANAGEMENT_COMMAND_TYPES = [\"CLOSE_LIVE_POSITION\", \"MODIFY_LIVE_SLTP\"]; :99-101 returns NO_CONTENTION for every other command type, and :102-107 returns NO_CONTENTION when payload.brokerTicket is absent — so even inside MT5, an entry com…",
  },
  COMPLIANCE_ELIGIBILITY_DISPATCH_CONSULT: {
    mt5Lines: "3758-3784",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The risk this check guards — a user without a compliance review (no broker_eligibility row, READ_ONLY posture, unknown outside-client-funds provenance) dispatching LIVE real-money orders — cannot arise on the guided path, because a real-money send is structurally impossible there. Verified in the check itself: complianceDispatchInput.ts:50 scopes the consult to LIVE_DISPATCH_VENUE = \"MT5\", and the refusal surfaces i…",
  },
  FOUNDATION_GATES_19_23_INPUTS: {
    mt5Lines: "3719-3756",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/lib/domain/src/safety-contracts/approvalTicket.ts:217-239 (tenant/actor walls) + tradingConstitution.ts:247,263-296 (per-user caps) + artifacts/api-server/src/…",
    reason: "Split verdict, aggregated as EQUIVALENT because every sub-risk that CAN arise on guided has an executed guided wall of equal force, and the three that have none cannot arise. First, an adversarial correction to the repo's own parity map: DERIV_DEMO_GATE_PARITY declares #19-#23 EQUIVALENT via 'the shared livePhaseBDispatchGate evaluator... every venue runs them' (derivDemoGateParity.ts:196-252) — that is FALSE for th…",
  },
  PHASE_B_GATE_EVALUATOR_BLOCKED: {
    mt5Lines: "3786-3844,3868-3890",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:168-350 (the ordered wall sequence) + guidedDispatchEntry.ts:205-223,790-835 + lib/domain/src/saf…",
    reason: "Every input class of the 23-gate umbrella either has an executed guided wall of equal-or-greater force, or guards MT5/EA/bridge mechanics that structurally cannot exist on a server-side Deriv API path. Mapping by input, executed code only: (a) liveBrokerExecutionEnabled (default false) → the server-authoritative execution tier: default TIER_0 dry-run, exact-literal whitelist, env read server-side only (executionTier…",
  },
  SHARED_MASTER_MAPPING_CHECK: {
    mt5Lines: "3892-3929",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The check guards exactly one hazard: in SHARED_MASTER_MT5 routing, many users' commands hit ONE shared master account, so exposure must be atomically reserved against a mapped shared_master_accounts row before SENT — with no mapping, reservation is impossible and dispatch fails closed MASTER_ACCOUNT_NOT_MAPPED (liveCommandPipeline.ts:3899-3928; the R3 comment at 3930-3934 confirms the race it closes: two parallel di…",
  },
  MASTER_EXPOSURE_RESERVATION_ATOMIC: {
    mt5Lines: "3892-3988",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:573-591,619-630 (per-user pg try-advisory-xact-lock held across the whole dispatch) + guidedExecutionService.ts:227-245 with lib/domain/src/safety-contracts/tradingConstitution.ts:263-296 (exposure/po…",
    reason: "The risk this wall guards — a TOCTOU where two parallel dispatches both read pre-commit exposure state and both pass a cap check — CAN arise on the guided path, and it is guarded by an equivalent-but-differently-shaped mechanism: instead of an advisory-locked reservation row, guided holds a pg try-advisory-xact-lock keyed by userId (ARX_LOCK_NS.GUIDED_DISPATCH) across the ENTIRE dispatch including the venue round-tr…",
  },
  PHASE_B_FOUNDATION_GATES_BLOCKED: {
    mt5Lines: "3868-3890",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:790-835 (probation, gate-parity totality, disclosure — all pre-claim) + guidedExecutionService.ts:168-299 (cert lapse, unresolved intent, constitution, version pin, authorizeDispatch, CAS, venue routi…",
    reason: "The protection — a total pre-dispatch gate battery whose BLOCKED verdict refuses before any reservation or send — exists on guided as an ordered sequence of executed refusal walls, each returning a definite refusal pre-send, plus the B4-fix totality wall: derivDemoParityVerdict() actually runs assertVenueGateParity at dispatch (guidedDispatchEntry.ts:816-823; venueGateParity.ts:141-181 fails closed on any unmapped g…",
  },
  SHARED_MASTER_MAPPING_REQUIRED: {
    mt5Lines: "3899-3929",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The risk this check guards — a command routed under SHARED_MASTER_MT5 dispatching against a bridge that has no shared_master_accounts mapping row, i.e. sending to a shared master with no exposure-accounting anchor — cannot arise on the guided path, because no guided dispatch can ever be routed to a shared master MT5 account or any MT5 venue at all. Proof from executed code: (1) the only venue value the guided path c…",
  },
  USER_ALLOCATION_HEADROOM_RESERVATION: {
    mt5Lines: "3930-3987",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "artifacts/api-server/src/lib/phase6/guidedDispatchEntry.ts:619-630 (non-blocking per-user pg advisory xact lock, direct analog of USER_ALLOCATION_LOCKED) + guidedExecutionService.ts:227-245 with tradingConstitution.ts:263-296 (per-user budget ceilings re-deri…",
    reason: "The risk — a user committing more than their per-user budget, in particular via two concurrent same-user dispatches both passing an unlocked headroom read — CAN arise on guided and is guarded by directly analogous executed machinery. Lock leg: serializeGuidedDispatch takes a NON-BLOCKING pg try-advisory-xact-lock keyed by userId and refuses the loser honestly ('another guided dispatch for this user is in progress'),…",
  },
  MASTER_EXPOSURE_ATOMIC_RESERVATION: {
    mt5Lines: "3945-3990",
    disposition: "NOT_APPLICABLE",
    guidedEnforcedBy: null,
    reason: "The specific risk this leg guards — the aggregate LOT exposure of a shared, real-money master MT5 account breaching its cap because two parallel submissions (possibly from different users) both passed the cap check, leading to margin over-commitment of pooled capital — cannot arise on the guided Deriv demo path, on four independently-executed grounds. (1) No shared account: the only connection loadConnection can ret…",
  },
  DOUBLE_SEND_STATUS_CAS: {
    mt5Lines: "4008-4070",
    disposition: "STRICTER",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:267-288 (claim invocation and both refusal paths); CAS implementation /private/tmp/claude-501/-Us…",
    reason: "The guided path enforces the identical at-most-one-dispatch protection with the same atomic UPDATE-with-status-predicate idiom, and its claim predicate is strictly narrower than MT5's. MT5's CAS matches on commandId AND status='LIVE_APPROVED' (liveCommandCas.ts:78-82). Guided's claimTicketForDispatch matches on ticketId AND userId AND state='APPROVED' AND dispatch_claimed_at IS NULL AND expiresAt > now() using the d…",
  },
  EXECUTION_VENUE_ROUTING: {
    mt5Lines: "4130",
    disposition: "EQUIVALENT",
    guidedEnforcedBy: "/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-fresh/artifacts/api-server/src/lib/phase6/guidedExecutionService.ts:290-298 (routeExecutionVenue on the server-derived venue, audit GUIDED_DISPATCH_UNROUTABLE, refus…",
    reason: "Both paths run the SAME shared router — routeExecutionVenue in lib/domain/src/safety-contracts/executionVenue.ts:47-64, total, pure, exact-match-only, refusing null/undefined (VENUE_ABSENT), non-string (VENUE_MALFORMED), empty (VENUE_ABSENT) and unrecognised values (VENUE_UNRECOGNISED) with no default — on a server-persisted venue, and both terminate dispatch fail-closed after the claim but before any deliver() call…",
  },
};

export const GUIDED_MT5_PARITY_CHECK_COUNT = 40;

/**
 * Runtime totality/honesty check, same spirit as assertVenueGateParity:
 * every entry needs an informative reason, and enforcement claims need an
 * enforcer. Fails CLOSED — callers must treat a not-ok verdict as "the parity
 * record is broken", not as licence to guess.
 */
export function assertGuidedMt5Parity(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const [name, e] of Object.entries(GUIDED_MT5_PIPELINE_PARITY)) {
    if (!e.reason || e.reason.trim().length < 30) {
      problems.push(`${name}: reason carries no information`);
    }
    if ((e.disposition === "EQUIVALENT" || e.disposition === "STRICTER" || e.disposition === "WEAKER")
        && (!e.guidedEnforcedBy || e.guidedEnforcedBy.trim() === "")) {
      problems.push(`${name}: claims guided enforcement but names no enforcer`);
    }
  }
  return { ok: problems.length === 0, problems };
}
