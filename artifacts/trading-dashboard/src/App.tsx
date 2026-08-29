import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setRequestObserver } from "@workspace/api-client-react";
import { observeOrvalRequest } from "@/lib/perf";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout/AppLayout";
import { RouteErrorBoundary } from "@/components/layout/RouteErrorBoundary";
import { SymbolProvider } from "@/lib/symbol-context";
import { OnboardingProvider } from "@/components/onboarding/OnboardingProvider";
import { AssistantNameProvider } from "@/lib/assistant-name";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthGate } from "@/components/auth/AuthGate";
import { useActivityPing } from "@/hooks/useActivityPing";

// Eager: dashboard (home) and not-found
import Dashboard from "@/pages/dashboard";
import NotFound from "@/pages/not-found";
const InvestorPortal = lazy(() => import("@/pages/investor"));
// Code-split: these are not the landing route, so keep them out of the initial bundle.
const BrandKit = lazy(() => import("@/pages/brand-kit"));
const MyMt5Page = lazy(() => import("@/pages/my-mt5"));
const MyPaperTradesPage = lazy(() => import("@/pages/my-paper-trades"));
const TradingIntelligencePage = lazy(() => import("@/pages/trading-intelligence"));
const AdminLearningVersionsPage = lazy(() => import("@/pages/admin/learning-versions"));
const FinalLiveTestPage = lazy(() => import("@/pages/admin/live-test-readiness"));
const DerivHealthPage = lazy(() => import("@/pages/admin/deriv-health"));
const AdminAllocationsPage = lazy(() => import("@/pages/admin/allocations"));
const AdminFundControlCenter = lazy(() => import("@/pages/admin/fund-control-center"));
const AdminInvestorsPage = lazy(() => import("@/pages/admin/investors"));
const AdminProviderHealth = lazy(() => import("@/pages/admin/provider-health"));
const AdminHandshakeMonitor = lazy(() => import("@/pages/admin/handshake-monitor"));
const AdminSystemCohesion = lazy(() => import("@/pages/admin/system-cohesion"));
const AdminRubyVoiceSettings = lazy(() => import("@/pages/admin/ruby-voice-settings"));
const AdminChartBrainBenchmark = lazy(() => import("@/pages/admin/chart-brain-benchmark"));

// Trading School (learning) pages — code-split, reachable from the Performance nav group
const TradingSchoolHome = lazy(() => import("@/features/trading-school/pages/TradingSchoolHome"));
const TradingSchoolProgram = lazy(() => import("@/features/trading-school/pages/TradingSchoolProgram"));
const TradingSchoolLesson = lazy(() => import("@/features/trading-school/pages/TradingSchoolLesson"));
const TradingSchoolGlossary = lazy(() => import("@/features/trading-school/pages/TradingSchoolGlossary"));
const TradingSchoolRiskSimulator = lazy(() => import("@/features/trading-school/pages/TradingSchoolRiskSimulator"));
const TradingSchoolLabs = lazy(() => import("@/features/trading-school/pages/TradingSchoolLabs"));
const TradingSchoolProgress = lazy(() => import("@/features/trading-school/pages/TradingSchoolProgress"));

