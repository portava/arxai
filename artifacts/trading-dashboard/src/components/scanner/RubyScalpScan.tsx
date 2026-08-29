import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trophy, ShieldCheck, Rocket, RefreshCw, Search, Target, ChevronDown } from "lucide-react";
import { useCreateMeScalpRank, useCreateMeScalpBuild } from "@workspace/api-client-react";
import type {
  ScalpResult, ScalpMode, ScalpMarketGroup, MeScalpRankResp, MeScalpBuildResp, RiskPersonality,
} from "@workspace/api-client-react";
import { ScalpSignalCard } from "./ScalpSignalCard";
import {
  SCALP_MODE_LABEL, SCALP_MODE_OPTIONS,
  SCALP_MARKET_GROUP_LABEL, SCALP_MARKET_GROUP_OPTIONS,
  RISK_PERSONALITY_LABEL, RISK_PERSONALITY_OPTIONS,
  FLAME_STAGE_LABEL, FLAME_STAGE_TONE,
  directionTone, fmtRr,
} from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";
import { cn } from "@/lib/utils";

// RubyScalpScan — the ONE Broad-scan scalp surface (surface consolidation,
// merge-map item D). Replaces the previous two panels:
//   • RubyScalpRanking (T004) — rank-the-universe: Best / Safer / Fastest picks
//     plus the ranked list, via POST /api/me/scalp/rank.
//   • RubyScalpBuilder (T005) — goal-first: "here's my target/risk, find the
//     single best fit", via POST /api/me/scalp/build.
// Both were thin UIs over the SAME shared scalp engine, so this is a UI merge
// with the goal as an OPTIONAL input: leave the goal closed and Scan ranks the
// universe; open it and enter a target/risk and Scan finds the best fit.
//
// HONESTY: both paths call the same server endpoints as before, which fetch a
// REAL live quote per symbol (currentPriceFor — the C2 fix) and read the flame
// BLIND (honest NONE) on the broad path rather than fabricating a candle
// window. Nothing here relabels that degraded read as live — ScalpSignalCard
// renders the engine's own blind/flame state. The Builder's honest no-trade
// path (noTradeReason / "none fit your goal") is preserved verbatim. The deep
// candle-backed read stays on the Scalp Focus card, which is unchanged.
//
// SAFETY: this panel never places a trade. onBuild routes through the SAME
// gated ScannerTradeModal as every other surface; every server gate re-runs.

