// Types — single source of truth for the agent-system layered architecture
export * from "./agentSystem.types";
// Phase 3 type facades — re-export agent / sensor / vote types under the
// canonical filenames called out in the Phase 3 spec.
export * from "./agent.types";
export * from "./sensor.types";
export * from "./agentVote.types";

// Phase 3 council pipeline (sensors → agents → red/blue → judge → verdict)
export * from "./debate/redTeam.agent";
export * from "./debate/blueTeam.agent";
export * from "./debate/disagreementScore.engine";
export * from "./debate/disagreementClasses.engine";
export * from "./debate/evidenceDiversity.engine";
export * from "./judge/councilVerdict.engine";
export * from "./runCouncil";

// Phase 3 upgrade — authority, expiration, accountability, conflict
export * from "./authority/agentAuthority.types";
export * from "./authority/authorityRules.engine";
export * from "./expiration/signalExpiration.engine";
export * from "./expiration/voteExpiration.engine";
export * from "./expiration/staleDecisionGuard.engine";
export * from "./accountability/agentPerformance.types";
export * from "./accountability/agentScoring.engine";
export * from "./accountability/confidenceCalibration.engine";
export * from "./accountability/falseApprovalTracker.engine";
export * from "./accountability/falseBlockTracker.engine";
export * from "./conflict/conflictSeverity.engine";
export * from "./conflict/blockerHierarchy.engine";
export * from "./conflict/hardBlockResolver.engine";

// Phase 3 V2 — agent contracts, versioning, safety guards, shadow runner
export * from "./contracts/agentContract.types";
export * from "./contracts/agentOutputValidator.engine";
export * from "./contracts/agentSchemaVersion.engine";
export * from "./safety/evidenceRequirement.engine";
export * from "./safety/hallucinationGuard.engine";
export * from "./safety/confidenceCap.engine";
export * from "./shadow/v1v2DecisionComparison.engine";
export * from "./shadow/agentShadowRunner.engine";
export * from "./shadow/agentDriftDetector.engine";

// Sensors (collect facts only)
export * from "./sensors/marketSensor";
export * from "./sensors/accountSensor";
export * from "./sensors/executionSensor";
export * from "./sensors/behaviorSensor";
export * from "./sensors/newsSensor";

// Agents (analyze one domain only; cannot place trades)
export * from "./agents/risk.agent";
export * from "./agents/execution.agent";
export * from "./agents/news.agent";
export * from "./agents/traderDNA.agent";
export * from "./agents/trend.agent";
export * from "./agents/momentum.agent";
export * from "./agents/liquidity.agent";
export * from "./agents/marketStructure.agent";
export * from "./agents/volatility.agent";
export * from "./agents/session.agent";
export * from "./agents/entryPrecision.agent";
export * from "./agents/historicalMatch.agent";

// Debate (identifies conflicts; proposes resolutions)
export * from "./debate/agentDebate.engine";
export * from "./debate/conflictResolver.engine";

// Judge (proposes the decision)
export * from "./judge/tradeJudge.engine";
export * from "./judge/decisionExplanation.engine";

// Governor (can override; final authority)
export * from "./governor/hardBlockRules.engine";
export * from "./governor/riskGovernor.engine";

// Execution (only after governor approval)
export * from "./execution/orderPreparation.engine";
export * from "./execution/mt5Execution.engine";
export * from "./execution/fillVerification.engine";

// Monitoring (post-entry)
export * from "./monitoring/tradeHealth.engine";
export * from "./monitoring/confidenceDecay.engine";
export * from "./monitoring/exitWarning.engine";
export * from "./monitoring/tradeMonitor.engine";

// Audit (post-close)
export * from "./audit/agentPerformance.engine";
export * from "./audit/selfAudit.engine";
export * from "./audit/regimeMemory.engine";

// Decision Store + top-level runner
export * from "./decisionStore";
export * from "./runAgentSystem";

// Agent Ecosystem (Layer 1) — constitution, truth-lock journal, core seed defs
export * from "./constitution/agentConstitution";
export * from "./journal/truthLock";
export * from "./coreAgents";

// Agent Ecosystem (Layer 2) — review scoring, outcome resolution, promotion
// board lifecycle, learning camp stage machine. All PURE / advisory-only.
export * from "./review/tradeReviewScoring.engine";
export * from "./review/outcomeResolution.engine";
export * from "./promotion/promotionBoard.engine";
export * from "./learning-camp/learningCamp.engine";

// Agent Ecosystem (Phase 0 integration) — advisory influence engine that turns
// earned agent trust + lifecycle health into a BOUNDED, advisory-only score
// adjustment for the real Scanner / Risk / Scalp / Ruby surfaces. PURE.
export * from "./advisory/agentAdvisory.engine";

// Agent Ecosystem (Layer 3) — operational Governance Court, Traffic Controller
// speed protection, and the governed Agent Factory validator. All PURE /
// advisory-only: they coordinate agent positions into a bounded, protective
// outcome that only ever lowers a ranking, never an execution gate.
export * from "./governance/agentCourt.engine";
export * from "./governance/trafficController.engine";
export * from "./governance/agentFactory.engine";

// Agent Ecosystem (Layer 3) — orchestration + ecosystem-health engines. All
// PURE / ADVISORY / SHADOW-ONLY: they coordinate, route, score speed, protect
// ecosystem health, resolve disagreements, govern creation, and roll up the
// family tree. NONE of them gate, slow, or block any live/demo execution path —
// execution always gets priority and new agents are born Shadow Mode at 0%.
export * from "./traffic/trafficController.engine";
export * from "./speed/agentSpeed.engine";
export * from "./immune/agentImmuneSystem.engine";
export * from "./court/agentCourt.engine";
export * from "./court/disagreementBridge";
export * from "./factory/agentFactoryPopulation.engine";
export * from "./family/agentFamilyTree.engine";
