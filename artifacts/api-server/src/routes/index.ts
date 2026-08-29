import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appDoctorRouter from "./appDoctor";
import botRouter from "./bot";
import signalsRouter from "./signals";
import tradesRouter from "./trades";
import riskRouter from "./risk";
import strategiesRouter from "./strategies";
import performanceRouter from "./performance";
import backtestsRouter from "./backtests";
import mt5Router from "./mt5";
import learningRouter from "./learning";
import dataRouter from "./data";
import chartRouter from "./chart";
import meChartIntelligenceRouter from "./meChartIntelligence";
import meMarketTruthRouter from "./meMarketTruth";
import meChartSmartLayersRouter from "./meChartSmartLayers";
import { meChartBrainRouter } from "./meChartBrain";
import tradeManagementRouter from "./tradeManagement";
import newsRouter from "./news";
import alertsRouter from "./alerts";
import watchlistsRouter from "./watchlists";
import portfolioRouter from "./portfolio";
import journalRouter from "./journal";
import intelligenceRouter from "./intelligence";
import brainRouter from "./brain";
import systemRouter from "./system";
import auditRouter from "./audit";
import agentsRouter from "./agents";
import executionRouter from "./execution";
import executionIntelRouter from "./executionIntelligence";
import traderDNARouter from "./traderDNA";
import cognitiveRouter from "./cognitive";
import personalEdgeRouter from "./personalEdge";
import temporalIntelligenceRouter from "./temporalIntelligence";
import replayLabRouter from "./replayLab";
import replayLabSimRouter from "./replayLabSim";
import validationPipelineRouter from "./validationPipeline";
import validationCommandCenterRouter from "./validationCommandCenter";
import adversarialValidationRouter from "./adversarialValidation";
import continuousValidationRouter from "./continuousValidation";
import decisionIntelligenceRouter from "./decisionIntelligence";
import economyRouter from "./economy";
import ecosystemRouter from "./ecosystem";
import permissionRouter from "./permission";
import executionConfirmationsRouter from "./executionConfirmations";
import brokerHealthRouter from "./brokerHealth";
import livePositionsRouter from "./livePositions";
import journalEntriesRouter from "./journalEntries";
import weeklyReviewsRouter from "./weeklyReviews";
import tradePlansRouter from "./tradePlans";
import multiTimeframeRouter from "./multiTimeframe";
import newsCalendarRouter from "./newsCalendar";
import portfolioRiskRouter from "./portfolioRisk";
import backtestRunsRouter from "./backtestRuns";
import paperTradingRouter from "./paperTrading";
import paperIntelligenceRouter from "./paperIntelligence";
import demoExecutionRouter from "./demoExecution";
import meDemoExecutionReadinessRouter from "./meDemoExecutionReadiness";
import meDemoExecutionRouter from "./meDemoExecution";
import meDemoCommandsRouter from "./meDemoCommands";
import meDemoBridgeDebugRouter from "./meDemoBridgeDebug";
import meDemoPositionsRouter from "./meDemoPositions";
import meApprovalInboxRouter from "./meApprovalInbox";
import meGuidedPositionsRouter from "./meGuidedPositions";
import meLiveRouter from "./meLive";
import meLiveAccountRouter from "./meLiveAccount";
import liveTestCycleRouter from "./liveTestCycle";
import adminLiveAccountRouter from "./adminLiveAccount";
import adminAllocationsRouter from "./adminAllocations";
import meAllocationRouter from "./meAllocation";
import meInvestorRouter from "./meInvestor";
import adminInvestorsRouter from "./adminInvestors";
import { meFundBookRouter } from "./meFundBook";
import { adminFundBookRouter } from "./adminFundBook";
import { adminWaterfallRouter } from "./adminWaterfall";
import { meCapitalRouter } from "./meCapital";
import { adminCapitalRouter } from "./adminCapital";
import { meFundControlsRouter } from "./meFundControls";
import { adminFundControlsRouter } from "./adminFundControls";
import tradesLiveSharedRouter from "./tradesLiveShared";
import mePositionsUnifiedRouter from "./mePositionsUnified";
import meTradeHealthRouter from "./meTradeHealth";
import mt5DemoBridgeRouter from "./mt5DemoBridge";
import mt5LiveRouter from "./mt5Live";
import bridgeV2Router from "./bridgeV2";
import meBridgeV2Router from "./meBridgeV2";
import mt5RemoteOpsRouter from "./mt5RemoteOps";
import adminEaUpdatesRouter from "./adminEaUpdates";
import adminEaHealthRouter from "./adminEaHealth";
import adminRuntimeHealthRouter from "./adminRuntimeHealth";
import propChallengesRouter from "./propChallenges";
import ruleContractsRouter from "./ruleContracts";
import tradingReadinessRouter from "./tradingReadiness";
import postTradeDebriefsRouter from "./postTradeDebriefs";
import tradingPlaybooksRouter from "./tradingPlaybooks";
import edgeDiscoveryRouter from "./edgeDiscovery";
import traderSkillRouter from "./traderSkill";
import aiMentorRouter from "./aiMentor";
import analyticsCommandRouter from "./analytics";
import { meRubyQualityRouter } from "./meRubyQuality";
import { adminRubyQualityRouter } from "./adminRubyQuality";
import { adminIntelligenceRouter } from "./adminIntelligence";
import { adminRubyExecutionRouter } from "./adminRubyExecution";
import adminAiFixAgentRouter from "./adminAiFixAgent.js";
import tradeDecisionRouter from "./tradeDecision";
import autoDebriefRouter from "./autoDebrief";
import paperExecutionRouter from "./paperExecution";
import paperAutopilotRouter from "./paperAutopilot";
import performanceCommandCenterRouter from "./performanceCommandCenter";
import riskGovernorRouter from "./riskGovernor";
import traderCoachRouter from "./traderCoach";
import replayRouter from "./replay";
import strategyLabRouter from "./strategyLab";
import dataImportRouter from "./dataImport";
import brokerReadOnlyRouter from "./brokerReadOnly";
import notificationsRouter from "./notifications";
import systemHealthRouter from "./systemHealth";
import securityRouter from "./security";
import readinessRouter from "./readiness";
import integrationTestsRouter from "./integrationTests";
import paperSessionsRouter from "./paperSessions";
import tradingCockpitRouter from "./tradingCockpit";
import onboardingRouter from "./onboarding";
import helpRouter from "./help";
import featureAnnouncementsRouter from "./featureAnnouncements";
import brokerRouter from "./broker";
import liveTradingRouter from "./liveTrading";
import tradingSessionsRouter from "./tradingSessions";
import meMt5ConnectionsRouter from "./meMt5Connections";
import meMt5CommandsRouter from "./meMt5Commands";
import meMt5SymbolsRouter from "./meMt5Symbols";
import meBrokerHubRouter from "./meBrokerHub";
import mePaperTradesRouter from "./mePaperTrades";
import meFirstRunReadinessRouter from "./meFirstRunReadiness";
import mePaperBetaReadinessRouter from "./mePaperBetaReadiness";
import meTradeJournalRouter from "./meTradeJournal";
import mePerformanceCalendarRouter from "./mePerformanceCalendar";
import meAiReviewsRouter from "./meAiReviews";
import mePlaybooksRouter from "./mePlaybooks";
import profitMissionsRouter from "./profitMissions";
import setupsAndCoachRouter from "./setupsAndCoach";
import meRiskGovernorRouter from "./meRiskGovernor";
import meDashboardRouter from "./meDashboard";
import meAlertsRouter from "./meAlerts";
import meNotificationsRouter from "./meNotifications";
import meViewModeRouter from "./meViewMode";
import meActivityRouter from "./meActivity";
import meReportsRouter from "./meReports";
import { meAssistantRouter } from "./meAssistant";
import meScalpRouter from "./meScalp";
import adminTradingRouter from "./adminTrading";
import adminAuditCenterRouter from "./adminAuditCenter";
import adminLaunchReadinessRouter from "./adminLaunchReadiness";
import adminReconciliationCenterRouter from "./adminReconciliationCenter.js";
import adminBridgeControlRouter from "./adminBridgeControl.js";
import adminLiveTestReadinessRouter from "./adminLiveTestReadiness.js";
import adminOperatorCommandCenterRouter from "./adminOperatorCommandCenter.js";
import meTradingModeRouter from "./meTradingMode";
import tradePlacementRouter from "./tradePlacement";
import meTradesRouter from "./meTrades";
import meTradeIntelligenceRouter from "./meTradeIntelligence";
import meMarketContextRouter from "./meMarketContext";
import meTradeDecisionsRouter from "./meTradeDecisions";
import meTradeActionsRouter from "./meTradeActions";
import pendingOrderDraftRouter from "./pendingOrderDraft";
import meTradeCoachRouter from "./meTradeCoach";
import meProtectiveAutoCloseRouter from "./meProtectiveAutoClose";
import meMarketDataRouter from "./meMarketData";
import historicalAnalysisRouter from "./historicalAnalysis";
import newsIntelligenceRouter from "./newsIntelligence";
import { attachSecurityContext } from "../lib/security/middleware";
import { requireAuthOrPublic } from "../lib/auth/globalGate";
import { enforceProductRoleAccess, denyTraderInvestorArea } from "../lib/auth/productRole";

