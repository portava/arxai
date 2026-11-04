/**
 * EntryStopTargetLab — drag entry, stop-loss and take-profit lines on a
 * practice chart (pointer events, so mouse, pen and touch all work). Live
 * risk / reward pips and R:R come from the pure calcPlacement helper, and
 * "Check my placement" grades it with gradePlacement (stop beyond the swing,
 * entry near the setup, R:R at or above target). Practice data only.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { PLACEMENT_SCENARIOS, type PlacementScenario } from "../../data/labs";
import { gradePlacement, type Placement } from "../../lib/labMath";
import { PracticeChart, type ChartGeom } from "../PracticeChart";
import { CheckCircle2, XCircle, RotateCcw, Target } from "lucide-react";

type LineKey = keyof Placement;

const LINE_META: Record<LineKey, { label: string; color: string }> = {
  entry: { label: "Entry", color: "var(--color-primary)" },
  stop: { label: "SL", color: "var(--color-danger)" },
  target: { label: "TP", color: "var(--color-success)" },
};

const CHART_H = 340;

function snap(price: number, s: PlacementScenario): number {
  const clamped = Math.min(s.priceMax, Math.max(s.priceMin, price));
  const snapped = Math.round(clamped / s.pipSize) * s.pipSize;
  return Number(snapped.toFixed(s.digits));
}

export function EntryStopTargetLab({ onChecked }: { onChecked?: (passed: boolean) => void }) {
  const [scenarioId, setScenarioId] = useState(PLACEMENT_SCENARIOS[0].id);
  const scenario = PLACEMENT_SCENARIOS.find((s) => s.id === scenarioId) ?? PLACEMENT_SCENARIOS[0];
  const [placement, setPlacement] = useState<Placement>({ ...scenario.start });
  const [checked, setChecked] = useState(false);
  const [dragging, setDragging] = useState<LineKey | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const geomRef = useRef<ChartGeom | null>(null);

  const grade = useMemo(() => gradePlacement(scenario, placement), [scenario, placement]);
  const m = grade.metrics;

  const switchScenario = (id: string) => {
    const s = PLACEMENT_SCENARIOS.find((x) => x.id === id) ?? PLACEMENT_SCENARIOS[0];
    setScenarioId(s.id);
    setPlacement({ ...s.start });
    setChecked(false);
  };

  const pointerToPrice = (clientY: number): number | null => {
    const svg = svgRef.current;
    const g = geomRef.current;
    if (!svg || !g) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const yView = ((clientY - rect.top) / rect.height) * g.height;
    return g.price(yView);
  };

  const startDrag = (key: LineKey) => (e: ReactPointerEvent<SVGGElement>) => {
    e.preventDefault();
    try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* jsdom / old browsers */ }
    setDragging(key);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const p = pointerToPrice(e.clientY);
    if (p === null) return;
    setPlacement((cur) => ({ ...cur, [dragging]: snap(p, scenario) }));
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    setDragging(null);
  };

  const check = () => { setChecked(true); onChecked?.(grade.passed); };
  const reset = () => { setPlacement({ ...scenario.start }); setChecked(false); };

  const overlay = (g: ChartGeom) => {
    geomRef.current = g;
    const yE = g.y(placement.entry);
    const yS = g.y(placement.stop);
    const yT = g.y(placement.target);
    const swingX = g.x(scenario.swingIndex);
    const swingY = g.y(scenario.swingPrice);
    return (
      <g>
        {/* risk / reward shading */}
        <rect x={0} width={g.plotW} y={Math.min(yE, yS)} height={Math.abs(yS - yE)} fill="var(--color-danger)" opacity={0.1} />
        <rect x={0} width={g.plotW} y={Math.min(yE, yT)} height={Math.abs(yT - yE)} fill="var(--color-success)" opacity={0.1} />
        {/* swing marker */}
        <circle cx={swingX} cy={swingY} r={6} fill="none" stroke="var(--color-warning)" strokeWidth={2} />
        <text x={Math.min(swingX + 10, g.plotW - 70)} y={scenario.direction === "long" ? swingY + 20 : swingY - 10} fontSize={12} fill="var(--color-warning)">
          swing {scenario.direction === "long" ? "low" : "high"}
        </text>
        {(Object.keys(LINE_META) as LineKey[]).map((key) => {
          const y = g.y(placement[key]);
          const meta = LINE_META[key];
          return (
            <g key={key} data-testid={`drag-${key}`} onPointerDown={startDrag(key)} style={{ cursor: "ns-resize", touchAction: "none" }}>
              <rect x={0} y={y - 12} width={g.width} height={24} fill="transparent" />
              <line x1={0} x2={g.plotW} y1={y} y2={y} stroke={meta.color} strokeWidth={dragging === key ? 3 : 2} />
              <rect x={g.plotW + 2} y={y - 11} width={g.width - g.plotW - 4} height={22} rx={6} fill={meta.color} />
              <text x={g.plotW + (g.width - g.plotW) / 2} y={y + 4} fontSize={12} fontWeight={700} textAnchor="middle" fill="var(--color-background)">
                {meta.label}
              </text>
              <text x={6} y={y - 5} fontSize={12} fontWeight={600} fill={meta.color}>
                {meta.label} {placement[key].toFixed(scenario.digits)}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  const setField = (key: LineKey, v: string) => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) setPlacement((cur) => ({ ...cur, [key]: snap(n, scenario) }));
  };

  return (
    <div className="space-y-3" data-testid="lab-entry-sl-tp-body">
      <div className="flex flex-wrap gap-1.5">
        {PLACEMENT_SCENARIOS.map((s) => (
          <button key={s.id} onClick={() => switchScenario(s.id)}
            className={cn("rounded-lg border px-3 py-1.5 text-xs font-medium",
              s.id === scenario.id ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-background/40 text-txt-secondary hover:border-primary/30")}>
            {s.title}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">{scenario.market} · {scenario.direction === "long" ? "Buy" : "Sell"} setup</div>
        <p className="text-sm text-txt-secondary">{scenario.brief}</p>
        <div className="rounded-xl border border-border bg-background/40 p-2">
          <PracticeChart
            ref={svgRef}
            candles={scenario.candles}
            min={scenario.priceMin}
            max={scenario.priceMax}
            digits={scenario.digits}
            height={CHART_H}
            ariaLabel="Practice chart with draggable entry, stop-loss and take-profit lines"
            onPointerMove={onMove}
            onPointerUp={endDrag}
            style={dragging ? { touchAction: "none" } : undefined}
            overlay={overlay}
          />
        </div>
        <p className="text-[11px] text-txt-muted">Drag the coloured tags (or the lines) up and down. Fine-tune with the boxes below.</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(LINE_META) as LineKey[]).map((key) => (
          <label key={key} className="block min-w-0">
            <span className="text-[11px] font-medium text-txt-secondary">{key === "entry" ? "Entry" : key === "stop" ? "Stop-loss" : "Take-profit"}</span>
            <input type="number" inputMode="decimal" step={scenario.pipSize} value={placement[key]}
              data-testid={`input-${key}`}
              onChange={(e) => setField(key, e.target.value)}
              className="mt-1 w-full min-w-0 rounded-lg border border-border bg-background/40 px-2 py-1.5 text-sm text-foreground focus:border-primary/40 focus:outline-none" />
          </label>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">Risk</div>
          <div className="text-base font-bold text-danger" data-testid="metric-risk">{m.riskPips} pips</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">Reward</div>
          <div className="text-base font-bold text-success" data-testid="metric-reward">{m.rewardPips} pips</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="text-[11px] uppercase tracking-wide text-txt-muted">R:R</div>
          <div className="text-base font-bold text-foreground" data-testid="metric-rr">{m.ordered ? `1 : ${m.rr.toFixed(2)}` : "—"}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={check} data-testid="check-placement" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90">
          <Target className="h-4 w-4" /> Check my placement
        </button>
        <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/40">
          <RotateCcw className="h-4 w-4" /> Reset lines
        </button>
      </div>

      {checked && (
        <div className={cn("rounded-2xl border p-4 space-y-2", grade.passed ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10")} data-testid="placement-grade">
          <div className={cn("text-sm font-semibold", grade.passed ? "text-success" : "text-warning")}>
            {grade.passed ? "Solid placement — every check passes." : `${grade.checks.filter((c) => c.pass).length} of ${grade.checks.length} checks pass. Adjust and check again.`}
          </div>
          <ul className="space-y-1.5">
            {grade.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                {c.pass ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                <span className="min-w-0"><span className="font-semibold text-foreground">{c.label}.</span> <span className="text-txt-secondary">{c.detail}</span></span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-txt-muted">The grade updates as you move the lines.</p>
        </div>
      )}
    </div>
  );
}
