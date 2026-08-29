// ── Profit Mission page — planner + Multi-Agent Proposals + gated execution ───
//
// HONEST LABELLING (F-build). This page shows the SERVER-COMPUTED feasibility /
// probability / pace read in the Battle Room plus the mission's specialist
// Agent Desk and proposals. Missions CAN now place trades — but ONLY through
// the gated path: dispatch routes through the instant-trade router (source
// "mission") → live pipeline → 18-gate dispatch, the default automation level
// (2) waits for the user's explicit approval on every trade, and auto levels
// must be earned through the promotion gates, explicitly enabled, and are
// re-checked against every gate at each dispatch. Every figure is a labelled
// estimate or an honest empty state; nothing here is a promise of profit.
import { useMemo, useState, type ReactElement, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageTabs } from "@/components/ui/PageTabs";
import { CompactAlert } from "@/components/ui/CompactAlert";
import { MissionPerformanceView } from "@/components/missions/MissionPerformanceView";
import {
  Target,
  Gauge,
  TrendingUp,
  ShieldAlert,
  Flag,
  Users,
  Radar,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Gavel,
  Loader2,
  ListOrdered,
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Rocket,
  OctagonAlert,
  ShieldCheck,
  Layers,
} from "lucide-react";
import {
  useListProfitMissions,
  useCreateProfitMission,
  usePauseProfitMission,
  useResumeProfitMission,
  useCancelProfitMission,
  useListProfitMissionEvents,
  useListMissionAgents,
  useListMissionProposals,
  useRunMissionScan,
  useListMissionTradeDrafts,
  useApproveMissionProposalDraft,
  useRejectMissionProposalDraft,
  useGetProfitMissionPulse,
  useEmergencyStopProfitMission,
  useExecuteMissionProposalDraft,
  useManageMissionTradeExit,
  useRunMissionBacktest,
  useAggregateMissionForward,
  useListMissionTestResults,
  useGetMissionDrift,
  useGetMissionPromotion,
  useApplyMissionAutomationLevel,
  useGetMissionCertificate,
  useAcceptMissionCertificate,
  useGetMissionBriefing,
  useGetMissionEodReview,
  useGetMissionReport,
  useParseProfitMissionIntent,
  getListProfitMissionsQueryKey,
  getListProfitMissionEventsQueryKey,
  getListMissionAgentsQueryKey,
  getListMissionProposalsQueryKey,
  getListMissionTradeDraftsQueryKey,
  getGetProfitMissionPulseQueryKey,
  getListMissionTestResultsQueryKey,
  getGetMissionDriftQueryKey,
  getGetMissionPromotionQueryKey,
  getGetMissionCertificateQueryKey,
} from "@workspace/api-client-react";
import type {
  ProfitMission,
  ProfitMissionFeasibility,
  ProfitMissionProbability,
  ProfitMissionRiskState,
  MissionEvent,
  MissionAgent,
  MissionProposal,
  MissionScanResult,
  OpportunityQueue,
  OpportunityQueueEntry,
  TradeDraft,
  MissionImpact,
  MissionExecutionQuality,
  MissionExecutionHealth,
  MissionExposureAggregates,
  MissionProtectionSnapshot,
  MissionExitActionResult,
  MissionTestResult,
} from "@workspace/api-client-react";
import {
  computeMissionMath,
  evaluateFeasibility,
  evaluateProbability,
  specToMinutes,
  specToLabel,
  resolveMissionTimeframeLabel,
  TIMEFRAME_QUICK_PICKS,
  type FeasibilityVerdict,
  type MissionProbabilityScore,
  type TimeframeUnit,
} from "@workspace/domain/profit-mission";
import {
  resolvePrimaryActionLabel,
  isUnrealisticMission,
  pctTrim,
  pctTrimPerDay,
} from "./profitMissionPlanner";

const RISK_PROFILES = ["conservative", "balanced", "aggressive", "extreme"] as const;
type RiskProfile = (typeof RISK_PROFILES)[number];

const TIER_COLOR: Record<string, string> = {
  Easy: "bg-success/20 text-success",
  Realistic: "bg-success/20 text-success",
  Challenging: "bg-warning/20 text-warning",
  Aggressive: "bg-warning/20 text-warning",
  Extreme: "bg-danger/20 text-danger",
  Unreasonable: "bg-danger/20 text-danger",
};