const router: IRouter = Router();

// PHASE-1 SAFETY NET: deny-by-default per-user auth gate. 401s any /api/*
// request from a logged-out caller unless the path is on the public
// allowlist (health, /auth/*, MT5 bridge endpoints, version/release).
// See lib/auth/globalGate.ts for the full allowlist + rationale.
router.use(requireAuthOrPublic);

// PRODUCT-ROLE GATE: central single-active-role enforcement. Runs right after
// the auth gate so it sees a populated req.authUser. Admin namespaces require
// an ADMIN/OWNER product role; INVESTOR accounts are view-only (every mutation
// refused). Comprehensive, fail-closed companion to the per-router
// denyInvestorExecution guards. Adds no trading-gate logic.
router.use(enforceProductRoleAccess);

router.use(healthRouter);
router.use(appDoctorRouter);
router.use(botRouter);
router.use(signalsRouter);
router.use(tradesRouter);
router.use(riskRouter);
router.use(strategiesRouter);
router.use(performanceRouter);
router.use(backtestsRouter);
router.use(mt5Router);
router.use(mt5DemoBridgeRouter);
router.use(mt5LiveRouter);
// Task #371 — ARX Bridge v2 broker-truth EVENT ingest + admin trace.
router.use(bridgeV2Router);
router.use(meBridgeV2Router);
router.use(mt5RemoteOpsRouter);
router.use(adminEaUpdatesRouter);
router.use(adminEaHealthRouter);
router.use(adminRuntimeHealthRouter);
router.use(tradingSessionsRouter);
router.use(meMt5ConnectionsRouter);
router.use(meMt5CommandsRouter);
router.use(meMt5SymbolsRouter);
router.use(meBrokerHubRouter);
router.use(mePaperTradesRouter);
router.use(meFirstRunReadinessRouter);
router.use(mePaperBetaReadinessRouter);
router.use(meTradeJournalRouter);
router.use(mePerformanceCalendarRouter);
router.use(meAiReviewsRouter);
router.use(mePlaybooksRouter);
router.use(profitMissionsRouter);
router.use(setupsAndCoachRouter);
router.use(meRiskGovernorRouter);
router.use(meMarketDataRouter);
router.use(historicalAnalysisRouter);
router.use(newsIntelligenceRouter);
router.use(meDashboardRouter);
router.use(meAlertsRouter);
router.use(meNotificationsRouter);
router.use(meViewModeRouter);
router.use(meActivityRouter);
router.use(meReportsRouter);
router.use(meAssistantRouter);
router.use(meScalpRouter);
router.use(adminTradingRouter);
router.use(adminAuditCenterRouter);
router.use(adminLaunchReadinessRouter);
router.use(adminReconciliationCenterRouter);
router.use(adminBridgeControlRouter);
router.use(adminLiveTestReadinessRouter);
router.use(adminOperatorCommandCenterRouter);
router.use(meTradingModeRouter);
router.use(tradePlacementRouter);
router.use(meTradesRouter);
router.use(meTradeIntelligenceRouter);
router.use(meMarketContextRouter);
router.use(meTradeDecisionsRouter);
router.use(meTradeActionsRouter);
router.use(pendingOrderDraftRouter);
router.use(meTradeCoachRouter);
router.use(meProtectiveAutoCloseRouter);
router.use(brokerHealthRouter);
router.use(brokerRouter);
router.use(livePositionsRouter);
router.use(journalEntriesRouter);
router.use(weeklyReviewsRouter);
router.use(tradePlansRouter);
router.use(learningRouter);
router.use(dataRouter);
router.use(chartRouter);
router.use(meChartIntelligenceRouter);
router.use(meMarketTruthRouter);
router.use(meChartSmartLayersRouter);
router.use(meChartBrainRouter);
router.use(tradeManagementRouter);
router.use(newsRouter);
router.use(alertsRouter);
router.use(watchlistsRouter);
router.use(portfolioRouter);
router.use(journalRouter);
router.use(intelligenceRouter);
router.use(brainRouter);
router.use(systemRouter);
router.use(auditRouter);
router.use(agentsRouter);
router.use(executionRouter);
router.use(executionIntelRouter);
router.use(traderDNARouter);
router.use(cognitiveRouter);
router.use(personalEdgeRouter);
router.use(temporalIntelligenceRouter);
router.use(replayLabRouter);
router.use(replayLabSimRouter);
router.use(validationPipelineRouter);
router.use(validationCommandCenterRouter);
router.use(adversarialValidationRouter);
router.use(continuousValidationRouter);
router.use(decisionIntelligenceRouter);
router.use(economyRouter);
router.use(ecosystemRouter);
router.use(permissionRouter);
router.use(executionConfirmationsRouter);
router.use(multiTimeframeRouter);
router.use(newsCalendarRouter);
router.use(portfolioRiskRouter);
router.use(backtestRunsRouter);
router.use(paperTradingRouter);
router.use("/paper", paperIntelligenceRouter);
router.use("/paper/demo-execution", demoExecutionRouter);
router.use(meDemoExecutionReadinessRouter);
router.use(meDemoExecutionRouter);
router.use(meDemoCommandsRouter);
router.use(meDemoBridgeDebugRouter);
router.use(meDemoPositionsRouter);
// Phase 6 — the Approval Inbox. Per-user only; no admin override.
router.use(meApprovalInboxRouter);
// Phase 6 — guided position centre, journal and debrief. Owner-scoped reads.
router.use(meGuidedPositionsRouter);
router.use(meLiveRouter);
router.use(meLiveAccountRouter);
router.use(liveTestCycleRouter);
router.use(adminLiveAccountRouter);
router.use(adminAllocationsRouter);
router.use(meAllocationRouter);
// Traders (plain USER) have no access to the investor portal. Path-scoped so it
// only runs for `/me/investor/*` (never router-wide); INVESTOR + ADMIN/OWNER and
// preview-as-investor pass through. Per-user scoping already blocks cross-tenant
// reads — this enforces the product rule that the portal is investor-only.
router.use("/me/investor", denyTraderInvestorArea);
router.use(meInvestorRouter);
router.use(meFundBookRouter);
router.use(meCapitalRouter);
router.use(meFundControlsRouter);
router.use(adminInvestorsRouter);
router.use(adminFundBookRouter);
router.use(adminWaterfallRouter);
router.use(adminCapitalRouter);
router.use(adminFundControlsRouter);
router.use(tradesLiveSharedRouter);
router.use(mePositionsUnifiedRouter);
router.use(meTradeHealthRouter);
router.use(propChallengesRouter);
router.use(ruleContractsRouter);
router.use(tradingReadinessRouter);
router.use(postTradeDebriefsRouter);
router.use(tradingPlaybooksRouter);
router.use(edgeDiscoveryRouter);
router.use(traderSkillRouter);
router.use(aiMentorRouter);
router.use(analyticsCommandRouter);
router.use(meRubyQualityRouter);
router.use(adminRubyQualityRouter);
router.use(adminIntelligenceRouter);
router.use(adminRubyExecutionRouter);
router.use(adminAiFixAgentRouter);
router.use(tradeDecisionRouter);
router.use(autoDebriefRouter);
router.use(paperExecutionRouter);
router.use(paperAutopilotRouter);
router.use(performanceCommandCenterRouter);
router.use(riskGovernorRouter);
router.use(traderCoachRouter);
router.use(replayRouter);
router.use(strategyLabRouter);
router.use(dataImportRouter);
router.use(brokerReadOnlyRouter);
router.use(notificationsRouter);
router.use(systemHealthRouter);
router.use(attachSecurityContext);
router.use(securityRouter);
router.use(readinessRouter);
router.use(integrationTestsRouter);
router.use(paperSessionsRouter);
router.use(tradingCockpitRouter);
router.use(onboardingRouter);
router.use(helpRouter);
router.use(featureAnnouncementsRouter);
router.use(liveTradingRouter);

