import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Wand2, Search } from "lucide-react";
import { useCreateMeScalpBuild } from "@workspace/api-client-react";
import type {
  ScalpResult, ScalpMode, ScalpMarketGroup, MeScalpBuildResp, RiskPersonality,
} from "@workspace/api-client-react";
import { ScalpSignalCard } from "./ScalpSignalCard";
import {
  SCALP_MODE_LABEL, SCALP_MODE_OPTIONS,
  SCALP_MARKET_GROUP_LABEL, SCALP_MARKET_GROUP_OPTIONS,
  RISK_PERSONALITY_LABEL, RISK_PERSONALITY_OPTIONS,
} from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// RubyScalpBuilder (T005) — goal-first panel. The user tells Ruby what they
// want (target profit, how much they're willing to risk, style, markets) and
// Ruby finds the single best scalp that fits — through the SAME shared engine
// the Focus card and ranking use. Honest no-trade path when nothing qualifies.

function parseAmount(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function RubyScalpBuilder({
  onBuild,
}: {
  onBuild?: (r: ScalpResult) => void;
}) {
  const [target, setTarget] = useState("");
  const [risk, setRisk] = useState("");
  const [mode, setMode] = useState<ScalpMode>("ANY");
  const [group, setGroup] = useState<ScalpMarketGroup>("all");
  const [personality, setPersonality] = useState<RiskPersonality>("BALANCED");
  const [resp, setResp] = useState<MeScalpBuildResp | null>(null);
  const { name } = useAssistantName();
  const build = useCreateMeScalpBuild();

  const runBuild = () => {
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
      { onSuccess: (data) => setResp(data) },
    );
  };

  return (
    <Card data-testid="ruby-scalp-builder" className="rounded-2xl border-ruby/25 bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
            <Wand2 className="h-[18px] w-[18px]" />
          </span>
          {name} Scalp Builder
        </CardTitle>
        <p className="text-xs text-txt-secondary pt-1">
          Tell {name} your goal and she'll find the best scalp that fits — no guessing.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Style</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as ScalpMode)}>
              <SelectTrigger className="h-11" data-testid="scalp-builder-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCALP_MODE_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>{SCALP_MODE_LABEL[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Markets</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as ScalpMarketGroup)}>
              <SelectTrigger className="h-11" data-testid="scalp-builder-group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCALP_MARKET_GROUP_OPTIONS.map((g) => (
                  <SelectItem key={g} value={g}>{SCALP_MARKET_GROUP_LABEL[g]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

        <Button
          className="h-11 w-full font-bold bg-primary text-white hover:bg-primary/90"
          onClick={runBuild}
          disabled={build.isPending}
          data-testid="scalp-builder-find"
        >
          <Search className={`h-4 w-4 mr-1 ${build.isPending ? "animate-spin" : ""}`} />
          Find Best Scalp
        </Button>

        {build.isError && (
          <p className="text-sm text-rose-300">{name} couldn't build a scalp right now. Try again shortly.</p>
        )}
        {build.isPending && (
          <p className="text-sm text-txt-secondary animate-pulse">{name} is searching for your best scalp…</p>
        )}

        {resp && (
          <div className="space-y-3">
            {resp.primary ? (
              <>
                <ScalpSignalCard
                  result={resp.primary}
                  onBuild={onBuild}
                  highlightLabel={`${name}'s pick`}
                />
                {resp.alternatives.length > 0 && (
                  <>
                    <p className="text-xs text-txt-secondary pt-1">Other options</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {resp.alternatives.map((alt) => (
                        <ScalpSignalCard key={alt.symbol} result={alt} compact onBuild={onBuild} />
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-sm text-txt-secondary" data-testid="scalp-builder-none">
                {resp.noTradeReason
                  ? resp.noTradeReason
                  : resp.scanned > 0
                    ? `${name} checked ${resp.scanned} markets and none fit your goal cleanly right now. Patience pays.`
                    : "No scanned markets yet. Run a Broad Scan first, then build."}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default RubyScalpBuilder;