function parseAmount(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function PickChip({
  label, icon, pick, onPick,
}: {
  label: string;
  icon: React.ReactNode;
  pick: ScalpResult | null;
  onPick: (r: ScalpResult) => void;
}) {
  if (!pick) return null;
  return (
    <button
      type="button"
      onClick={() => onPick(pick)}
      className="text-left rounded-lg border border-border bg-background/40 p-2.5 hover:border-ruby/50 transition-colors"
      data-testid={`scalp-pick-${label.toLowerCase()}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">{icon}{label}</div>
      <div className="font-semibold text-sm truncate">{pick.displayName || pick.symbol}</div>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {pick.direction && (
          <Badge className={`${directionTone(pick.direction)} text-[10px]`}>{pick.direction}</Badge>
        )}
        {pick.flame && !pick.flame.blind && pick.flame.flameStage !== "NONE" && (
          <Badge className={`${FLAME_STAGE_TONE[pick.flame.flameStage]} text-[10px]`}>
            {FLAME_STAGE_LABEL[pick.flame.flameStage]}
          </Badge>
        )}
        <span className="text-[11px] text-muted-foreground">RR {fmtRr(pick.rewardToRisk)}</span>
      </div>
    </button>
  );
}

export function RubyScalpScan({
  onPick,
  onBuild,
}: {
  onPick?: (r: ScalpResult) => void;
  onBuild?: (r: ScalpResult) => void;
}) {
  const [group, setGroup] = useState<ScalpMarketGroup>("all");
  const [mode, setMode] = useState<ScalpMode>("ANY");
  const [goalOpen, setGoalOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [risk, setRisk] = useState("");
  const [personality, setPersonality] = useState<RiskPersonality>("BALANCED");
  // Exactly one of the two responses is live at a time — whichever path the
  // last Scan ran. Never both, so the panel can't show two disagreeing reads.
  const [rankResp, setRankResp] = useState<MeScalpRankResp | null>(null);
  const [buildResp, setBuildResp] = useState<MeScalpBuildResp | null>(null);
  const { name } = useAssistantName();
  const rank = useCreateMeScalpRank();
  const build = useCreateMeScalpBuild();

  // The goal is ACTIVE only when the section is open AND carries a real
  // amount. An open-but-empty goal still ranks the universe — we never guess
  // a target the user didn't type.
  const goalActive = goalOpen && (parseAmount(target) != null || parseAmount(risk) != null);
  const pending = rank.isPending || build.isPending;

  const runScan = () => {
    if (goalActive) {
      build.mutate(
        {
          data: {
            targetProfitAmount: parseAmount(target),
            riskAmount: parseAmount(risk),
            mode,
            marketGroup: group,
            riskPersonality: personality,
          },
        },
        { onSuccess: (data) => { setBuildResp(data); setRankResp(null); } },
      );
    } else {
      rank.mutate(
        { data: { marketGroup: group, mode, limit: 8 } },
        { onSuccess: (data) => { setRankResp(data); setBuildResp(null); } },
      );
    }
  };

  const handlePick = (r: ScalpResult) => onPick?.(r);

  return (
    <Card data-testid="ruby-scalp-scan" className="rounded-2xl border-warning/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-warning/15 text-warning ring-1 ring-warning/25">
              <Trophy className="h-[18px] w-[18px]" />
            </span>
            {name} Scalp Scan
          </CardTitle>
        </div>
        <p className="text-xs text-txt-secondary pt-1">
          Scan your chosen markets for the best scalps — or open the goal below and {name} finds the single best fit.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Select value={group} onValueChange={(v) => setGroup(v as ScalpMarketGroup)}>
            <SelectTrigger className="h-9 w-[150px]" data-testid="scalp-rank-group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALP_MARKET_GROUP_OPTIONS.map((g) => (
                <SelectItem key={g} value={g}>{SCALP_MARKET_GROUP_LABEL[g]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={(v) => setMode(v as ScalpMode)}>
            <SelectTrigger className="h-9 w-[140px]" data-testid="scalp-rank-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALP_MODE_OPTIONS.map((m) => (
                <SelectItem key={m} value={m}>{SCALP_MODE_LABEL[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="h-9 ml-auto"
            onClick={runScan}
            disabled={pending}
            data-testid="scalp-rank-scan"
          >
            {goalActive
              ? <Search className={`h-4 w-4 mr-1 ${pending ? "animate-spin" : ""}`} />
              : <RefreshCw className={`h-4 w-4 mr-1 ${pending ? "animate-spin" : ""}`} />}
            {goalActive ? "Find Best Scalp" : "Scan"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Optional goal picker — the old Scalp Builder's inputs, folded in. */}
        <div className="rounded-xl border border-border bg-background/30">
          <button
            type="button"
            onClick={() => setGoalOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-txt-secondary hover:text-foreground"
            data-testid="scalp-goal-toggle"
            aria-expanded={goalOpen}
          >
            <Target className="h-3.5 w-3.5" />
            Goal (optional) — tell {name} your target and she'll find the best scalp that fits
            <ChevronDown className={cn("ml-auto h-3.5 w-3.5 transition-transform", goalOpen && "rotate-180")} />
          </button>
          {goalOpen && (
            <div className="space-y-3 border-t border-border p-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="scalp-target" className="text-xs">Target profit ($)</Label>
                  <Input
                    id="scalp-target"
                    inputMode="decimal"
                    placeholder="e.g. 25"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="h-11"
                    data-testid="scalp-builder-target"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scalp-risk" className="text-xs">Willing to risk ($)</Label>
                  <Input
                    id="scalp-risk"
                    inputMode="decimal"
                    placeholder="e.g. 10"
                    value={risk}
                    onChange={(e) => setRisk(e.target.value)}
                    className="h-11"
                    data-testid="scalp-builder-risk"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Risk personality</Label>
                <Select value={personality} onValueChange={(v) => setPersonality(v as RiskPersonality)}>
                  <SelectTrigger className="h-11" data-testid="scalp-builder-personality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RISK_PERSONALITY_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>{RISK_PERSONALITY_LABEL[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-txt-secondary">
                  Adjusts how strict {name} is about timing and chase risk — never your safety limits.
                </p>
              </div>
              {goalOpen && !goalActive && (
                <p className="text-[10px] text-txt-secondary" data-testid="scalp-goal-inactive">
                  Enter a target or risk amount to switch Scan into goal mode; empty fields keep the full ranking.
                </p>
              )}
            </div>
          )}
        </div>

        {!rankResp && !buildResp && !pending && (
          <p className="text-sm text-muted-foreground">
            Run a scan to rank the best scalps across your chosen markets.
          </p>
        )}
        {(rank.isError || build.isError) && (
          <p className="text-sm text-rose-300">
            {goalActive
              ? `${name} couldn't build a scalp right now. Try again shortly.`
              : `${name} couldn't rank markets right now. Try again shortly.`}
          </p>
        )}
        {pending && (
          <p className="text-sm text-muted-foreground animate-pulse">
            {goalActive ? `${name} is searching for your best scalp…` : `${name} is ranking opportunities…`}
          </p>
        )}

        {/* ── Ranked-universe results (no goal) ── */}
        {rankResp && (
          <>
            {rankResp.opportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="scalp-rank-empty">
                {rankResp.scanned > 0
                  ? `${name} scanned ${rankResp.scanned} markets and found no clean scalp right now. Patience pays.`
                  : "No scanned markets yet. Run a Broad Scan first, then rank."}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <PickChip label="Best" icon={<Trophy className="h-3 w-3" />} pick={rankResp.best} onPick={handlePick} />
                  <PickChip label="Safer" icon={<ShieldCheck className="h-3 w-3" />} pick={rankResp.safer} onPick={handlePick} />
                  <PickChip label="Fastest" icon={<Rocket className="h-3 w-3" />} pick={rankResp.fastest} onPick={handlePick} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {name} scanned {rankResp.scanned} markets. Tap a market to load its chart, or build the trade directly.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {rankResp.opportunities.map((opp) => (
                    <ScalpSignalCard
                      key={opp.symbol}
                      result={opp}
                      compact
                      onBuild={onBuild}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* ── Goal-fit results (target/risk provided) ── */}
        {buildResp && (
          <div className="space-y-3">
            {buildResp.primary ? (
              <>
                <ScalpSignalCard
                  result={buildResp.primary}
                  onBuild={onBuild}
                  highlightLabel={`${name}'s pick`}
                />
                {buildResp.alternatives.length > 0 && (
                  <>
                    <p className="text-xs text-txt-secondary pt-1">Other options</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {buildResp.alternatives.map((alt) => (
                        <ScalpSignalCard key={alt.symbol} result={alt} compact onBuild={onBuild} />
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-sm text-txt-secondary" data-testid="scalp-builder-none">
                {buildResp.noTradeReason
                  ? buildResp.noTradeReason
                  : buildResp.scanned > 0
                    ? `${name} checked ${buildResp.scanned} markets and none fit your goal cleanly right now. Patience pays.`
                    : "No scanned markets yet. Run a Broad Scan first, then build."}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default RubyScalpScan;