// Build TT — Live Intent Queue (FULL TESTER ACCESS, MT5-deferred).
import liveIntentRouter from "./liveIntent.js";
router.use(liveIntentRouter);

// Build TT — Simulated Market Engine + tester demo-data.
import marketRouter from "./market.js";
import testerDataRouter from "./testerData.js";
router.use(marketRouter);
router.use(testerDataRouter);

// AI Strategy Brain — analysis, trade cards, sniper score, grader, replay,
// scorecard, coach summary. Simulator only.
import aiBrainRouter from "./aiBrain.js";
router.use(aiBrainRouter);

// Market Scanner + Opportunity Scoring + Session Plan + Decision Stream + Alerts.
import scannerRouter from "./scanner.js";
router.use(scannerRouter);

// Real-time Market Data Layer: quotes/candles envelopes, session clock,
// news risk, spread/vol monitors, market health, data quality, risk governor.
import marketDataLayerRouter from "./marketDataLayer.js";
router.use(marketDataLayerRouter);

// Order Management System + Position Manager + Simulated Execution + P/L engine.
import omsRouter from "./oms.js";
router.use(omsRouter);

// AI Autopilot Orchestrator + Human Control Layer.
import autopilotRouter from "./autopilot.js";
router.use(autopilotRouter);

// Risk Governor 2.0 + Account Protection.
import riskGov2Router from "./riskGovernor2.js";
router.use(riskGov2Router);