// Mission lifecycle status → badge tone + human label. Terminal states are muted.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  pending_approval: { label: "Pending approval", cls: "bg-warning/20 text-warning" },
  running: { label: "Running", cls: "bg-success/20 text-success" },
  paused: { label: "Paused", cls: "bg-warning/20 text-warning" },
  protect_mode: { label: "Protect mode", cls: "bg-warning/20 text-warning" },
  target_hit: { label: "Target hit", cls: "bg-success/20 text-success" },
  stopped_by_risk: { label: "Stopped by risk", cls: "bg-danger/20 text-danger" },
  failed: { label: "Failed", cls: "bg-danger/20 text-danger" },
  expired: { label: "Expired", cls: "bg-muted text-muted-foreground" },
  completed: { label: "Completed", cls: "bg-success/20 text-success" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

function statusMeta(status: string): { label: string; cls: string } {
  return STATUS_META[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
}

const MISSION_EVENT_LABEL: Record<string, string> = {
  mission_created: "Mission created",
  status_changed: "Status changed",
  paused: "Paused",
  resumed: "Resumed",
  cancelled: "Cancelled",
  settings_updated: "Settings updated",
  feasibility_recorded: "Feasibility recorded",
  mode_changed: "Mode changed",
  snapshot_taken: "Snapshot taken",
  risk_stop: "Risk stop",
  target_reached: "Target reached",
  expired: "Expired",
};

// User lifecycle affordances available per state (mirrors the server state machine).
function canPause(status: string): boolean {
  return status === "running" || status === "protect_mode";
}
function canResume(status: string): boolean {
  return status === "paused" || status === "stopped_by_risk";
}
function canCancel(status: string): boolean {
  return !["failed", "expired", "completed", "cancelled"].includes(status);
}

function money(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}
function pct(n: number, digits = 1): string {
  return `${(Number.isFinite(n) ? n : 0).toFixed(digits)}%`;
}

// ── Projection disclaimer banner (always shown over assessment output) ───────
function EstimateBanner() {
  return (
    <CompactAlert
      tone="info"
      title="Planning projections only"
      description="Every figure below is a mathematical projection from your inputs and pace — not backtested and not a promise of profit. Possible loss is real and results vary."
      testId="alert-estimate-disclaimer"
    />
  );
}

// ── Feed-not-confirmed banner (planner is draft-only until a feed exists) ─────
function FeedNotConfirmedBanner() {
  return (
    <CompactAlert
      tone="warning"
      title="Live feed not confirmed"
      description="Live feed not confirmed. You can save this mission as a draft, but it cannot start until broker feed is confirmed."
      testId="alert-feed-not-confirmed"
    />
  );
}

// ── Creation form ────────────────────────────────────────────────────────────
// Two-step planner: the first click ASSESSES the inputs (pure domain engines,
// feed hard-coded NOT ready) and reveals the honest read; the second click
// persists the mission. The feed is never confirmed in Phase 1, so the mission
// can only ever be saved as a DRAFT — START stays blocked. Editing any input
// resets the assessment so the read can never get stale.
function CreateMissionForm({ onCreated }: { onCreated: (m: ProfitMission) => void }) {
  const qc = useQueryClient();
  const [startingAmount, setStartingAmount] = useState("1000");
  const [targetAmount, setTargetAmount] = useState("1300");
  const [timeframeAmount, setTimeframeAmount] = useState("7");
  const [timeframeUnit, setTimeframeUnit] = useState<TimeframeUnit>("days");
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("balanced");
  const [error, setError] = useState<string | null>(null);
  const [assessed, setAssessed] = useState(false);
  const [nlText, setNlText] = useState("");
  const [nlError, setNlError] = useState<string | null>(null);

  const parseIntent = useParseProfitMissionIntent({
    mutation: {
      onSuccess: (intent) => {
        // startingAmount is null for target-only phrases — keep current form value.
        if (intent.startingAmount != null) {
          setStartingAmount(String(intent.startingAmount));
        }
        setTargetAmount(String(intent.targetAmount));
        setTimeframeAmount(String(intent.timeframeAmount));
        setTimeframeUnit(intent.timeframeUnit as TimeframeUnit);
        if (intent.riskProfile) {
          setRiskProfile(intent.riskProfile as RiskProfile);
        }
        setNlError(null);
        setNlText("");
        if (assessed) setAssessed(false);
      },
      onError: (e) => setNlError((e as Error)?.message ?? "Could not parse that description"),
    },
  });

  const create = useCreateProfitMission({
    mutation: {
      onSuccess: (m) => {
        void qc.invalidateQueries({ queryKey: getListProfitMissionsQueryKey() });
        onCreated(m);
      },
      onError: (e) => setError((e as Error)?.message ?? "Could not create mission"),
    },
  });

  // Editing any input invalidates the previous assessment — never show a stale read.
  const resetAssessment = useCallback(() => {
    if (assessed) setAssessed(false);
  }, [assessed]);

  // Apply a quick-pick chip (amount + unit).
  function applyQuickPick(amount: number, unit: TimeframeUnit) {
    setTimeframeAmount(String(amount));
    setTimeframeUnit(unit);
    if (assessed) setAssessed(false);
  }

  // Total minutes from the current timeframe inputs.
  const totalMinutes = useMemo(() => {
    const a = Number(timeframeAmount);
    if (!Number.isFinite(a) || a <= 0) return 0;
    return specToMinutes(a, timeframeUnit);
  }, [timeframeAmount, timeframeUnit]);

  // Pure client-side read of the CURRENT inputs. Mirrors the server `assess()`
  // composition exactly: feed is hard-coded NOT ready and sampleSize is 0, so
  // canStart is always false and the probability is a planning projection.
  const liveAssessment = useMemo<{
    math: ReturnType<typeof computeMissionMath>;
    feasibility: FeasibilityVerdict;
    probability: MissionProbabilityScore;
  } | null>(() => {
    const start = Number(startingAmount);
    const target = Number(targetAmount);
    if (!Number.isFinite(start) || start <= 0) return null;
    if (!Number.isFinite(target) || target <= start) return null;
    if (totalMinutes <= 0) return null;
    const now = Date.now();
    const math = computeMissionMath({
      startingAmount: start,
      targetAmount: target,
      timeframeStartMs: now,
      timeframeEndMs: now + totalMinutes * 60_000,
      nowMs: now,
    });
    const feasibility = evaluateFeasibility({
      math,
      riskProfile,
      feed: { ready: false, reason: "FEED_NOT_CONFIRMED" },
    });
    const probability = evaluateProbability({
      math,
      feasibility,
      riskProfile,
      sampleSize: 0,
    });
    return { math, feasibility, probability };
  }, [startingAmount, targetAmount, totalMinutes, riskProfile]);

  function validateInputs(): boolean {
    setError(null);
    const start = Number(startingAmount);
    const target = Number(targetAmount);
    const a = Number(timeframeAmount);
    if (!Number.isFinite(start) || start <= 0) {
      setError("Starting amount must be a positive number.");
      return false;
    }
    if (!Number.isFinite(target) || target <= start) {
      setError("Target must be greater than the starting amount.");
      return false;
    }
    if (!Number.isFinite(a) || a <= 0) {
      setError("Timeframe amount must be a positive number.");
      return false;
    }
    return true;
  }

  // Step 1 (assess) only reveals the read; step 2 (save) persists the draft.
  function onPrimaryAction() {
    if (!validateInputs()) return;
    if (!assessed) {
      setAssessed(true);
      return;
    }
    const start = Number(startingAmount);
    const target = Number(targetAmount);
    const a = Number(timeframeAmount);
    const now = Date.now();
    create.mutate({
      data: {
        startingAmount: start,
        targetAmount: target,
        timeframeStart: new Date(now).toISOString(),
        // Pass the unit-aware fields; server derives timeframeEnd from them.
        timeframeAmount: a,
        timeframeUnit,
        riskProfile,
      },
    });
  }

  const feasibility = assessed ? liveAssessment?.feasibility ?? null : null;
  const actionLabel = resolvePrimaryActionLabel(assessed, feasibility);

  return (
    <Card data-testid="card-create-mission">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flag className="h-5 w-5" /> Describe your goal
        </CardTitle>
        <CardDescription>
          Set a starting amount, a target, and a timeframe. We compute the
          required pace and an honest feasibility read — planning only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Natural-language quick-fill row */}
        <div className="space-y-1">
          <Label htmlFor="pm-nl-input" className="text-xs text-muted-foreground">
            Describe in plain English (optional)
          </Label>
          <div className="flex gap-2">
            <Input
              id="pm-nl-input"
              data-testid="input-nl-mission"
              placeholder='e.g. "turn $500 into $750 in 2 hours"'
              value={nlText}
              onChange={(e) => {
                setNlText(e.target.value);
                if (nlError) setNlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nlText.trim()) {
                  parseIntent.mutate({ data: { text: nlText.trim() } });
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!nlText.trim() || parseIntent.isPending}
              onClick={() => parseIntent.mutate({ data: { text: nlText.trim() } })}
            >
              {parseIntent.isPending ? "Parsing…" : "Parse"}
            </Button>
          </div>
          {nlError && <p className="text-xs text-destructive">{nlError}</p>}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pm-start">Starting amount</Label>
            <Input
              id="pm-start"
              data-testid="input-starting-amount"
              inputMode="decimal"
              value={startingAmount}
              onChange={(e) => {
                setStartingAmount(e.target.value);
                resetAssessment();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pm-target">Target amount</Label>
            <Input
              id="pm-target"
              data-testid="input-target-amount"
              inputMode="decimal"
              value={targetAmount}
              onChange={(e) => {
                setTargetAmount(e.target.value);
                resetAssessment();
              }}
            />
          </div>
          {/* Two-part timeframe: amount + unit */}
          <div className="space-y-1">
            <Label>Timeframe</Label>
            <div className="flex gap-2">
              <Input
                id="pm-timeframe-amount"
                data-testid="input-timeframe-amount"
                inputMode="decimal"
                className="w-24 shrink-0"
                value={timeframeAmount}
                onChange={(e) => {
                  setTimeframeAmount(e.target.value);
                  resetAssessment();
                }}
              />
              <Select
                value={timeframeUnit}
                onValueChange={(v) => {
                  setTimeframeUnit(v as TimeframeUnit);
                  resetAssessment();
                }}
              >
                <SelectTrigger data-testid="select-timeframe-unit" className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutes</SelectItem>
                  <SelectItem value="hours">hours</SelectItem>
                  <SelectItem value="days">days</SelectItem>
                  <SelectItem value="weeks">weeks</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Quick-pick chips */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Quick picks</p>
          <div className="flex flex-wrap gap-1.5" data-testid="timeframe-quick-picks">
            {TIMEFRAME_QUICK_PICKS.map((pick) => {
              const active =
                Number(timeframeAmount) === pick.amount && timeframeUnit === pick.unit;
              return (
                <button
                  key={pick.label}
                  type="button"
                  data-testid={`quick-pick-${pick.label.replace(/\s+/g, "-")}`}
                  onClick={() => applyQuickPick(pick.amount, pick.unit)}
                  className={[
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border bg-muted/50 text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  ].join(" ")}
                >
                  {pick.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* Derived timeframe label */}
        {totalMinutes > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="timeframe-label-preview">
            Timeframe: <span className="font-medium">{specToLabel(Number(timeframeAmount), timeframeUnit)}</span>
            {" "}
            <span className="opacity-60">({totalMinutes < 60
              ? `${totalMinutes} min`
              : totalMinutes < 1440
                ? `${(totalMinutes / 60).toFixed(totalMinutes % 60 === 0 ? 0 : 1)} hr`
                : `${(totalMinutes / 1440).toFixed(totalMinutes % 1440 === 0 ? 0 : 1)} day`})</span>
          </p>
        )}
        <div className="space-y-1 sm:max-w-xs">
          <Label htmlFor="pm-risk">Risk profile</Label>
          <Select
            value={riskProfile}
            onValueChange={(v) => {
              setRiskProfile(v as RiskProfile);
              resetAssessment();
            }}
          >
            <SelectTrigger id="pm-risk" data-testid="select-risk-profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_PROFILES.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && (
          <CompactAlert tone="danger" title={error} testId="alert-create-error" />
        )}
        <Button
          onClick={onPrimaryAction}
          disabled={create.isPending}
          data-testid="button-create-mission"
        >
          {create.isPending ? "Saving…" : actionLabel}
        </Button>

        {assessed && liveAssessment && (
          <div className="space-y-4" data-testid="section-assessment">
            <EstimateBanner />
            <FeedNotConfirmedBanner />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <FeasibilityPanel f={liveAssessment.feasibility} math={liveAssessment.math} />
              <ProbabilityPanel p={liveAssessment.probability} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Feasibility panel ────────────────────────────────────────────────────────
export function FeasibilityPanel({
  f,
  math,
}: {
  f: FeasibilityVerdict;
  math?: ReturnType<typeof computeMissionMath> | null;
}) {
  const mismatch = f.riskProfileMismatch;
  const isShortTf = (math?.timeframeMinutes ?? Infinity) < 1440;
  return (
    <Card data-testid="card-feasibility">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 flex-wrap">
          <Gauge className="h-5 w-5" /> Feasibility
          <Badge className={TIER_COLOR[f.tier] ?? "bg-muted"} data-testid="badge-tier">
            {f.tier}
          </Badge>
          <Badge variant="outline" className="text-xs" data-testid="badge-unit-class">
            {f.unitAwareMissionClass}
          </Badge>
        </CardTitle>
        <CardDescription>{f.explanation}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Feasibility score" value={`${Math.round(f.feasibilityScore)}/100`} testId="metric-feasibility-score" />
          <Metric label="Risk score" value={`${Math.round(f.riskScore)}/100`} testId="metric-risk-score" />
          <Metric label="Required return" value={pctTrim(f.requiredReturnPct)} testId="metric-required-return" />
          {isShortTf && math ? (
            <>
              <Metric
                label="Required / hour"
                value={pctTrim(math.requiredReturnPerHourPct)}
                testId="metric-required-per-hour"
              />
              <Metric
                label="Daily-equivalent pace"
                value={pctTrimPerDay(math.requiredDailyEquivalentReturnPct)}
                testId="metric-daily-equivalent"
              />
            </>
          ) : (
            <Metric label="Required daily pace" value={pctTrimPerDay(f.requiredDailyReturnPct)} testId="metric-required-daily-pace" />
          )}
          <Metric label="Recommended profile" value={f.recommendedRiskProfile} />
          <Metric label="Mission type" value={f.missionType.replace(/_/g, " ")} />
        </div>
        {mismatch.mismatch && mismatch.explanation && (
          <CompactAlert
            tone="warning"
            title="Risk profile is below what this target needs"
            description={mismatch.explanation}
            testId="alert-risk-mismatch"
          />
        )}
        {f.warnings.length > 0 && (
          <ul className="space-y-1 text-sm text-warning" data-testid="list-feasibility-warnings">
            {f.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {f.canStart
            ? "Feed confirmed for assessment."
            : `Live feed not confirmed${f.startBlockReason ? ` (${f.startBlockReason})` : ""} — drafting allowed, starting held.`}
        </p>
      </CardContent>
    </Card>
  );
}

// ── Probability panel ────────────────────────────────────────────────────────
function ProbabilityPanel({ p }: { p: MissionProbabilityScore }) {
  const projectionOnly = p.planningProjectionOnly;
  const suffix = projectionOnly ? " (planning projection only)" : " (est.)";
  return (
    <Card data-testid="card-probability">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" /> Probability &amp; risk
          {projectionOnly ? " (planning projection)" : " (estimate)"}
        </CardTitle>
        <CardDescription>
          Confidence: <span className="capitalize">{p.confidence}</span> · sample
          size {p.sampleSize}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {projectionOnly && p.planningProjectionNote && (
          <CompactAlert
            tone="info"
            title="Planning projection — not backtested"
            description={p.planningProjectionNote}
            testId="alert-planning-projection"
          />
        )}
        <div className="grid grid-cols-3 gap-3">
          <Metric label={`Target-hit${suffix}`} value={pct(p.targetHitProbability, 0)} testId="metric-target-hit" />
          <Metric label={`Drawdown risk${suffix}`} value={pct(p.drawdownRisk, 0)} />
          <Metric label={`Falls short${suffix}`} value={pct(p.failureProbability, 0)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Scenario label="Best" v={p.projections.best} projectionOnly={projectionOnly} />
          <Scenario label="Expected" v={p.projections.expected} projectionOnly={projectionOnly} />
          <Scenario label="Worst" v={p.projections.worst} projectionOnly={projectionOnly} />
        </div>
        {p.sampleSizeWarnings.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="list-sample-warnings">
            {p.sampleSizeWarnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground" data-testid="text-probability-caption">
          Projected values · Planning-only · Not backtested · Not a promise of profit.
        </p>
        <p className="text-xs text-muted-foreground">{p.disclaimer}</p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-md border border-border/50 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold capitalize" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function Scenario({
  label,
  v,
  projectionOnly,
}: {
  label: string;
  v: { endingValue: number; profit: number; returnPct: number };
  projectionOnly?: boolean;
}) {
  const positive = v.profit >= 0;
  return (
    <div className="rounded-md border border-border/50 p-2">
      <div className="text-xs text-muted-foreground">
        {label}
        {projectionOnly ? " (planning projection)" : " (est.)"}
      </div>
      <div className="text-base font-semibold">{money(v.endingValue)}</div>
      <div className={`text-xs ${positive ? "text-success" : "text-danger"}`}>
        {positive ? "+" : ""}
        {money(v.profit)} · {pct(v.returnPct)}
      </div>
    </div>
  );
}

// ── Lifecycle controls (pause / resume / cancel) ─────────────────────────────
function MissionControls({ mission }: { mission: ProfitMission }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListProfitMissionsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListProfitMissionEventsQueryKey(mission.id) });
  };
  const onError = (e: unknown) =>
    setError((e as Error)?.message ?? "Action could not be completed");

  const pause = usePauseProfitMission({ mutation: { onSuccess: refresh, onError } });
  const resume = useResumeProfitMission({ mutation: { onSuccess: refresh, onError } });
  const cancel = useCancelProfitMission({ mutation: { onSuccess: refresh, onError } });

  const busy = pause.isPending || resume.isPending || cancel.isPending;
  const meta = statusMeta(mission.status);

  return (
    <div className="space-y-2" data-testid="mission-controls">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={meta.cls} data-testid="badge-mission-status">
          {meta.label}
        </Badge>
        <Badge variant="outline" data-testid="badge-mission-mode" className="capitalize">
          {mission.currentMode}
        </Badge>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canPause(mission.status)}
            onClick={() => {
              setError(null);
              pause.mutate({ id: mission.id, data: {} });
            }}
            data-testid="button-pause-mission"
          >
            Pause
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canResume(mission.status)}
            onClick={() => {
              setError(null);
              resume.mutate({ id: mission.id, data: {} });
            }}
            data-testid="button-resume-mission"
          >
            Resume
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canCancel(mission.status)}
            onClick={() => {
              setError(null);
              if (window.confirm("Cancel this mission? This cannot be undone.")) {
                cancel.mutate({ id: mission.id, data: {} });
              }
            }}
            data-testid="button-cancel-mission"
          >
            Cancel
          </Button>
        </div>
      </div>
      {error && <CompactAlert tone="danger" title={error} testId="alert-control-error" />}
    </div>
  );
}

// ── Mission Journal (append-only event timeline) ─────────────────────────────
function MissionJournal({ missionId }: { missionId: number }) {
  const { data: events, isLoading } = useListProfitMissionEvents(missionId, { limit: 100, offset: 0 });
  return (
    <Card data-testid="card-mission-journal">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flag className="h-5 w-5" /> Mission Journal
        </CardTitle>
        <CardDescription>
          An append-only record of every state change and decision for this mission.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading journal…</p>
        ) : !events || events.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-events">
            No journal entries yet.
          </p>
        ) : (
          <ol className="space-y-3" data-testid="list-mission-events">
            {events.map((ev: MissionEvent) => (
              <li key={ev.id} className="flex gap-3 border-l-2 border-border/60 pl-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" data-testid={`event-type-${ev.id}`}>
                      {MISSION_EVENT_LABEL[ev.type] ?? ev.type}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(ev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {ev.message && (
                    <p className="text-sm text-muted-foreground">{ev.message}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ── Battle Room header shell ──────────────────────────────────────────────────
export function BattleRoomShell({ mission }: { mission: ProfitMission | null }) {
  const m = mission?.math;
  return (
    <Card data-testid="card-battle-room">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" /> Battle Room
          {mission && (
            <Badge className={statusMeta(mission.status).cls} data-testid="badge-battle-status">
              {statusMeta(mission.status).label}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {mission
            ? `${money(mission.startingAmount)} → ${money(mission.targetAmount)} in ${resolveMissionTimeframeLabel(mission)}`
            : "Create a mission to see its goal, pace, and progress here."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {mission && <MissionControls mission={mission} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label="Required profit"
            value={m ? money(m.requiredProfit) : "—"}
            testId="metric-required-profit"
          />
          <Metric
            label="Required / day"
            value={m ? money(m.requiredDailyProfit) : "—"}
          />
          {m && m.timeframeMinutes < 1440 ? (
            <>
              <Metric
                label="Required / hour"
                value={pct(m.requiredReturnPerHourPct, 2)}
                testId="metric-hourly-return"
              />
              <Metric
                label="Daily-equivalent"
                value={pct(m.requiredDailyEquivalentReturnPct, 2)}
                testId="metric-daily-equivalent-return"
              />
            </>
          ) : (
            <Metric
              label="Daily return needed"
              value={m ? pct(m.requiredDailyReturnPct, 2) : "—"}
              testId="metric-daily-return"
            />
          )}
          <Metric label="Progress" value={m ? pct(m.progressPctClamped, 0) : "—"} />
          <Metric label="Current value" value={mission ? money(mission.currentValue) : "—"} />
          <Metric label="Mission class" value={mission?.feasibility?.unitAwareMissionClass ?? (m ? "—" : "—")} />
          <Metric label="Risk profile" value={mission ? mission.riskProfile : "—"} />
          <Metric label="Pace status" value={m ? (m.onTrack ? "On pace" : "Behind pace") : "—"} />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Phase 3 — Multi-Agent Proposals (advisory display) ───────────────────────

const AGENT_STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-success/20 text-success" },
  shadow: { label: "Shadow", cls: "bg-muted text-muted-foreground" },
  learning_camp: { label: "Learning", cls: "bg-warning/20 text-warning" },
  probation: { label: "Probation", cls: "bg-warning/20 text-warning" },
  restricted: { label: "Restricted", cls: "bg-destructive/20 text-destructive" },
  disabled: { label: "Disabled", cls: "bg-muted text-muted-foreground" },
};

const PROPOSAL_STATUS_META: Record<string, { label: string; cls: string }> = {
  selected: { label: "Selected", cls: "bg-success/20 text-success" },
  proposed: { label: "Proposed", cls: "bg-primary/15 text-primary" },
  rejected: { label: "Rejected", cls: "bg-muted text-muted-foreground" },
  vetoed: { label: "Risk veto", cls: "bg-destructive/20 text-destructive" },
  expired: { label: "Expired", cls: "bg-muted text-muted-foreground" },
  context_only: { label: "Context", cls: "bg-muted text-muted-foreground" },
};

function directionMeta(direction: MissionProposal["direction"]) {
  if (direction === "BUY") {
    return { label: "Buy", cls: "text-success", Icon: ArrowUpRight };
  }
  if (direction === "SELL") {
    return { label: "Sell", cls: "text-destructive", Icon: ArrowDownRight };
  }
  return { label: "No trade", cls: "text-muted-foreground", Icon: Minus };
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 5 });
}

// ── Agent Desk: the mission's specialist team (advisory roster) ───────────────
function MissionAgentDesk({ missionId }: { missionId: number }) {
  const { data: agents, isLoading } = useListMissionAgents(missionId);
  return (
    <Card data-testid="card-agent-desk">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" /> Agent Desk
        </CardTitle>
        <CardDescription>
          Your mission's specialist agents. Advisory only — they scout setups and
          never place trades.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading team…</p>
        ) : !agents || agents.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-agents">
            No agents assigned yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="list-agents">
            {agents.map((a: MissionAgent) => {
              const meta = AGENT_STATUS_META[a.status] ?? {
                label: a.status,
                cls: "bg-muted text-muted-foreground",
              };
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-border p-2"
                  data-testid={`agent-${a.agentKey}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{a.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{a.role}</div>
                  </div>
                  <Badge className={meta.cls}>{meta.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── A single proposal row (read-only analysis artifact) ──────────────────────
function ProposalRow({ p }: { p: MissionProposal }) {
  const dir = directionMeta(p.direction);
  const sMeta = PROPOSAL_STATUS_META[p.status] ?? {
    label: p.status,
    cls: "bg-muted text-muted-foreground",
  };
  return (
    <li
      className="rounded-md border border-border p-3"
      data-testid={`proposal-${p.proposalId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <dir.Icon className={`h-4 w-4 ${dir.cls}`} />
          <span className="font-medium">{p.symbol}</span>
          <span className="text-xs text-muted-foreground">{p.timeframe}</span>
          <span className={`text-xs ${dir.cls}`}>{dir.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {p.status === "selected" && <Gavel className="h-3.5 w-3.5 text-success" />}
          <Badge className={sMeta.cls} data-testid={`proposal-status-${p.proposalId}`}>
            {sMeta.label}
          </Badge>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Agent</span>
          <div>{p.agentKey}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Confidence</span>
          <div>{Math.round(p.confidence)}%</div>
        </div>
        <div>
          <span className="text-muted-foreground">Entry</span>
          <div>{fmtPrice(p.entryPlan.entryPrice)}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Stop / Target</span>
          <div>
            {fmtPrice(p.riskPlan.stopLoss)} / {fmtPrice(p.riskPlan.takeProfit)}
          </div>
        </div>
      </div>
      {p.reason && <p className="mt-2 text-xs text-muted-foreground">{p.reason}</p>}
      {p.riskObjection && (
        <p className="mt-1 text-xs text-destructive" data-testid={`proposal-veto-${p.proposalId}`}>
          Risk: {p.riskObjection}
        </p>
      )}
      {p.selectionReason && (
        <p className="mt-1 text-xs text-success">Judge: {p.selectionReason}</p>
      )}
      {p.executionQuality && <ExecutionQualityDetail eq={p.executionQuality} />}
    </li>
  );
}

// Edge tier → badge tone. Lower tiers are muted/destructive (skip, not force).
const EDGE_TIER_CLS: Record<string, string> = {
  "A+": "bg-success/20 text-success",
  A: "bg-success/20 text-success",
  B: "bg-success/10 text-success",
  C: "bg-warning/20 text-warning",
  D: "bg-warning/20 text-warning",
  F: "bg-danger/20 text-danger",
};

const DRAFT_STATUS_META: Record<string, { label: string; cls: string }> = {
  proposed: { label: "Proposed", cls: "bg-muted text-muted-foreground" },
  waiting_confirmation: { label: "Awaiting review", cls: "bg-warning/20 text-warning" },
  approved: { label: "Approved", cls: "bg-success/20 text-success" },
  rejected: { label: "Rejected", cls: "bg-danger/20 text-danger" },
  expired: { label: "Expired", cls: "bg-muted text-muted-foreground" },
  executed: { label: "Executed", cls: "bg-success/20 text-success" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

function edgeTierBadge(tier: string | null | undefined): ReactElement | null {
  if (!tier) return null;
  return (
    <Badge className={EDGE_TIER_CLS[tier] ?? "bg-muted text-muted-foreground"}>
      Edge {tier}
    </Badge>
  );
}

// ── Mission Impact Preview: best / expected / worst case (ESTIMATE ONLY) ─────
function MissionImpactPreview({ impact }: { impact: MissionImpact }) {
  const rows: { key: string; label: string; v: MissionImpact["win"]; cls: string }[] = [
    { key: "win", label: "If target hits", v: impact.win, cls: "text-success" },
    { key: "expected", label: "Expected", v: impact.expected, cls: "text-muted-foreground" },
    { key: "loss", label: "If stop hits", v: impact.loss, cls: "text-destructive" },
  ];
  return (
    <div className="rounded-md border border-border p-3" data-testid="mission-impact-preview">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Gauge className="h-4 w-4" /> Mission impact preview
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{impact.summary}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Scenario</th>
              <th className="py-1 pr-3 font-normal">Mission value</th>
              <th className="py-1 pr-3 font-normal">Progress</th>
              <th className="py-1 font-normal">Required daily pace</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-testid={`impact-row-${r.key}`}>
                <td className={`py-1 pr-3 ${r.cls}`}>{r.label}</td>
                <td className="py-1 pr-3">{money(r.v.resultingValue)}</td>
                <td className="py-1 pr-3">
                  {pct(r.v.progressPctAfter)}{" "}
                  <span className={r.v.progressPctDelta >= 0 ? "text-success" : "text-destructive"}>
                    ({r.v.progressPctDelta >= 0 ? "+" : ""}
                    {pct(r.v.progressPctDelta)})
                  </span>
                </td>
                <td className="py-1">{pct(r.v.requiredDailyPaceAfter)}/day</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Estimate only — based on the planned stop and target. Markets can gap or
        slip; outcomes are not guaranteed.
      </p>
    </div>
  );
}

// ── Phase 7 — Execution-quality / net-profit / exposure / health (advisory) ──
//
// BLOCK/DOWNGRADE-ONLY surfaces. Honest unknown is rendered as "Unknown", never
// "good"/"normal". These never place a trade and never relax a gate.

// Safe readers over the loose (additionalProperties) verdict records.
function vStr(o: Record<string, unknown> | null | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function vBool(o: Record<string, unknown> | null | undefined, k: string): boolean | null {
  const v = o?.[k];
  return typeof v === "boolean" ? v : null;
}
function vNum(o: Record<string, unknown> | null | undefined, k: string): number | null {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function vArr(o: Record<string, unknown> | null | undefined, k: string): string[] {
  const v = o?.[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// A status chip; unknown/empty reads neutral as "Unknown" — never a positive word.
function StatusChip({ label, value }: { label: string; value: string | null }) {
  const v = value && value.length > 0 ? value : "unknown";
  const negative = /block|stale|high|wide|illiquid|poor|expired|closed|unknown/i.test(v);
  const cls = negative ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <Badge className={cls}>{v.replace(/_/g, " ")}</Badge>
    </span>
  );
}

function ExecutionQualityDetail({ eq }: { eq: MissionExecutionQuality }) {
  const exec = (eq.executionQuality ?? null) as Record<string, unknown> | null;
  const net = (eq.netProfit ?? null) as Record<string, unknown> | null;
  const expo = (eq.exposure ?? null) as Record<string, unknown> | null;

  const execAllowed = vBool(exec, "allowed");
  const execBlockers = vArr(exec, "blockers");
  const execWarnings = vArr(exec, "warnings");
  const netAllowed = vBool(net, "allowed");
  const netBlockers = vArr(net, "blockers");
  const netWarnings = vArr(net, "warnings");
  const netEstimate = vNum(net, "netProfitEstimate");
  const costUnverified = vBool(net, "costPartiallyUnverified") === true;
  const expoAllowed = expo ? vBool(expo, "allowed") : null;
  const expoBlockers = vArr(expo, "blockers");

  return (
    <div
      className="mt-2 rounded-md border border-border p-2 text-xs"
      data-testid="execution-quality-detail"
    >
      <div className="mb-1 flex items-center gap-2 font-medium">
        <ShieldCheck className="h-3.5 w-3.5" /> Execution quality (advisory)
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className={execAllowed === false ? "bg-danger/20 text-danger" : "bg-success/15 text-success"}
          data-testid="exec-quality-verdict"
        >
          {execAllowed === false ? "Execution blocked" : "Execution OK"}
        </Badge>
        <StatusChip label="Spread" value={vStr(exec, "spreadStatus")} />
        <StatusChip label="Slippage" value={vStr(exec, "slippageRisk")} />
        <StatusChip label="Quote" value={vStr(exec, "quoteFreshness")} />
        <StatusChip label="Liquidity" value={vStr(exec, "liquidityStatus")} />
      </div>
      {vStr(exec, "reason") && (
        <p className="mt-1 text-muted-foreground">{vStr(exec, "reason")}</p>
      )}
      {(execBlockers.length > 0 || execWarnings.length > 0) && (
        <p className="mt-1 text-[11px] text-warning">
          {[...execBlockers, ...execWarnings].join(" · ")}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge
          className={netAllowed === false ? "bg-danger/20 text-danger" : "bg-success/15 text-success"}
          data-testid="net-profit-verdict"
        >
          {netAllowed === false ? "Net profit too thin" : "Net profit OK"}
        </Badge>
        <span className="text-muted-foreground">
          Est. net after costs: {netEstimate != null ? money(netEstimate) : "unknown"}
        </span>
        {costUnverified && (
          <Badge className="bg-warning/20 text-warning">Costs partially unverified</Badge>
        )}
      </div>
      {vStr(net, "reason") && (
        <p className="mt-1 text-muted-foreground">{vStr(net, "reason")}</p>
      )}
      {(netBlockers.length > 0 || netWarnings.length > 0) && (
        <p className="mt-1 text-[11px] text-warning">
          {[...netBlockers, ...netWarnings].join(" · ")}
        </p>
      )}

      {expo && (
        <div className="mt-2" data-testid="exposure-verdict">
          <Badge
            className={expoAllowed === false ? "bg-danger/20 text-danger" : "bg-success/15 text-success"}
          >
            {expoAllowed === false ? "Exposure blocked" : "Exposure OK"}
          </Badge>
          {vStr(expo, "reason") && (
            <span className="ml-2 text-muted-foreground">{vStr(expo, "reason")}</span>
          )}
          {expoBlockers.length > 0 && (
            <p className="mt-1 text-[11px] text-warning">{expoBlockers.join(" · ")}</p>
          )}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Advisory pre-check only — it can block or downgrade a setup, never improve it
        or bypass the full safety pipeline.
      </p>
    </div>
  );
}

// Broker/feed execution-health banner driven by the pulse. Analyze is always
// allowed; only execution can be paused.
function ExecutionHealthBanner({ health }: { health: MissionExecutionHealth }) {
  if (health.executionAllowed && health.warnings.length === 0) return null;
  return (
    <CompactAlert
      tone={health.executionAllowed ? "warning" : "danger"}
      testId="alert-execution-health"
      title={
        health.executionAllowed
          ? "Execution health warning"
          : "Execution paused by broker/feed health"
      }
      description={
        (health.reason || "Broker/feed conditions are not safe for execution right now.") +
        " Analysis and watching stay available."
      }
    />
  );
}

// Aggregate open-exposure panel driven by the pulse (per-user).
function ExposureSummary({ exposure }: { exposure: MissionExposureAggregates }) {
  const classes = Object.keys(exposure.riskByAssetClass ?? {});
  return (
    <div className="rounded-md border border-border p-3" data-testid="exposure-summary">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Layers className="h-4 w-4" /> Open exposure
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Open trades" value={String(exposure.openCount)} testId="metric-open-count" />
        <Metric
          label="Open risk"
          value={money(exposure.totalOpenRisk)}
          testId="metric-open-risk"
        />
      </div>
      {classes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="list-exposure-classes">
          {classes.map((c) => (
            <li key={c} className="flex items-center justify-between">
              <span>{c}</span>
              <span>
                {exposure.countByAssetClass?.[c] ?? 0} · {money(exposure.riskByAssetClass[c] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Your live positions only. Used to block duplicate, correlated, or
        over-concentrated risk before a new trade.
      </p>
    </div>
  );
}

// ── Profit Protection: milestones / locked profit / ladder / compounding ─────
// Display-only. Composed server-side from REALISED CLOSED profit only (never
// floating). The protection ladder can only tighten risk after milestones /
// giveback; compounding never boosts during drawdown or after a single win.
function ProtectionPanel({ protection }: { protection: MissionProtectionSnapshot }) {
  const m = protection.milestone;
  const c = protection.compounding;
  return (
    <div className="rounded-md border border-border p-3" data-testid="protection-panel">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4" /> Profit Protection
        {m.milestone > 0 && (
          <Badge className="bg-success/20 text-success" data-testid="badge-milestone">
            {m.milestone}% milestone
          </Badge>
        )}
        {protection.missionCompleted && (
          <Badge className="bg-success/20 text-success" data-testid="badge-mission-locked">
            Target locked
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Locked profit" value={money(m.lockedProfit)} testId="metric-locked-profit" />
        <Metric label="Realised profit" value={money(m.realisedProfit)} testId="metric-realised-profit" />
        <Metric label="Peak realised" value={money(m.peakRealisedProfit)} testId="metric-peak-realised" />
        <Metric label="Min setup tier" value={m.minSetupTier} testId="metric-min-tier" />
      </div>
      {m.stopAndLock && (
        <CompactAlert
          tone="success"
          title="Target reached — default is to stop and lock the profit. Continuing trades at reduced risk."
          testId="alert-stop-lock"
        />
      )}
      {m.givebackTriggered && (
        <CompactAlert
          tone="warning"
          title="Giveback guard fired — profit handed back from the peak. Protect mode + reduced risk."
          testId="alert-giveback"
        />
      )}
      {m.dailyGoalReached && (
        <CompactAlert
          tone="success"
          title="Today's profit goal reached — locking/protecting for the day."
          testId="alert-daily-goal"
        />
      )}
      {m.reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="list-protection-reasons">
          {m.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 rounded-md border border-border/60 p-2" data-testid="compounding-state">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="font-medium">Controlled compounding</span>
          <Badge
            className={c.active ? "bg-success/20 text-success" : "bg-muted text-muted-foreground"}
            data-testid="badge-compounding-active"
          >
            {c.active ? `Active · ${c.multiplier.toFixed(2)}×` : `Off · ${c.mode}`}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <span>Reinvestible: {money(c.reinvestibleProfit)}</span>
          <span>Closed trades: {c.realisedTradeCount}</span>
          <span>Drawdown: {c.drawdownPct != null ? `${c.drawdownPct.toFixed(1)}%` : "—"}</span>
          <span>Governor: {c.governorMode}</span>
        </div>
        {c.blockers.length > 0 && (
          <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground" data-testid="list-compounding-blockers">
            {c.blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" /> {b}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Reinvests realised closed profit only — never floating P/L, never during
          drawdown, and never after a single win.
        </p>
      </div>
    </div>
  );
}

// ── Opportunity Queue: risk-adjusted ranking (best + ordered alternatives) ───
function OpportunityQueuePanel({ queue }: { queue: OpportunityQueue }) {
  const waiting = queue.decision === "wait";
  return (
    <Card data-testid="card-opportunity-queue">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListOrdered className="h-4 w-4" /> Opportunity Queue
        </CardTitle>
        <CardDescription>
          Setups ranked by risk-adjusted mission fit — not raw confidence. The
          agents wait when nothing clears the bar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {waiting ? (
          <CompactAlert
            tone="warning"
            testId="alert-queue-wait"
            title="Holding for a better setup"
            description={
              queue.waitReason ??
              "No A or B-tier opportunity right now. Waiting protects the mission from low-quality trades."
            }
          />
        ) : (
          <CompactAlert
            tone="info"
            testId="alert-queue-act"
            title="Top opportunity identified"
            description={
              queue.best
                ? `${queue.best.symbol} ${queue.best.timeframe} ranks first by mission fit.`
                : "A ranked opportunity is available."
            }
          />
        )}
        {queue.queue.length > 0 && (
          <ul className="space-y-2" data-testid="list-queue">
            {queue.queue.map((q) => (
              <QueueEntryRow key={q.proposalId} q={q} isBest={q.proposalId === queue.best?.proposalId} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function QueueEntryRow({ q, isBest }: { q: OpportunityQueueEntry; isBest: boolean }) {
  const dir = directionMeta(q.direction);
  return (
    <li
      className={`rounded-md border p-2 ${isBest ? "border-success/50 bg-success/5" : "border-border"}`}
      data-testid={`queue-entry-${q.proposalId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{q.rank}</span>
          <dir.Icon className={`h-4 w-4 ${dir.cls}`} />
          <span className="font-medium">{q.symbol}</span>
          <span className="text-xs text-muted-foreground">{q.timeframe}</span>
        </div>
        <div className="flex items-center gap-2">
          {edgeTierBadge(q.edgeTier)}
          {!q.actionable && (
            <Badge className="bg-muted text-muted-foreground">Watch</Badge>
          )}
        </div>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-muted-foreground sm:grid-cols-3">
        <div>Mission fit {Math.round(q.missionFit)}</div>
        <div>Risk-adj. {Math.round(q.riskAdjustedScore)}</div>
        <div>Opp. cost {Math.round(q.opportunityCost)}</div>
      </div>
      {q.reasons.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">{q.reasons.join(" · ")}</p>
      )}
    </li>
  );
}

// ── A single trade draft (reviewable / approvable) ───────────────────────────
function TradeDraftRow({ draft, missionId }: { draft: TradeDraft; missionId: number }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const dir = directionMeta(draft.direction);
  const sMeta =
    DRAFT_STATUS_META[draft.effectiveStatus] ?? {
      label: draft.effectiveStatus,
      cls: "bg-muted text-muted-foreground",
    };

  function refresh() {
    queryClient.invalidateQueries({
      queryKey: getListMissionTradeDraftsQueryKey(missionId, { limit: 50, offset: 0 }),
    });
    queryClient.invalidateQueries({
      queryKey: getListProfitMissionEventsQueryKey(missionId, { limit: 100, offset: 0 }),
    });
  }
  function onError(e: unknown) {
    const msg =
      e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Action failed";
    setError(msg);
  }

  const approve = useApproveMissionProposalDraft({
    mutation: { onSuccess: () => { setError(null); refresh(); }, onError },
  });
  const reject = useRejectMissionProposalDraft({
    mutation: { onSuccess: () => { setError(null); refresh(); }, onError },
  });
  const execute = useExecuteMissionProposalDraft({
    mutation: { onSuccess: () => { setError(null); refresh(); }, onError },
  });
  const [exitResult, setExitResult] = useState<MissionExitActionResult | null>(null);
  const manageExit = useManageMissionTradeExit({
    mutation: {
      onSuccess: (r: MissionExitActionResult) => {
        setError(null);
        setExitResult(r);
        refresh();
      },
      onError,
    },
  });

  const pending = approve.isPending || reject.isPending || execute.isPending || manageExit.isPending;
  const isOpen =
    draft.effectiveStatus === "proposed" || draft.effectiveStatus === "waiting_confirmation";

  return (
    <li className="rounded-md border border-border p-3" data-testid={`draft-${draft.proposalId}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <dir.Icon className={`h-4 w-4 ${dir.cls}`} />
          <span className="font-medium">{draft.symbol}</span>
          <span className="text-xs text-muted-foreground">{draft.timeframe}</span>
          <span className={`text-xs ${dir.cls}`}>{dir.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {edgeTierBadge(draft.edgeTier)}
          <Badge className={sMeta.cls} data-testid={`draft-status-${draft.proposalId}`}>
            {sMeta.label}
          </Badge>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <span className="text-muted-foreground">Entry</span>
          <div>{fmtPrice(draft.entryPrice ?? null)}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Stop / Target</span>
          <div>
            {fmtPrice(draft.stopLoss ?? null)} / {fmtPrice(draft.takeProfit ?? null)}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Lot / Risk</span>
          <div>
            {draft.lot ?? "—"} / {draft.riskAmount != null ? money(draft.riskAmount) : "—"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Expected R</span>
          <div>{draft.expectedR != null ? draft.expectedR.toFixed(2) : "—"}</div>
        </div>
      </div>
      {draft.reason && <p className="mt-2 text-xs text-muted-foreground">{draft.reason}</p>}
      {draft.missionImpact && (
        <div className="mt-3">
          <MissionImpactPreview impact={draft.missionImpact} />
        </div>
      )}
      {error && (
        <div className="mt-2">
          <CompactAlert tone="danger" title={error} testId={`alert-draft-error-${draft.proposalId}`} />
        </div>
      )}
      {isOpen ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => approve.mutate({ id: missionId, proposalId: draft.proposalId, data: {} })}
            disabled={pending}
            data-testid={`button-approve-${draft.proposalId}`}
          >
            {approve.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
            )}
            Approve draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reject.mutate({ id: missionId, proposalId: draft.proposalId, data: {} })}
            disabled={pending}
            data-testid={`button-reject-${draft.proposalId}`}
          >
            {reject.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="mr-1.5 h-4 w-4" />
            )}
            Reject
          </Button>
        </div>
      ) : draft.effectiveStatus === "approved" ? (
        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-success" data-testid={`draft-approved-note-${draft.proposalId}`}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Approved for review.
          </p>
          <Button
            size="sm"
            onClick={() => execute.mutate({ id: missionId, proposalId: draft.proposalId })}
            disabled={pending}
            data-testid={`button-execute-${draft.proposalId}`}
          >
            {execute.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-1.5 h-4 w-4" />
            )}
            Execute (live only)
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Execution routes only through the standard instant-trade pipeline and
            the full 23-gate safety check. Demo and paper missions never contact the
            live broker.
          </p>
        </div>
      ) : draft.effectiveStatus === "executed" ? (
        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-success" data-testid={`draft-executed-note-${draft.proposalId}`}>
            <Rocket className="h-3.5 w-3.5" /> Dispatched to execution.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => manageExit.mutate({ id: missionId, draftId: draft.draftId, data: {} })}
            disabled={pending}
            data-testid={`button-manage-exit-${draft.proposalId}`}
          >
            {manageExit.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="mr-1.5 h-4 w-4" />
            )}
            Manage protective exit
          </Button>
          {exitResult && (
            <div className="rounded-md border border-border p-2 text-xs" data-testid={`exit-result-${draft.proposalId}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{exitResult.decision.action.replace(/_/g, " ")}</span>
                <Badge
                  className={exitResult.dispatched ? "bg-success/20 text-success" : "bg-muted text-muted-foreground"}
                  data-testid={`exit-dispatched-${draft.proposalId}`}
                >
                  {exitResult.dispatched ? "Routed to executor" : "No action"}
                </Badge>
              </div>
              {exitResult.decision.reasons.length > 0 && (
                <ul className="mt-1.5 space-y-1 text-muted-foreground">
                  {exitResult.decision.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {exitResult.decision.warnings.length > 0 && (
                <ul className="mt-1.5 space-y-1 text-warning">
                  {exitResult.decision.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Protective exits (partial close, break-even, trailing stop, structure /
            news / target close) route only through the standard instant-trade
            pipeline and the full 23-gate safety check.
          </p>
        </div>
      ) : draft.effectiveStatus === "expired" ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> This draft expired before review.
        </p>
      ) : null}
    </li>
  );
}

// ── Trade Drafts panel: reviewable / approvable drafts (approval mode) ───────
function TradeDraftsPanel({ missionId }: { missionId: number }) {
  const { data: drafts, isLoading } = useListMissionTradeDrafts(missionId, {
    limit: 50,
    offset: 0,
  });
  return (
    <Card data-testid="card-trade-drafts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" /> Trade Drafts
        </CardTitle>
        <CardDescription>
          Reviewable drafts built from the best-debated setup. Approving records
          your decision and journals it — it does not place any order.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading drafts…</p>
        ) : !drafts || drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-drafts">
            No drafts yet. Run the agents — a draft is prepared from the best setup
            they agree on.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="list-drafts">
            {drafts.map((d: TradeDraft) => (
              <TradeDraftRow key={d.id} draft={d} missionId={missionId} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── War Room: run the agents (advisory scan) + read their proposals ──────────
function MissionWarRoom({ missionId }: { missionId: number }) {
  const queryClient = useQueryClient();
  const { data: proposals, isLoading } = useListMissionProposals(missionId, {
    limit: 50,
    offset: 0,
  });
  const scan = useRunMissionScan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListMissionProposalsQueryKey(missionId, { limit: 50, offset: 0 }),
        });
        queryClient.invalidateQueries({
          queryKey: getListMissionAgentsQueryKey(missionId),
        });
        queryClient.invalidateQueries({
          queryKey: getListMissionTradeDraftsQueryKey(missionId, { limit: 50, offset: 0 }),
        });
      },
    },
  });

  const result: MissionScanResult | undefined = scan.data;

  return (
    <div className="space-y-4">
      <MissionAgentDesk missionId={missionId} />
      <Card data-testid="card-proposals">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Radar className="h-4 w-4" /> Proposals
              </CardTitle>
              <CardDescription>
                Read-only setups scouted by your agents. No trade is placed.
              </CardDescription>
            </div>
            <Button
              onClick={() => scan.mutate({ id: missionId })}
              disabled={scan.isPending}
              data-testid="button-run-scan"
            >
              {scan.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Scanning…
                </>
              ) : (
                "Run agents"
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {result && (
            <CompactAlert
              tone={result.liveFeedConnected ? "info" : "warning"}
              testId="alert-scan-result"
              title={
                result.liveFeedConnected
                  ? result.judgeDecision === "best"
                    ? `Agents scanned ${result.symbolsScanned} market(s). ${result.judgeReason}`
                    : `Agents scanned ${result.symbolsScanned} market(s) — no edge worth taking. ${result.judgeReason}`
                  : `No live feed right now, so the agents have nothing honest to act on. ${result.judgeReason}`
              }
            />
          )}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading proposals…</p>
          ) : !proposals || proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-proposals">
              No proposals yet. Run the agents to scout current setups.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="list-proposals">
              {proposals.map((p: MissionProposal) => (
                <ProposalRow key={p.id} p={p} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {result?.queue && <OpportunityQueuePanel queue={result.queue} />}
      <MissionRiskPanel missionId={missionId} />
      <TradeDraftsPanel missionId={missionId} />
    </div>
  );
}

// ── Phase 6 Risk Control: protective mode, drawdown, blow-up + emergency stop ─
const RISK_MODE_META: Record<string, { label: string; cls: string }> = {
  attack: { label: "Attack", cls: "bg-success/20 text-success" },
  normal: { label: "Normal", cls: "bg-muted text-foreground" },
  protect: { label: "Protect", cls: "bg-warning/20 text-warning" },
  recovery: { label: "Recovery", cls: "bg-warning/20 text-warning" },
  cooldown: { label: "Cooldown", cls: "bg-warning/20 text-warning" },
  stop: { label: "Stopped", cls: "bg-danger/20 text-danger" },
};

const BLOWUP_META: Record<string, { label: string; cls: string }> = {
  low: { label: "Low", cls: "bg-success/20 text-success" },
  medium: { label: "Medium", cls: "bg-warning/20 text-warning" },
  high: { label: "High", cls: "bg-danger/20 text-danger" },
  critical: { label: "Critical", cls: "bg-danger/30 text-danger" },
};

function Meter({
  label,
  pct,
  testId,
  danger,
}: {
  label: string;
  pct: number;
  testId?: string;
  danger?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const barCls = danger || clamped >= 80 ? "bg-danger" : clamped >= 50 ? "bg-warning" : "bg-success";
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span data-testid={testId ? `${testId}-value` : undefined}>{clamped}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${barCls}`} style={{ width: `${clamped}%` }} data-testid={testId} />
      </div>
    </div>
  );
}

function MissionRiskPanel({ missionId }: { missionId: number }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: pulse, isLoading } = useGetProfitMissionPulse(missionId, {
    query: {
      queryKey: getGetProfitMissionPulseQueryKey(missionId),
      refetchInterval: 15000,
    },
  });
  const emergencyStop = useEmergencyStopProfitMission({
    mutation: {
      onSuccess: () => {
        setError(null);
        queryClient.invalidateQueries({ queryKey: getGetProfitMissionPulseQueryKey(missionId) });
        queryClient.invalidateQueries({ queryKey: getListProfitMissionsQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getListProfitMissionEventsQueryKey(missionId, { limit: 100, offset: 0 }),
        });
      },
      onError: (e: unknown) => {
        setError(
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : "Emergency stop failed",
        );
      },
    },
  });

  const risk: ProfitMissionRiskState | null = pulse?.risk ?? null;
  const executionHealth: MissionExecutionHealth | null = pulse?.executionHealth ?? null;
  const exposure: MissionExposureAggregates | null = pulse?.exposure ?? null;
  const protection: MissionProtectionSnapshot | null = pulse?.protection ?? null;

  return (
    <Card data-testid="card-risk-control">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> Risk Control
          {risk && (
            <Badge
              className={RISK_MODE_META[risk.mode]?.cls ?? "bg-muted"}
              data-testid="badge-risk-mode"
            >
              {RISK_MODE_META[risk.mode]?.label ?? risk.mode}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Hard, stricter-only protection layered over your Risk Governor. These
          limits can only tighten — never loosen — your account's safety rules.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading risk read…</p>
        ) : !risk ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-risk">
            No risk read available yet.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Metric
                label="Blow-up risk"
                value={BLOWUP_META[risk.blowup.level]?.label ?? risk.blowup.level}
                testId="metric-blowup-level"
              />
              <Metric
                label="Risk multiplier"
                value={`${risk.riskMultiplier.toFixed(2)}×`}
                testId="metric-risk-multiplier"
              />
              <Metric
                label="Consecutive losses"
                value={String(risk.consecutiveLosses)}
                testId="metric-consecutive-losses"
              />
              <Metric label="Trades today" value={String(risk.tradesToday)} testId="metric-trades-today" />
            </div>
            <div className="space-y-3">
              <Meter
                label="Mission drawdown"
                pct={risk.drawdownPct}
                testId="meter-drawdown"
                danger={risk.mode === "stop"}
              />
              <Meter label="Daily budget used" pct={risk.budgetUsedPct} testId="meter-budget-used" />
            </div>
            {risk.behavioral.cooldownTriggered && (
              <CompactAlert
                tone="warning"
                title="Cooldown active — new entries are paused to protect the mission."
                testId="alert-cooldown"
              />
            )}
            {risk.emergency.triggered && (
              <CompactAlert
                tone="danger"
                title={`Emergency condition: ${risk.emergency.primary ?? "risk limit breached"}.`}
                testId="alert-emergency"
              />
            )}
            {risk.reasons.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground" data-testid="list-risk-reasons">
                {risk.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r}
                  </li>
                ))}
              </ul>
            )}
            {!risk.budget.martingaleAllowed && (
              <p className="text-[11px] text-muted-foreground" data-testid="text-no-martingale">
                Martingale is disabled — trade size never increases after a loss.
              </p>
            )}
          </>
        )}
        {executionHealth && <ExecutionHealthBanner health={executionHealth} />}
        {exposure && <ExposureSummary exposure={exposure} />}
        {protection && <ProtectionPanel protection={protection} />}
        {error && <CompactAlert tone="danger" title={error} testId="alert-risk-error" />}
        <div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => emergencyStop.mutate({ id: missionId, data: {} })}
            disabled={emergencyStop.isPending}
            data-testid="button-emergency-stop"
          >
            {emergencyStop.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <OctagonAlert className="mr-1.5 h-4 w-4" />
            )}
            Emergency stop
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Immediately pauses the mission and records the stop. Does not place or
            close any order.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Phase 9 — Testing Lab + promotion + certificate + briefing ──────────────
//
// Honest labelling everywhere: BACKTEST results are historical/simulated, FORWARD
// results are real realised outcomes; small samples are flagged. Promotion is
// fail-closed and live auto is opt-in + LAST. Nothing here places a trade —
// applying an automation level only records intent; live dispatch still goes
// through the platform's existing gates.

const AUTOMATION_LABELS: Record<number, string> = {
  0: "Off",
  1: "Advisory",
  2: "Approval (default)",
  3: "Demo auto",
  4: "Micro live",
  5: "Limited live auto",
  6: "Full live auto",
};

function readNum(o: Record<string, unknown> | null | undefined, k: string): number | null {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readStr(o: Record<string, unknown> | null | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" ? v : null;
}

function errMessage(e: unknown, fallback: string): string {
  return e && typeof e === "object" && "message" in e
    ? String((e as { message: unknown }).message)
    : fallback;
}

function MissionTestResultRow({ r }: { r: MissionTestResult }): ReactElement {
  const m = r.metrics;
  return (
    <li className="space-y-1 py-3" data-testid={`test-result-${r.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Badge
            className={
              r.kind === "FORWARD"
                ? "bg-info/20 text-info"
                : "bg-muted text-muted-foreground"
            }
          >
            {r.label}
          </Badge>
          {r.strategyKey} · {r.symbol} · {r.timeframe}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(r.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{r.headline}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Trades: {m.totalTrades}</span>
        <span>Win rate: {(m.winRate * 100).toFixed(1)}%</span>
        <span>Expectancy: {m.expectancyR.toFixed(2)}R</span>
        <span>Max DD: {m.maxDrawdownPct.toFixed(1)}%</span>
        <span>Net P/L: {m.netProfitLoss.toFixed(2)}</span>
      </div>
      {r.sampleWarning && (
        <p className="text-xs text-warning" data-testid={`test-sample-warning-${r.id}`}>
          {r.sampleWarning}
        </p>
      )}
    </li>
  );
}

function MissionTestingLab({ mission }: { mission: ProfitMission }): ReactElement {
  const missionId = mission.id;
  const qc = useQueryClient();
  const [strategyId, setStrategyId] = useState("flame_scalp");
  const [symbol, setSymbol] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("M15");
  const [targetLevel, setTargetLevel] = useState<number>(mission.automationLevel ?? 2);
  const [enableLiveAuto, setEnableLiveAuto] = useState(false);
  const [certOpen, setCertOpen] = useState(false);
  const [certConfirmed, setCertConfirmed] = useState(false);
  const [certPhrase, setCertPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListMissionTestResultsQueryKey(missionId) });
    qc.invalidateQueries({ queryKey: getGetMissionDriftQueryKey(missionId) });
    qc.invalidateQueries({ queryKey: getGetMissionPromotionQueryKey(missionId) });
    qc.invalidateQueries({ queryKey: getListProfitMissionsQueryKey() });
  };

  const { data: testing } = useListMissionTestResults(missionId, undefined, {
    query: { queryKey: getListMissionTestResultsQueryKey(missionId) },
  });
  const { data: drift } = useGetMissionDrift(missionId, {
    query: { queryKey: getGetMissionDriftQueryKey(missionId) },
  });
  const { data: promotion } = useGetMissionPromotion(missionId, undefined, {
    query: { queryKey: getGetMissionPromotionQueryKey(missionId) },
  });
  const { data: certificate } = useGetMissionCertificate(missionId, undefined, {
    query: { queryKey: getGetMissionCertificateQueryKey(missionId) },
  });
  const { data: briefing } = useGetMissionBriefing(missionId);
  const { data: eod } = useGetMissionEodReview(missionId);
  const { data: report } = useGetMissionReport(missionId);

  const backtest = useRunMissionBacktest({
    mutation: {
      onSuccess: () => { setError(null); invalidate(); },
      onError: (e) => setError(errMessage(e, "Backtest failed")),
    },
  });
  const forward = useAggregateMissionForward({
    mutation: {
      onSuccess: () => { setError(null); invalidate(); },
      onError: (e) => setError(errMessage(e, "Forward aggregation failed")),
    },
  });
  const applyLevel = useApplyMissionAutomationLevel({
    mutation: {
      onSuccess: () => { setError(null); invalidate(); },
      onError: (e) => setError(errMessage(e, "Could not apply automation level")),
    },
  });
  const acceptCert = useAcceptMissionCertificate({
    mutation: {
      onSuccess: () => {
        setError(null);
        setCertOpen(false);
        setCertConfirmed(false);
        setCertPhrase("");
        qc.invalidateQueries({ queryKey: getGetMissionCertificateQueryKey(missionId) });
        qc.invalidateQueries({ queryKey: getGetMissionPromotionQueryKey(missionId) });
        qc.invalidateQueries({ queryKey: getListProfitMissionsQueryKey() });
      },
      onError: (e) => setError(errMessage(e, "Certificate not accepted")),
    },
  });

  const results = testing?.results ?? [];
  const decisionObj = (promotion?.decision && typeof promotion.decision === "object"
    ? promotion.decision
    : {}) as Record<string, unknown>;
  const allowedMaxLevel = readNum(decisionObj, "allowedMaxLevel");
  const gatesRaw = decisionObj.gates;
  const gates: Record<string, unknown>[] = Array.isArray(gatesRaw)
    ? gatesRaw.filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    : [];
  const guardrail = promotion?.guardrail as Record<string, unknown> | undefined;
  const driftObj = drift?.drift as Record<string, unknown> | undefined;
  const certContent = certificate as Record<string, unknown> | undefined;
  const certPhraseRequired = readStr(certContent, "phrase") ?? "";
  const summaryLines = Array.isArray(certContent?.summaryLines)
    ? (certContent!.summaryLines as string[])
    : [];
  const acknowledgements = Array.isArray(certContent?.acknowledgements)
    ? (certContent!.acknowledgements as string[])
    : [];

  const wantsLiveAuto = targetLevel >= 4;
  const phraseMatches = certPhrase.trim() === certPhraseRequired.trim() && certPhraseRequired !== "";

  return (
    <div className="space-y-4" data-testid="mission-testing-lab">
      {error && <CompactAlert tone="danger" title={error} testId="alert-testing-lab-error" />}

      {/* Testing Lab */}
      <Card data-testid="card-testing-lab">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" /> Testing Lab
          </CardTitle>
          <CardDescription>
            Backtest results are historical and simulated; forward results are your
            mission's real, closed trades. Results are estimates — they never grant
            live permission or bypass any safety gate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="bt-strategy">Strategy</Label>
              <Input
                id="bt-strategy"
                value={strategyId}
                onChange={(e) => setStrategyId(e.target.value)}
                data-testid="input-backtest-strategy"
              />
            </div>
            <div>
              <Label htmlFor="bt-symbol">Symbol</Label>
              <Input
                id="bt-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                data-testid="input-backtest-symbol"
              />
            </div>
            <div>
              <Label htmlFor="bt-timeframe">Timeframe</Label>
              <Input
                id="bt-timeframe"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                data-testid="input-backtest-timeframe"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                backtest.mutate({ id: missionId, data: { strategyId, symbol, timeframe } })
              }
              disabled={backtest.isPending}
              data-testid="button-run-backtest"
            >
              {backtest.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <TrendingUp className="mr-2 h-4 w-4" />
              )}
              Run backtest
            </Button>
            <Button
              variant="outline"
              onClick={() => forward.mutate({ id: missionId, data: {} })}
              disabled={forward.isPending}
              data-testid="button-aggregate-forward"
            >
              {forward.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Layers className="mr-2 h-4 w-4" />
              )}
              Aggregate forward (real trades)
            </Button>
          </div>

          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-test-results">
              No test results yet. Run a backtest, or aggregate forward results from
              your mission's closed trades.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <MissionTestResultRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Strategy drift */}
      <Card data-testid="card-mission-drift">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4" /> Strategy drift
          </CardTitle>
          <CardDescription>
            Compares your forward (real) results against the backtest baseline. Severe
            drift automatically demotes the mission, reduces risk, and pauses promotion.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {drift?.insufficientEvidence ? (
            <p className="text-sm text-muted-foreground" data-testid="text-drift-unknown">
              Not enough evidence yet — run a backtest and gather real forward trades for
              an honest comparison.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge data-testid="badge-drift-severity">
                {readStr(driftObj, "severity") ?? "UNKNOWN"}
              </Badge>
              {drift?.demoted && (
                <span className="text-warning" data-testid="text-drift-demoted">
                  Mission demoted
                </span>
              )}
              {drift?.promotionPaused && (
                <span className="text-warning" data-testid="text-drift-paused">
                  Promotion paused
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Promotion gate + automation level */}
      <Card data-testid="card-promotion">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4" /> Automation &amp; promotion
          </CardTitle>
          <CardDescription>
            Every gate must pass before a level is allowed. Live automation (level 4+)
            is opt-in and still routes through the platform's existing live safety gates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              Current level:{" "}
              <span className="font-medium" data-testid="text-current-level">
                {AUTOMATION_LABELS[promotion?.currentLevel ?? mission.automationLevel ?? 2]}
              </span>
            </span>
            {promotion && allowedMaxLevel != null && (
              <span className="text-xs text-muted-foreground" data-testid="text-allowed-max-level">
                Highest currently allowed: {AUTOMATION_LABELS[allowedMaxLevel] ?? allowedMaxLevel}
              </span>
            )}
            {readNum(guardrail, "maxLevel") != null && (
              <Badge className="bg-muted text-muted-foreground" data-testid="badge-guardrail">
                Guardrail ceiling: {AUTOMATION_LABELS[readNum(guardrail, "maxLevel")!]}
              </Badge>
            )}
          </div>

          {gates.length > 0 && (
            <ul className="space-y-1" data-testid="list-promotion-gates">
              {gates.map((g, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  {g.passed === true ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 text-danger" />
                  )}
                  <span>
                    <span className="font-medium">{readStr(g, "name") ?? "Gate"}</span>
                    <span className="ml-2 text-muted-foreground">{readStr(g, "detail") ?? ""}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Closes a dead end: missionPromotionService refuses an automation
              INCREASE with "requires an active owner-pressed authority grant",
              and the grant is created by POST /api/me/authority/grants — a
              call no screen made until /authority shipped. Without this link
              the documented blocker told the user to do something with no
              destination. */}
          {(
            gates.some((g) =>
              `${readStr(g, "name") ?? ""} ${readStr(g, "detail") ?? ""}`.includes("authority_grant"),
            ) || (error ?? "").includes("authority")
          ) && (
            <div
              className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm"
              data-testid="authority-grant-blocker-link"
            >
              Raising automation above the baseline needs an active owner-pressed authority grant on your
              account.{" "}
              <a href="/authority" className="font-medium underline">
                Open Automation Authority
              </a>{" "}
              to press one, then apply the level again. A grant only permits the raise — every safety gate
              still runs.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Target automation level</Label>
              <Select
                value={String(targetLevel)}
                onValueChange={(v) => setTargetLevel(Number(v))}
              >
                <SelectTrigger data-testid="select-automation-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4, 5, 6].map((lvl) => (
                    <SelectItem key={lvl} value={String(lvl)}>
                      {lvl} · {AUTOMATION_LABELS[lvl]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {wantsLiveAuto && (
              <label className="flex items-end gap-2 text-sm" htmlFor="enable-live-auto">
                <input
                  id="enable-live-auto"
                  type="checkbox"
                  checked={enableLiveAuto}
                  onChange={(e) => setEnableLiveAuto(e.target.checked)}
                  data-testid="checkbox-enable-live-auto"
                />
                <span>
                  I explicitly want live automation enabled (still gated by every live
                  safety check).
                </span>
              </label>
            )}
          </div>

          <Button
            onClick={() =>
              applyLevel.mutate({
                id: missionId,
                data: { level: targetLevel, enableLiveAuto: wantsLiveAuto ? enableLiveAuto : false },
              })
            }
            disabled={applyLevel.isPending}
            data-testid="button-apply-level"
          >
            {applyLevel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Apply level
          </Button>
        </CardContent>
      </Card>

      {/* Mission Risk Certificate */}
      <Card data-testid="card-certificate">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Flag className="h-4 w-4" /> Mission Risk Certificate
          </CardTitle>
          <CardDescription>
            Required before live automation. You must explicitly acknowledge that
            results are not guaranteed and losses are possible.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm" data-testid="text-cert-status">
            {promotion?.certificateAccepted ? (
              <span className="text-success">Certificate accepted.</span>
            ) : (
              <span className="text-muted-foreground">Not yet accepted.</span>
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => setCertOpen(true)}
            data-testid="button-open-certificate"
          >
            Review certificate
          </Button>
        </CardContent>
      </Card>

      <Dialog open={certOpen} onOpenChange={setCertOpen}>
        <DialogContent data-testid="dialog-certificate">
          <DialogHeader>
            <DialogTitle>{readStr(certContent, "title") ?? "Mission Risk Certificate"}</DialogTitle>
            <DialogDescription>
              Read carefully. This is a goal, not a promise.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {summaryLines.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {summaryLines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            {acknowledgements.length > 0 && (
              <ul className="list-disc space-y-1 pl-5">
                {acknowledgements.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Type the exact phrase to confirm:
              </p>
              <p className="font-mono text-xs">{certPhraseRequired}</p>
              <Input
                value={certPhrase}
                onChange={(e) => setCertPhrase(e.target.value)}
                placeholder="Type the confirmation phrase"
                data-testid="input-cert-phrase"
              />
              <label className="flex items-center gap-2 text-sm" htmlFor="cert-confirm">
                <input
                  id="cert-confirm"
                  type="checkbox"
                  checked={certConfirmed}
                  onChange={(e) => setCertConfirmed(e.target.checked)}
                  data-testid="checkbox-cert-confirm"
                />
                <span>I understand and confirm.</span>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() =>
                acceptCert.mutate({
                  id: missionId,
                  data: {
                    confirmed: certConfirmed,
                    phrase: certPhrase.trim(),
                    targetAutomationLevel: targetLevel,
                  },
                })
              }
              disabled={!certConfirmed || !phraseMatches || acceptCert.isPending}
              data-testid="button-accept-certificate"
            >
              {acceptCert.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Accept certificate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Briefings + report */}
      <Card data-testid="card-briefing">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListOrdered className="h-4 w-4" /> Briefings &amp; report
          </CardTitle>
          <CardDescription>
            Honest summaries from your mission state and closed trades — no guarantees.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <MissionTextBlock title="Daily briefing" obj={briefing} testId="block-briefing" />
          <MissionTextBlock title="End-of-day review" obj={eod} testId="block-eod" />
          <MissionTextBlock title="Mission report" obj={report?.report} testId="block-report" />
        </CardContent>
      </Card>
    </div>
  );
}

// Render an advisory text blob honestly: prefer a headline + a list of lines/notes,
// falling back to nothing rather than fabricating structure.
function MissionTextBlock({
  title,
  obj,
  testId,
}: {
  title: string;
  obj: unknown;
  testId: string;
}): ReactElement {
  const rec = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const headline = readStr(rec, "headline") ?? readStr(rec, "summary");
  const linesRaw = rec.lines ?? rec.notes ?? rec.highlights;
  const lines = Array.isArray(linesRaw) ? linesRaw.filter((x) => typeof x === "string") : [];
  return (
    <div data-testid={testId}>
      <p className="font-medium">{title}</p>
      {headline ? (
        <p className="text-muted-foreground">{headline}</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground">No data yet.</p>
      ) : null}
      {lines.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {(lines as string[]).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProfitMissionsPage() {
  const { data: missions, isLoading } = useListProfitMissions();
  const [activeId, setActiveId] = useState<number | null>(null);

  // Derive the selected mission from the FRESH list by id, so lifecycle
  // mutations (which invalidate the list) always re-render current status +
  // state-aware controls instead of a stale snapshot held in component state.
  const selected = useMemo<ProfitMission | null>(() => {
    if (!missions || missions.length === 0) return null;
    if (activeId != null) {
      return missions.find((m) => m.id === activeId) ?? missions[0];
    }
    return missions[0];
  }, [activeId, missions]);

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="page-profit-missions">
      <div>
        <h1 className="text-2xl font-bold">Profit Mission</h1>
        <p className="text-sm text-muted-foreground">
          Describe a goal and get an honest feasibility and probability read.
          Trades dispatch only through the gated approval path: the default
          level waits for your approval on every trade, and auto levels must be
          earned, explicitly enabled, and re-checked against every live gate at
          each dispatch. A blocked gate holds the mission — it never trades
          around a refusal.
        </p>
      </div>

      <BattleRoomShell mission={selected} />

      <PageTabs
        tabs={[
          {
            id: "plan",
            label: "Plan a mission",
            content: (
              <div className="space-y-4">
                <CreateMissionForm onCreated={(m) => setActiveId(m.id)} />
              </div>
            ),
          },
          {
            id: "war-room",
            label: "War Room",
            content: selected ? (
              <MissionWarRoom missionId={selected.id} />
            ) : (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground" data-testid="text-warroom-empty">
                    Select or create a mission to see its agents and proposals.
                  </p>
                </CardContent>
              </Card>
            ),
          },
          {
            id: "performance",
            label: "Performance",
            content: selected ? (
              <MissionPerformanceView missionId={selected.id} />
            ) : (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground" data-testid="text-performance-empty">
                    Select or create a mission to see its strategy performance over time.
                  </p>
                </CardContent>
              </Card>
            ),
          },
          {
            id: "journal",
            label: "Mission Journal",
            content: selected ? (
              <MissionJournal missionId={selected.id} />
            ) : (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground" data-testid="text-journal-empty">
                    Select or create a mission to see its journal.
                  </p>
                </CardContent>
              </Card>
            ),
          },
          {
            id: "testing-lab",
            label: "Testing Lab",
            content: selected ? (
              <MissionTestingLab mission={selected} />
            ) : (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground" data-testid="text-testing-lab-empty">
                    Select or create a mission to test, promote, and certify it.
                  </p>
                </CardContent>
              </Card>
            ),
          },
          {
            id: "missions",
            label: "My missions",
            content: (
              <Card data-testid="card-mission-list">
                <CardContent className="p-4">
                  {isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : !missions || missions.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-missions">
                      No missions yet. Plan one to get started.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {missions.map((m) => (
                        <li key={m.id}>
                          <button
                            className="flex w-full items-center justify-between py-3 text-left hover:opacity-80"
                            onClick={() => setActiveId(m.id)}
                            data-testid={`button-mission-${m.id}`}
                          >
                            <span>
                              {money(m.startingAmount)} → {money(m.targetAmount)}
                              <span
                                className="ml-2 text-xs text-muted-foreground"
                                data-testid={`text-mission-timeframe-${m.id}`}
                              >
                                {resolveMissionTimeframeLabel(m)} · {m.status}
                              </span>
                            </span>
                            <Badge className={TIER_COLOR[m.feasibility.tier] ?? "bg-muted"}>
                              {m.feasibility.tier}
                            </Badge>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
