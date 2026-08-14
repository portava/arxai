import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trophy, ShieldCheck, Rocket, RefreshCw } from "lucide-react";
import { useCreateMeScalpRank } from "@workspace/api-client-react";
import type {
  ScalpResult, ScalpMode, ScalpMarketGroup, MeScalpRankResp,
} from "@workspace/api-client-react";
import { ScalpSignalCard } from "./ScalpSignalCard";
import {
  SCALP_MODE_LABEL, SCALP_MODE_OPTIONS,
  SCALP_MARKET_GROUP_LABEL, SCALP_MARKET_GROUP_OPTIONS,
  FLAME_STAGE_LABEL, FLAME_STAGE_TONE,
  directionTone, fmtRr,
} from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// RubyScalpRanking (T004) — the Broad-scan "Top Ruby Scalp Opportunities"
// panel. Ranks the scanned universe through the SAME shared scalp engine and
// surfaces Best / Safer / Fastest plus the ranked list. Picking any row sets
// the shared chart symbol (via onPick) and can carry the result straight into
// the trade ticket (via onBuild).

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

export function RubyScalpRanking({
  onPick,
  onBuild,
}: {
  onPick?: (r: ScalpResult) => void;
  onBuild?: (r: ScalpResult) => void;
}) {
  const [group, setGroup] = useState<ScalpMarketGroup>("all");
  const [mode, setMode] = useState<ScalpMode>("ANY");
  const [resp, setResp] = useState<MeScalpRankResp | null>(null);
  const { name } = useAssistantName();
  const rank = useCreateMeScalpRank();

  const runScan = () => {
    rank.mutate(
      { data: { marketGroup: group, mode, limit: 8 } },
      { onSuccess: (data) => setResp(data) },
    );
  };

  const handlePick = (r: ScalpResult) => onPick?.(r);

  return (
    <Card data-testid="ruby-scalp-ranking" className="rounded-2xl border-warning/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-warning/15 text-warning ring-1 ring-warning/25">
              <Trophy className="h-[18px] w-[18px]" />
            </span>
            Top {name} Scalp Opportunities
          </CardTitle>
        </div>
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
            disabled={rank.isPending}
            data-testid="scalp-rank-scan"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${rank.isPending ? "animate-spin" : ""}`} />
            Scan
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!resp && !rank.isPending && (
          <p className="text-sm text-muted-foreground">
            Run a scan to rank the best scalps across your chosen markets.
          </p>
        )}
        {rank.isError && (
          <p className="text-sm text-rose-300">{name} couldn't rank markets right now. Try again shortly.</p>
        )}
        {rank.isPending && (
          <p className="text-sm text-muted-foreground animate-pulse">{name} is ranking opportunities…</p>
        )}

        {resp && (
          <>
            {resp.opportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="scalp-rank-empty">
                {resp.scanned > 0
                  ? `${name} scanned ${resp.scanned} markets and found no clean scalp right now. Patience pays.`
                  : "No scanned markets yet. Run a Broad Scan first, then rank."}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <PickChip label="Best" icon={<Trophy className="h-3 w-3" />} pick={resp.best} onPick={handlePick} />
                  <PickChip label="Safer" icon={<ShieldCheck className="h-3 w-3" />} pick={resp.safer} onPick={handlePick} />
                  <PickChip label="Fastest" icon={<Rocket className="h-3 w-3" />} pick={resp.fastest} onPick={handlePick} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {name} scanned {resp.scanned} markets. Tap a market to load its chart, or build the trade directly.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {resp.opportunities.map((opp) => (
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
      </CardContent>
    </Card>
  );
}

export default RubyScalpRanking;