// Shadow Mode + Forward Testing + Strategy Tournament + Promotion Gates.
import shadowModeRouter from "./shadowMode.js";
router.use(shadowModeRouter);

// Full System Stabilization aggregator.

// Owner / Tester auth + session.
import authRouter from "./auth.js";
router.use(authRouter);

// Backup / export endpoints.
import exportsRouter from "./exports.js";
router.use(exportsRouter);

// Build UU — Beta release: version, readiness gates, feedback, diagnostics.
import releaseRouter from "./release.js";
router.use(releaseRouter);

// Build WW — Daily Owner Testing Mode: sessions, steps, ratings, weekly
// summary, readiness trend, exports. Simulator + tester intents only.
import dailyTestingRouter from "./dailyTesting.js";
router.use(dailyTestingRouter);

// Per-user Trading Readiness (14-status engine).
import userReadinessRouter from "./userReadiness.js";
router.use(userReadinessRouter);

// Opportunity Radar / AI Scanner Brain (read-only ranking + watchlist prefs).
import opportunityRadarRouter from "./opportunityRadar.js";
router.use(opportunityRadarRouter);

// P0-1 — Per-user Shared Account read API (/api/me/shared-account/*).
import meSharedAccountRouter from "./meSharedAccount.js";
router.use(meSharedAccountRouter);