// Lazy: every other route is code-split for fast initial load
const ActionCenter = lazy(() => import("@/pages/action-center"));
const BotControl = lazy(() => import("@/pages/bot-control"));
const StrategySettings = lazy(() => import("@/pages/strategy-settings"));
const RiskSettings = lazy(() => import("@/pages/risk-settings"));
const TradeLogs = lazy(() => import("@/pages/trade-logs"));
const Backtest = lazy(() => import("@/pages/backtest"));
const TestingLab = lazy(() => import("@/pages/testing-lab"));
// Paper Trading removed as a product feature (Phase 3).
// `paper-trading.tsx` is retained because it currently backs the demo execution
// route (/demo-trading). Component file rename is tracked for Phase 12.
const PaperTrading = lazy(() => import("@/pages/paper-trading"));
const PropChallenge = lazy(() => import("@/pages/prop-challenge"));
const RuleContracts = lazy(() => import("@/pages/rule-contracts"));
const TradingReadiness = lazy(() => import("@/pages/trading-readiness"));
const PostTradeDebriefs = lazy(() => import("@/pages/post-trade-debriefs"));
const Playbook = lazy(() => import("@/pages/playbook"));
const EdgeDiscovery = lazy(() => import("@/pages/edge-discovery"));
const TraderSkill = lazy(() => import("@/pages/trader-skill"));
const AiMentor = lazy(() => import("@/pages/ai-mentor"));
const AnalyticsCommand = lazy(() => import("@/pages/analytics-command"));
const Analytics = lazy(() => import("@/pages/analytics"));
const Emergency = lazy(() => import("@/pages/emergency"));
const Learning = lazy(() => import("@/pages/learning"));
const TradingCalendar = lazy(() => import("@/pages/trading-calendar"));
const AICommandCenter = lazy(() => import("@/pages/ai-command-center"));
const TraderCoach = lazy(() => import("@/pages/trader-coach"));
const ReplaySimulator = lazy(() => import("@/pages/replay-simulator"));
const StrategyLab = lazy(() => import("@/pages/strategy-lab"));
const DataImport = lazy(() => import("@/pages/data-import"));
const BrokerReadOnly = lazy(() => import("@/pages/broker-readonly"));
const EscapeRoutePage = lazy(() => import("@/pages/escape-route"));
const Notifications = lazy(() => import("@/pages/notifications"));
const EconomicCalendar = lazy(() => import("@/pages/economic-calendar"));
const Alerts = lazy(() => import("@/pages/alerts"));
const ActivityTimeline = lazy(() => import("@/pages/activity"));
const Reports = lazy(() => import("@/pages/reports"));
const Watchlists = lazy(() => import("@/pages/watchlists"));
const Portfolio = lazy(() => import("@/pages/portfolio"));
const LiveTrades = lazy(() => import("@/pages/live-trades"));
const ForexCenter = lazy(() => import("@/pages/forex-center"));
const IndicesCenter = lazy(() => import("@/pages/indices-center"));
const StocksCenter = lazy(() => import("@/pages/stocks-center"));
const SyntheticCenter = lazy(() => import("@/pages/synthetic-center"));
const JournalPage = lazy(() => import("@/pages/journal"));
const WeeklyReviewPage = lazy(() => import("@/pages/weekly-review"));
const TradePlanBuilderPage = lazy(() => import("@/pages/trade-plan-builder"));
const AlertPreferencesPage = lazy(() => import("@/pages/alert-preferences"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const BrainAnalysis = lazy(() => import("@/pages/brain-analysis"));
const MT5Bridge = lazy(() => import("@/pages/mt5-bridge"));
const MT5Setup = lazy(() => import("@/pages/mt5-setup"));
const LiveTrading = lazy(() => import("@/pages/live-trading"));
const TestingControlCenter = lazy(() => import("@/pages/testing-control-center"));
const LiveChartPage = lazy(() => import("@/pages/live-chart"));
const LiveManualPage = lazy(() => import("@/pages/live-manual"));
const LiveSharedPage = lazy(() => import("@/pages/live-shared"));
const LiveAiAssistPage = lazy(() => import("@/pages/live-ai-assist"));
const LiveAiAutoTestPage = lazy(() => import("@/pages/live-ai-auto-test"));
const LiveIntentQueuePage = lazy(() => import("@/pages/live-intent-queue"));
const TradeGraderPage = lazy(() => import("@/pages/trade-grader"));
const AiCoachPage = lazy(() => import("@/pages/ai-coach"));
const PerformanceScorecardPage = lazy(() => import("@/pages/performance-scorecard"));
const MarketReplayPage = lazy(() => import("@/pages/market-replay"));
const MarketScannerPage = lazy(() => import("@/pages/market-scanner"));
const TradeCommandRoomPage = lazy(() => import("@/pages/trade-command-room"));
const AlertsCenterPage = lazy(() => import("@/pages/alerts-center"));
const SessionPlanPage = lazy(() => import("@/pages/session-plan"));
const MarketSessionsPage = lazy(() => import("@/pages/market-sessions"));
const NewsRiskPage = lazy(() => import("@/pages/news-risk"));
const MarketHealthPage = lazy(() => import("@/pages/market-health"));
const MarketHeatMapPage = lazy(() => import("@/pages/market-heat-map"));
const DataQualityPage = lazy(() => import("@/pages/data-quality"));
// Build UU — Beta release / tester feedback / diagnostics
const ReleaseStatus = lazy(() => import("@/pages/release-status"));
const ReleaseNotes = lazy(() => import("@/pages/release-notes"));
const FeedbackCenter = lazy(() => import("@/pages/feedback-center"));
const AdminIssues = lazy(() => import("@/pages/admin-issues"));
const AdminDiagnostics = lazy(() => import("@/pages/admin-diagnostics"));
const AssistantKnowledgeGaps = lazy(() => import("@/pages/assistant-knowledge-gaps"));
const AssistantKnowledgeConsole = lazy(() => import("@/pages/assistant-knowledge-console"));
const AssistantManual = lazy(() => import("@/pages/assistant-manual"));
// Build WW — Daily Owner Testing Mode
const OrdersPage = lazy(() => import("@/pages/orders"));
const PositionsPage = lazy(() => import("@/pages/positions"));
const ApprovalInboxPage = lazy(() => import("@/pages/approval-inbox"));
const MyTradesPage = lazy(() => import("@/pages/my-trades"));
const TradeDetailPage = lazy(() => import("@/pages/trade-detail"));
const SniperWatchlistPage = lazy(() => import("@/pages/sniper-watchlist"));
const BrokerReconciliationPage = lazy(() => import("@/pages/broker-reconciliation"));
const AutopilotControlCenter = lazy(() => import("@/pages/autopilot-control-center"));
const RiskCommandCenter = lazy(() => import("@/pages/risk-command-center"));
const ProfitMissions = lazy(() => import("@/pages/profit-missions"));
const RiskEventsPage = lazy(() => import("@/pages/risk-events"));
const PropFirmModePage = lazy(() => import("@/pages/prop-firm-mode"));
// Shadow Mode / Strategy Tournament / Strategy Promotion are Testing Lab tabs
// now (surface consolidation item C) — their old standalone routes redirect.
const ConfidenceCalibrationPage = lazy(() => import("@/pages/confidence-calibration"));
const AiReadinessScorePage = lazy(() => import("@/pages/ai-readiness-score"));
const ShadowJournalPage = lazy(() => import("@/pages/shadow-journal"));
const ScalpJournalPage = lazy(() => import("@/pages/scalp-journal"));
const SystemHealth = lazy(() => import("@/pages/system-health"));
const AdminPermissions = lazy(() => import("@/pages/admin-permissions"));
const AdminTradingControl = lazy(() => import("@/pages/admin/trading-control"));
const AdminMasterBridge = lazy(() => import("@/pages/admin/master-bridge"));
const AdminAuditCenter = lazy(() => import("@/pages/admin/audit-center"));
const AdminLaunchReadiness = lazy(() => import("@/pages/admin/launch-readiness"));
const AdminReconciliationCenter = lazy(() => import("@/pages/admin/reconciliation-center"));
const AdminLiveTestReadiness = lazy(() => import("@/pages/admin/live-test-readiness"));
const AdminLiveShared = lazy(() => import("@/pages/admin/live-shared"));
const AdminLiveSharedActivation = lazy(() => import("@/pages/admin/live-shared-activation"));
const AdminOneClickControls = lazy(() => import("@/pages/admin/one-click-controls"));
const AdminOperatorCommandCenter = lazy(() => import("@/pages/admin/operator-command-center"));
const AdminCockpitPage = lazy(() => import("@/pages/admin/cockpit"));
const AdminBetaControl = lazy(() => import("@/pages/admin/beta-control"));
const AdminBetaReadiness = lazy(() => import("@/pages/admin/beta-readiness"));
const AdminUserControlCenter = lazy(() => import("@/pages/admin/user-control-center"));
const AdminEaHealth = lazy(() => import("@/pages/admin/ea-health"));
const AdminBridgeV2Monitor = lazy(() => import("@/pages/admin/bridge-v2-monitor"));
const AdminEaUpdates = lazy(() => import("@/pages/admin/ea-updates"));
const AdminBridgeDiagnostics = lazy(() => import("@/pages/admin/bridge-diagnostics"));
const AdminAgentEcosystem = lazy(() => import("@/pages/admin/agent-ecosystem"));
const AdminSelfTradeAi = lazy(() => import("@/pages/admin/self-trade-ai"));
const AdminRubyQuality = lazy(() => import("@/pages/admin/ruby-quality"));
const AdminAiFixAgent = lazy(() => import("@/pages/admin/ai-fix-agent"));
const AdminTimingBrainSnapshots = lazy(() => import("@/pages/admin/timing-brain-snapshots"));
const AdminDataManagement = lazy(() => import("@/pages/admin-data-management"));
const AdminSecurityStatus = lazy(() => import("@/pages/admin-security-status"));
const AdminControl = lazy(() => import("@/pages/admin-control"));
const AdminHub = lazy(() => import("@/pages/admin/admin-hub"));
const AuditLog = lazy(() => import("@/pages/audit-log"));
const SecurityCenter = lazy(() => import("@/pages/security-center"));
const RolesPermissions = lazy(() => import("@/pages/roles-permissions"));
const SecurityEvents = lazy(() => import("@/pages/security-events"));
const DataProtection = lazy(() => import("@/pages/data-protection"));
const ReadinessChecklist = lazy(() => import("@/pages/readiness-checklist"));
// TradingCockpit lazy import removed (Phase 3 — paper-only legacy page unmounted).
// PaperTestingLaunch lazy import removed (Phase 3 — route unmounted).
const Onboarding = lazy(() => import("@/pages/onboarding"));
const HelpCenter = lazy(() => import("@/pages/help-center"));
// ActivePaperSession lazy import removed (Phase 3 — route unmounted).
const LiveTradingControl = lazy(() => import("@/pages/live-trading-control"));
const SessionReport = lazy(() => import("@/pages/session-report"));
const StatusCommandCenter = lazy(() => import("@/pages/status-command-center"));
const ProtectiveAutoClose = lazy(() => import("@/pages/protective-auto-close"));
const MyAccount = lazy(() => import("@/pages/my-account"));

// Performance baseline:
//   - retry:1                          → fail fast on 401/5xx instead of 3x
//   - refetchOnWindowFocus:false       → no thundering herd when user tabs back
//   - refetchOnReconnect:"always"      → still resync after a real disconnect
//   - refetchIntervalInBackground:false→ ALL polling pauses when tab is hidden
//     This is the single biggest win — eliminates background CPU/network for
//     the ~30 components that set their own refetchInterval (3-30s).
//   - staleTime:30s default            → eliminates redundant refetches on
//     mount when the same query was just read elsewhere; components that
//     need fresher data still override per-query.
//   - gcTime:5min                      → unmounted query data lingers long
//     enough to give cached SSR-style instant re-render on route switches.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: "always",
      refetchIntervalInBackground: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

function PageFallback() {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function ActivityPingMount() {
  // Phase 24 — Mounted once inside AuthGate. Tracks presence; defaults to
  // UNKNOWN; backend treats UNKNOWN as a hard block for auto-close execution.
  useActivityPing();
  return null;
}

function PerfObserverMount() {
  // PART B — wire the central Orval/customFetch mutator into the perf
  // ring buffer so every generated React Query hook is timed for free.
  // Cleared on unmount so HMR cycles don't stack observers.
  useEffect(() => {
    setRequestObserver(observeOrvalRequest);
    return () => setRequestObserver(null);
  }, []);
  return null;
}

function Router() {
  return (
    <AppLayout>
      <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/investor" component={InvestorPortal} />
          {/* /scanner kept as a redirect for old URLs / bookmarks — the
              tabbed Market Scanner at /market-scanner is the single
              active scanner page. Refactor target per UI cleanup brief. */}
          <Route path="/scanner">{() => { window.location.replace(`${import.meta.env.BASE_URL || "/"}market-scanner`); return null; }}</Route>
          <Route path="/school/program" component={TradingSchoolProgram} />
          <Route path="/school/lesson/:id" component={TradingSchoolLesson} />
          <Route path="/school/glossary" component={TradingSchoolGlossary} />
          <Route path="/school/risk-simulator" component={TradingSchoolRiskSimulator} />
          <Route path="/school/labs" component={TradingSchoolLabs} />
          <Route path="/school/progress" component={TradingSchoolProgress} />
          <Route path="/school" component={TradingSchoolHome} />
          <Route path="/live-trading" component={LiveTrading} />
          <Route path="/action-center" component={ActionCenter} />
          <Route path="/bot-control" component={BotControl} />
          <Route path="/strategy-settings" component={StrategySettings} />
          <Route path="/risk-settings" component={RiskSettings} />
          <Route path="/trade-logs" component={TradeLogs} />
          <Route path="/backtest" component={Backtest} />
          <Route path="/testing-lab" component={TestingLab} />
          {/* Unified Testing Lab replaces the separate Backtesting / Forward Testing pages. */}
          <Route path="/backtesting"><Redirect to="/testing-lab" /></Route>
          {/* /paper-trading removed (Phase 3). Demo execution lives at /demo-trading. */}
          <Route path="/prop-challenge" component={PropChallenge} />
          <Route path="/rule-contracts" component={RuleContracts} />
          <Route path="/trading-readiness" component={TradingReadiness} />
          <Route path="/post-trade-debriefs" component={PostTradeDebriefs} />
          <Route path="/playbook" component={Playbook} />
          <Route path="/edge-discovery" component={EdgeDiscovery} />
          <Route path="/trader-skill" component={TraderSkill} />
          <Route path="/ai-mentor" component={AiMentor} />
          <Route path="/analytics-command" component={AnalyticsCommand} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/emergency" component={Emergency} />
          <Route path="/activity" component={ActivityTimeline} />
          <Route path="/reports" component={Reports} />
          <Route path="/learning" component={Learning} />
          {/* The legacy /calendar page (thin list over /news/calendar) is
              retired — the unified Economic Calendar is the ONE calendar
              surface (Theme H5). Old bookmarks land there. */}
          <Route path="/calendar"><Redirect to="/economic-calendar" /></Route>
          <Route path="/trading-calendar" component={TradingCalendar} />
          <Route path="/ai-command-center" component={AICommandCenter} />
          <Route path="/trader-coach" component={TraderCoach} />
          <Route path="/replay-simulator" component={ReplaySimulator} />
          <Route path="/strategy-lab" component={StrategyLab} />
          <Route path="/data-import" component={DataImport} />
          <Route path="/broker-readonly" component={BrokerReadOnly} />
          <Route path="/escape-route" component={EscapeRoutePage} />
          <Route path="/notifications" component={Notifications} />
          <Route path="/economic-calendar" component={EconomicCalendar} />
          <Route path="/alerts" component={Alerts} />
          <Route path="/alert-preferences" component={AlertPreferencesPage} />
          <Route path="/watchlists" component={Watchlists} />
          <Route path="/portfolio" component={Portfolio} />
          <Route path="/live-trades" component={LiveTrades} />
          <Route path="/forex-center" component={ForexCenter} />
          <Route path="/indices-center" component={IndicesCenter} />
          <Route path="/stocks-center" component={StocksCenter} />
          <Route path="/synthetic-center" component={SyntheticCenter} />
          <Route path="/journal" component={JournalPage} />
          <Route path="/scalp-journal" component={ScalpJournalPage} />
          <Route path="/weekly-review" component={WeeklyReviewPage} />
          <Route path="/trade-plan-builder" component={TradePlanBuilderPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/brain" component={BrainAnalysis} />
          <Route path="/mt5-bridge" component={MT5Bridge} />
          <Route path="/mt5-setup" component={MT5Setup} />
          <Route path="/my-account" component={MyAccount} />
          <Route path="/mt5-status" component={MT5Bridge} />
          <Route path="/broker" component={MT5Setup} />
          <Route path="/testing-control-center" component={TestingControlCenter} />
          <Route path="/system-health" component={SystemHealth} />
          <Route path="/admin-control" component={AdminControl} />
          <Route path="/audit-log">{() => <AuditLog />}</Route>
          <Route path="/security-center" component={SecurityCenter} />
          <Route path="/roles-permissions" component={RolesPermissions} />
          <Route path="/security-events" component={SecurityEvents} />
          <Route path="/data-protection" component={DataProtection} />
          <Route path="/readiness-checklist" component={ReadinessChecklist} />
          {/* /trading-cockpit removed (Phase 3). The legacy page was paper-session-only
              (document title "PAPER ONLY", calls /api/paper-sessions/*, etc.) and has
              no coherent purpose once Paper Trading is retired. Component file moves
              to legacy/ in Phase 12. */}
          {/* /paper-testing-launch removed (Phase 3). */}
          <Route path="/onboarding" component={Onboarding} />
          <Route path="/help" component={HelpCenter} />
          <Route path="/status-command-center" component={StatusCommandCenter} />
          <Route path="/arx-status" component={StatusCommandCenter} />
          {/* /active-paper-session removed (Phase 3). */}
          <Route path="/live-trading-control" component={LiveTradingControl} />
          <Route path="/session-report" component={SessionReport} />

          {/* Build TT — FULL TESTER ACCESS routes */}
          <Route path="/charts" component={LiveChartPage} />
          <Route path="/live-chart" component={LiveChartPage} />
          <Route path="/live-manual" component={LiveManualPage} />
          <Route path="/live-shared" component={LiveSharedPage} />
          <Route path="/manual-trade-ticket" component={LiveManualPage} />
          <Route path="/live-ai-assist" component={LiveAiAssistPage} />
          <Route path="/live-ai-auto-test" component={LiveAiAutoTestPage} />
          <Route path="/ai-trading" component={LiveAiAssistPage} />
          <Route path="/ai-autopilot" component={LiveAiAutoTestPage} />
          <Route path="/ai-decisions" component={LiveAiAutoTestPage} />
          <Route path="/approval-queue" component={LiveIntentQueuePage} />
          <Route path="/live-intent-queue" component={LiveIntentQueuePage} />
          <Route path="/demo-trading" component={PaperTrading} />
          {/* /trading-command-center removed (Phase 3 — also backed by the
              paper-only TradingCockpit page). */}
          <Route path="/risk-governor" component={RiskSettings} />
          <Route path="/readiness" component={ReadinessChecklist} />
          <Route path="/audit-vault">{() => <AuditLog />}</Route>
          <Route path="/safety-logs">{() => <AuditLog />}</Route>
          <Route path="/admin" component={AdminHub} />
          <Route path="/admin/users" component={AdminUserControlCenter} />
          <Route path="/admin/user-control-center" component={AdminUserControlCenter} />
          <Route path="/admin/system-health" component={SystemHealth} />
          <Route path="/admin/permissions" component={AdminPermissions} />
          <Route path="/admin/trading-control" component={AdminTradingControl} />
          <Route path="/admin/master-bridge" component={AdminMasterBridge} />
          <Route path="/admin/audit-center" component={AdminAuditCenter} />
          <Route path="/admin/launch-readiness" component={AdminLaunchReadiness} />
          <Route path="/admin/reconciliation-center" component={AdminReconciliationCenter} />
          <Route path="/admin/ea-health" component={AdminEaHealth} />
          <Route path="/admin/bridge-v2-monitor" component={AdminBridgeV2Monitor} />
          <Route path="/admin/ea-updates" component={AdminEaUpdates} />
          <Route path="/admin/bridge-diagnostics" component={AdminBridgeDiagnostics} />
          <Route path="/admin/agent-ecosystem" component={AdminAgentEcosystem} />
          <Route path="/self-trade-ai" component={AdminSelfTradeAi} />
          <Route path="/admin/self-trade-ai" component={AdminSelfTradeAi} />
          <Route path="/admin/ruby-quality" component={AdminRubyQuality} />
          <Route path="/admin/ai-fix-agent" component={AdminAiFixAgent} />
          <Route path="/admin/timing-brain-snapshots" component={AdminTimingBrainSnapshots} />
          <Route path="/admin/operator-command-center" component={AdminOperatorCommandCenter} />
          <Route path="/admin/cockpit" component={AdminCockpitPage} />
          <Route path="/admin/beta-control" component={AdminBetaControl} />
          <Route path="/admin/beta-readiness" component={AdminBetaReadiness} />
          <Route path="/admin/live-test-readiness" component={AdminLiveTestReadiness} />
          <Route path="/admin/live-shared" component={AdminLiveShared} />
          <Route path="/admin/live-shared/activation" component={AdminLiveSharedActivation} />
          <Route path="/admin/one-click-controls" component={AdminOneClickControls} />
          <Route path="/admin/data-management" component={AdminDataManagement} />
          <Route path="/admin/security-status" component={AdminSecurityStatus} />
          <Route path="/trade-grader" component={TradeGraderPage} />
          <Route path="/ai-coach" component={AiCoachPage} />
          <Route path="/performance-scorecard" component={PerformanceScorecardPage} />
          <Route path="/market-replay" component={MarketReplayPage} />
          <Route path="/market-scanner" component={MarketScannerPage} />
          <Route path="/trade-command-room" component={TradeCommandRoomPage} />
          <Route path="/alerts-center" component={AlertsCenterPage} />
          <Route path="/session-plan" component={SessionPlanPage} />
          <Route path="/market-sessions" component={MarketSessionsPage} />
          <Route path="/news-risk" component={NewsRiskPage} />
          <Route path="/market-health" component={MarketHealthPage} />
          <Route path="/market-heat-map" component={MarketHeatMapPage} />
          <Route path="/data-quality" component={DataQualityPage} />
          <Route path="/orders" component={OrdersPage} />
          <Route path="/positions" component={PositionsPage} />
          <Route path="/approval-inbox" component={ApprovalInboxPage} />
          <Route path="/my-trades" component={MyTradesPage} />
          <Route path="/my-trades/:tradeKey" component={TradeDetailPage} />
          <Route path="/sniper-watchlist" component={SniperWatchlistPage} />
          <Route path="/broker-reconciliation" component={BrokerReconciliationPage} />
          <Route path="/autopilot-control-center" component={AutopilotControlCenter} />
          <Route path="/risk-command-center" component={RiskCommandCenter} />
          <Route path="/risk-profile" component={RiskCommandCenter} />
          <Route path="/profit-missions" component={ProfitMissions} />
          <Route path="/risk-events" component={RiskEventsPage} />
          <Route path="/prop-firm-mode" component={PropFirmModePage} />
          {/* Folded into the unified Testing Lab (item C): old deep links keep
              working via redirects, and the tab components keep their
              admin-role pre-check + honest denied card. */}
          <Route path="/shadow-mode"><Redirect to="/testing-lab?tab=shadow" /></Route>
          <Route path="/forward-testing"><Redirect to="/testing-lab?tab=forward" /></Route>
          <Route path="/strategy-tournament"><Redirect to="/testing-lab?tab=tournament" /></Route>
          <Route path="/confidence-calibration" component={ConfidenceCalibrationPage} />
          <Route path="/strategy-promotion"><Redirect to="/testing-lab?tab=promotion" /></Route>
          <Route path="/ai-readiness-score" component={AiReadinessScorePage} />
          <Route path="/shadow-journal" component={ShadowJournalPage} />

          {/* Build UU — Beta release / tester feedback / diagnostics */}
          <Route path="/release-status" component={ReleaseStatus} />
          <Route path="/release-notes" component={ReleaseNotes} />
          <Route path="/feedback-center" component={FeedbackCenter} />
          <Route path="/admin/issues" component={AdminIssues} />
          <Route path="/admin/diagnostics" component={AdminDiagnostics} />
          <Route path="/assistant-knowledge-gaps" component={AssistantKnowledgeGaps} />
          <Route path="/assistant-knowledge-console" component={AssistantKnowledgeConsole} />
          <Route path="/assistant-manual" component={AssistantManual} />

          <Route path="/brand-kit" component={BrandKit} />
          <Route path="/my-mt5" component={MyMt5Page} />
          <Route path="/protective-auto-close" component={ProtectiveAutoClose} />
          {/* /my-paper-trades removed (Phase 3). My Performance retained at /my-performance. */}
          <Route path="/my-performance" component={MyPaperTradesPage} />
          <Route path="/trading-intelligence" component={TradingIntelligencePage} />
          <Route path="/admin/learning-versions" component={AdminLearningVersionsPage} />
          <Route path="/admin/final-live-test" component={FinalLiveTestPage} />
          <Route path="/admin/deriv-health" component={DerivHealthPage} />
          <Route path="/admin/allocations" component={AdminAllocationsPage} />
          <Route path="/admin/fund-control-center" component={AdminFundControlCenter} />
          <Route path="/admin/investors" component={AdminInvestorsPage} />
          <Route path="/admin/provider-health" component={AdminProviderHealth} />
          <Route path="/admin/handshake-monitor" component={AdminHandshakeMonitor} />
          <Route path="/admin/system-cohesion" component={AdminSystemCohesion} />
          <Route path="/admin/ruby-voice" component={AdminRubyVoiceSettings} />
          <Route path="/admin/chart-brain-benchmark" component={AdminChartBrainBenchmark} />

          <Route component={NotFound} />
        </Switch>
      </Suspense>
      </RouteErrorBoundary>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SymbolProvider>
          <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
            <AuthGate>
              <ActivityPingMount />
              <PerfObserverMount />
              <AssistantNameProvider>
                <OnboardingProvider>
                  <Router />
                </OnboardingProvider>
              </AssistantNameProvider>
            </AuthGate>
          </WouterRouter>
          <Toaster />
        </SymbolProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