import meAccountShellRouter from "./meAccountShell.js";
router.use(meAccountShellRouter);
import meUnifiedModeRouter from "./meUnifiedMode.js";
router.use(meUnifiedModeRouter);

// P0-1 + P0-3 — Admin Shared Master API namespace (/api/admin/shared-master/*).
// Additive to existing /api/admin/trading/* in adminTrading.ts.
import adminSharedMasterRouter from "./adminSharedMaster.js";
router.use(adminSharedMasterRouter);
import adminMasterBridgeRouter from "./adminMasterBridge.js";
router.use(adminMasterBridgeRouter);
import meMasterBridgeRouter from "./meMasterBridge.js";
router.use(meMasterBridgeRouter);
import adminMasterLiveAccessRouter from "./adminMasterLiveAccess.js";
router.use(adminMasterLiveAccessRouter);
import adminCockpitRouter from "./adminCockpit.js";
router.use(adminCockpitRouter);
import adminUserControlRouter from "./adminUserControl.js";
router.use(adminUserControlRouter);
import adminRiskTemplatesRouter from "./adminRiskTemplates.js";
router.use(adminRiskTemplatesRouter);
import meMasterLiveAccessRouter from "./meMasterLiveAccess.js";
router.use(meMasterLiveAccessRouter);
import meReadinessSummaryRouter from "./meReadinessSummary.js";
router.use(meReadinessSummaryRouter);
import meLiveReadinessRouter from "./meLiveReadiness.js";
router.use(meLiveReadinessRouter);
import adminLiveGatesDiagnosticRouter from "./adminLiveGatesDiagnostic.js";
router.use(adminLiveGatesDiagnosticRouter);

import adminHandshakeMonitorRouter from "./adminHandshakeMonitor.js";
router.use(adminHandshakeMonitorRouter);
import adminLiveSharedReadinessRouter from "./adminLiveSharedReadiness.js";
router.use(adminLiveSharedReadinessRouter);
import adminEngineDriversRouter from "./adminEngineDrivers.js";
router.use(adminEngineDriversRouter);
import adminLiveSharedActivationRouter from "./adminLiveSharedActivation.js";
router.use(adminLiveSharedActivationRouter);
import adminLiveFirstTestModeRouter from "./adminLiveFirstTestMode.js";
router.use(adminLiveFirstTestModeRouter);
import adminRiskProfileRouter from "./adminRiskProfile.js";
router.use(adminRiskProfileRouter);
import meLiveProfileRouter from "./meLiveProfile.js";
router.use(meLiveProfileRouter);
import meOneClickRouter from "./meOneClick.js";
router.use(meOneClickRouter);
import instantTradeRouter from "./instantTrade.js";
router.use(instantTradeRouter);
import adminPerformanceRouter from "./adminPerformance.js";
router.use(adminPerformanceRouter);

// Centralized Master MT5 Bridge (Slice 1+2) — per-user routing status.
import meRoutingStatusRouter from "./meRoutingStatus.js";
router.use(meRoutingStatusRouter);
import meBridgePreferenceRouter from "./meBridgePreference.js";
router.use(meBridgePreferenceRouter);

// ── Private Beta 10 cohort ───────────────────────────────────────────────
import adminBetaControlRouter from "./adminBetaControl.js";
import meBetaStatusRouter from "./meBetaStatus.js";
router.use(adminBetaControlRouter);
router.use(meBetaStatusRouter);

import adminDerivStatusRouter from "./adminDerivStatus.js";
router.use(adminDerivStatusRouter);

import marketDataDerivRouter from "./marketDataDeriv.js";
router.use(marketDataDerivRouter);
import marketDataTradabilityRouter from "./marketDataTradability.js";
router.use(marketDataTradabilityRouter);

import adminMarketDataDiagnosticsRouter from "./adminMarketDataDiagnostics.js";
router.use(adminMarketDataDiagnosticsRouter);
import adminChartTruthRouter from "./adminChartTruth.js";
router.use(adminChartTruthRouter);
import adminProviderHealthRouter from "./adminProviderHealth.js";
router.use(adminProviderHealthRouter);

import meTradeHistoryRouter from "./meTradeHistory.js";
router.use(meTradeHistoryRouter);

// Restored 2026-05-26 — frontend pages (trading-intelligence, admin/settings)
// were 404'ing against these endpoints after the orphan-cleanup commit a6f0e0b.
// DB tables (mood_check_ins, user_privacy_settings, global_signal_edges,
// tradingview_alerts, webhook_tokens) were preserved and are still present.
import meMoodRouter from "./meMood.js";
router.use(meMoodRouter);
import mePrivacyRouter from "./mePrivacy.js";
router.use(mePrivacyRouter);
import meTradingViewRouter from "./meTradingView.js";
router.use(meTradingViewRouter);
import meTradingSchoolRouter from "./meTradingSchool.js";
router.use(meTradingSchoolRouter);

// Ruby TTS — server-side text-to-speech (ElevenLabs / OpenAI)
import meTTSRouter from "./meTTS.js";
router.use(meTTSRouter);

// Per-user Ruby Voice preferences (backend source of truth)
import meVoiceSettingsRouter from "./meVoiceSettings.js";
router.use(meVoiceSettingsRouter);
import meAssistantSettingsRouter from "./meAssistantSettings.js";
router.use(meAssistantSettingsRouter);
// Per-user self-serve password change (logged-in users)
import meChangePasswordRouter from "./meChangePassword.js";
router.use(meChangePasswordRouter);

// Admin → Ruby Voice Settings (health, diagnostics, test, admin settings)
import adminRubyVoiceRouter from "./adminRubyVoice.js";
router.use(adminRubyVoiceRouter);

// T019 — Admin Risk/Governance read + write (owner_governance_settings)
import adminGovernanceRouter from "./adminGovernance.js";
router.use(adminGovernanceRouter);

// Agent Ecosystem (Layer 1) — read-only admin registry + constitution + seed.
// ADVISORY / SHADOW ONLY — never touches any trade/live/demo path.
import agentEcosystemRouter from "./agentEcosystem.js";
router.use(agentEcosystemRouter);

// Self-Trade AI — Foundation (Task #211). READ surfaces are owner-isolated;
// admin surfaces are ADMIN/OWNER-gated and fail-closed audited. NO execution.
import selfTradeAiRouter from "./selfTradeAi.js";
import adminSelfTradeAiRouter from "./adminSelfTradeAi.js";
router.use(selfTradeAiRouter);
router.use(adminSelfTradeAiRouter);

// Ruby Market Timing Brain (Task #220) — advisory heat/tradeability reads.
// ADVISORY ONLY — never an execution gate; never touches any live/demo path.
import timingBrainRouter from "./timingBrain.js";
router.use(timingBrainRouter);
import { marketHeatRouter } from "./marketHeat.js";
router.use(marketHeatRouter);

// Admin Timing Brain (Task #225) — persisted heat-snapshot history.
// ADMIN/OWNER only; READ-ONLY over heat_snapshots; never an execution gate.
import adminTimingBrainRouter from "./adminTimingBrain.js";
router.use(adminTimingBrainRouter);

// Phase 4 — Heat learning report, replay, and recent snapshots.
// ADVISORY ONLY — never an execution gate; reads heat_snapshots only.
import meHeatRouter from "./meHeat.js";
router.use(meHeatRouter);

// ARX Adaptive Cohesion Intelligence (Task #230) — read-only advisory cohesion
// verdict. ADVISORY ONLY — never an execution gate; per-user isolated; admin
// endpoints expose full diagnostic detail.
import aaciRouter from "./aaci.js";
router.use(aaciRouter);

// AACI Learning, Trust & Drift (Task #232) — admin-only adaptive learning
// surface (per-entity Bayesian trust, drift, recommend-only change approval).
// ADVISORY ONLY — never an execution gate.
import adminAaciLearningRouter from "./adminAaciLearning.js";
router.use(adminAaciLearningRouter);

// AACI Security Phase 5 (Task #241) — admin-only read surfaces: Security Score +
// band, encryption/protection status, and a redacted critical-event timeline.
// READ-ONLY / OBSERVATION ONLY — never an execution gate, never returns secrets.
import adminSecurityRouter from "./adminSecurity.js";
router.use(adminSecurityRouter);

// Task #353 — Bridge-type-aware armed one-click permission controls.
// Admin can grant/revoke shared-bridge one-click permission (auto-disarms user
// on revoke). User arm/disarm endpoints live in meOneClickRouter above.
import adminOneClickRouter from "./adminOneClick.js";
router.use(adminOneClickRouter);

// Learning Model Versions — gate-checked global-learning version registry.
// ADMIN/OWNER approve/rollback; liveAllowed only when all validation gates
// pass AND admin explicitly approves. Includes user-facing version status.
import adminLearningVersionsRouter from "./adminLearningVersions.js";
router.use(adminLearningVersionsRouter);

// Owner Decision Registry (blueprint Phase 0) — append-only rulings ledger.
// ADMIN/OWNER gated inside the router; no update/delete surface exists.
// Multi-broker spec §15 — GET /api/brokers/catalog. Read-only venue catalog:
// implemented venues report real capability, unimplemented ones report an
// explicit NOT_IMPLEMENTED/ONBOARDING_REQUIRED state (§21). No order
// submission exists at Phase 1 for any venue.
import brokerCatalogRouter from "./brokerCatalog.js";
router.use(brokerCatalogRouter);

import adminOwnerDecisionsRouter from "./adminOwnerDecisions.js";
router.use(adminOwnerDecisionsRouter);

// Resilience front (#27 promotion gate owner-press seam + #35 as-of tool).
// ADMIN/OWNER gated inside the router; the only widening handler is the
// evidence-gated, typed-confirmation execution-policy enable press.
import adminResilienceRouter from "./adminResilience.js";
router.use(adminResilienceRouter);
// ── Self-trading polish (build/product-polish) ──────────────────────────────
// #37 — unified owner-grantable authority ledger (scoped, expiring grants).
// Grants only PERMIT later explicit raises through existing gated seams.
import meAuthorityRouter from "./meAuthority.js";
router.use(meAuthorityRouter);
// #42 — delayed risk increases live inside riskRouter (asymmetric PATCH +
// /risk/pending-increases lifecycle); no separate router needed.
// #44 — manual takeover: per-position control state + explicit release.
import mePositionControlRouter from "./mePositionControl.js";
router.use(mePositionControlRouter);
// #45 — origin-class comparative analytics (read-only, honest UNTAGGED bucket).
import meOriginAnalyticsRouter from "./meOriginAnalytics.js";
router.use(meOriginAnalyticsRouter);
// #46 — broker-native escape route (read-only safety surface, never flagged off).
import meEscapeRouteRouter from "./meEscapeRoute.js";
router.use(meEscapeRouteRouter);
// ── INSTITUTIONAL front (capabilities #48–#52) ───────────────────────────────
// Capability #52 — compliance-eligibility review surface (ADMIN/OWNER). The
// owner-press machinery behind the fail-closed eligibility consult inside
// Phase B gate #3; grants no live authority by itself.
import adminComplianceRouter from "./adminCompliance.js";
router.use(adminComplianceRouter);
// Capability #50 — org/legal-entity hierarchy + beneficial-ownership graph +
// consolidated-exposure READ (ADMIN/OWNER). Structure only; no execution.
import adminOrgStructureRouter from "./adminOrgStructure.js";
router.use(adminOrgStructureRouter);
// Capability #51 — lifecycle-role grants (separation of duties). Conflicting
// combinations refused by the pure evaluator; enforcement middleware wired on
// the lifecycle-relevant routes (learning-version approve, risk templates).
import adminLifecycleRolesRouter from "./adminLifecycleRoles.js";
router.use(adminLifecycleRolesRouter);

export default router;
