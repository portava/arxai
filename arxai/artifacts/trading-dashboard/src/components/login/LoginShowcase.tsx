// Animated 3-slide showcase for the login page LEFT panel only.
// No auth, no backend calls, no protected data — pure presentational preview.
// Respects prefers-reduced-motion. Auto-advances, pauses on hover/focus/touch.

import { useEffect, useRef, useState } from "react";
import { Shield, Sparkles, Target, TrendingUp, Search, CheckCircle2 } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

const SLIDE_MS = 5000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ── Slide 1: Live Market Intelligence ─────────────────────────────────────────
function SlideMarket({ animate }: { animate: boolean }) {
  const tickers = [
    { sym: "EURUSD", px: "1.1652", chg: "+0.18%", up: true },
    { sym: "XAUUSD", px: "2,387.4", chg: "+0.54%", up: true },
    { sym: "US30", px: "39,114", chg: "-0.21%", up: false },
    { sym: "BTCUSD", px: "67,420", chg: "+1.12%", up: true },
  ];
  const candles = [38, 56, 44, 68, 52, 78, 64, 88, 72, 96];
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-3xl xl:text-4xl font-black leading-tight">
          Live Market <span className="text-blue-400">Intelligence</span>
        </h3>
        <p className="mt-3 text-base text-slate-300 max-w-md">
          See market movement clearly before you act.
        </p>
      </div>

      <div className="relative h-48 overflow-hidden rounded-2xl border border-blue-400/20 bg-[#06101f]">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(37,99,235,0.18),transparent_50%)]" />
        <div className="absolute bottom-5 left-5 right-5 flex items-end gap-2 h-32">
          {candles.map((h, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm ${i % 2 === 0 ? "bg-emerald-400/80" : "bg-blue-400/70"} ${animate ? "arx-login-candle" : ""}`}
              style={{ height: `${h}%`, animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </div>
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 280 140" preserveAspectRatio="none" aria-hidden>
          <polyline
            className={animate ? "arx-login-line" : ""}
            points="0,120 40,90 80,100 120,60 160,75 200,40 240,55 280,25"
            fill="none" stroke="rgba(96,165,250,0.9)" strokeWidth="2"
          />
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {tickers.map((t) => (
          <div key={t.sym} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold tracking-wide">{t.sym}</span>
              <TrendingUp className={`h-3 w-3 ${t.up ? "text-emerald-400" : "text-red-400 rotate-180"}`} aria-hidden />
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-sm font-mono text-slate-200">{t.px}</span>
              <span className={`text-[11px] font-semibold ${t.up ? "text-emerald-400" : "text-red-400"}`}>{t.chg}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Slide 2: Ruby Trades With Discipline ──────────────────────────────────────
function SlideRuby({ animate }: { animate: boolean }) {
  void animate;
  const { name } = useAssistantName();
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-3xl xl:text-4xl font-black leading-tight">
          {name} Trades With <span className="text-blue-400">Discipline</span>
        </h3>
        <p className="mt-3 text-base text-slate-300 max-w-md">
          {name} scans structure, risk, momentum, and news so every trade starts with a plan.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-purple-500 text-xs font-black">R</div>
          <div className="rounded-2xl rounded-tl-sm border border-blue-400/20 bg-blue-500/10 px-4 py-2.5 text-sm text-slate-200">
            EURUSD structure is bullish on H1. Momentum confirms, spread is tight.
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-purple-500 text-xs font-black">R</div>
          <div className="rounded-2xl rounded-tl-sm border border-blue-400/20 bg-blue-500/10 px-4 py-2.5 text-sm text-slate-200">
            News risk is low for the next 4 hours. Here's a plan with defined risk.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {[
          { label: "Entry", val: "1.1652", color: "text-blue-300" },
          { label: "Stop Loss", val: "1.1631", color: "text-red-400" },
          { label: "Take Profit", val: "1.1694", color: "text-emerald-400" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">{c.label}</p>
            <p className={`mt-1 text-sm font-mono font-bold ${c.color}`}>{c.val}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Sparkles className="h-3.5 w-3.5 text-blue-300" aria-hidden />
        Every setup includes structure, risk, momentum, and news context.
      </div>
    </div>
  );
}

// ── Slide 3: From Signal to Execution ─────────────────────────────────────────
function SlideExecution({ animate }: { animate: boolean }) {
  void animate;
  const steps = [
    { label: "Scan", Icon: Search },
    { label: "Analyze", Icon: Sparkles },
    { label: "Confirm", Icon: Shield },
    { label: "Execute", Icon: Target },
  ];
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-3xl xl:text-4xl font-black leading-tight">
          From Signal to <span className="text-blue-400">Execution</span>
        </h3>
        <p className="mt-3 text-base text-slate-300 max-w-md">
          A clear path from idea to action — with you in control at every step.
        </p>
      </div>

      <div className="flex items-center justify-between gap-1">
        {steps.map(({ label, Icon }, i) => (
          <div key={label} className="flex items-center gap-1 flex-1">
            <div className="flex flex-col items-center gap-1.5 flex-1">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-blue-400/30 bg-blue-500/10">
                <Icon className="h-5 w-5 text-blue-300" aria-hidden />
              </div>
              <span className="text-[11px] font-semibold text-slate-300">{label}</span>
            </div>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-gradient-to-r from-blue-400/40 to-blue-400/10 -mt-5" />}
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-blue-400/20 bg-black/30 p-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
          <span className="text-sm font-bold">EURUSD</span>
          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">BUY</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div className="flex justify-between"><span className="text-slate-400">Risk / Reward</span><span className="font-mono text-slate-200">1 : 2.0</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Volume</span><span className="font-mono text-slate-200">0.10</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Stop Loss</span><span className="font-mono text-red-400">1.1631</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Take Profit</span><span className="font-mono text-emerald-400">1.1694</span></div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
          <span className="text-xs text-emerald-300">Confirmed — ready when you are.</span>
        </div>
      </div>
    </div>
  );
}

const SLIDES = [SlideMarket, SlideRuby, SlideExecution];
const titles = (name: string) => ["Live Market Intelligence", `${name} Trades With Discipline`, "From Signal to Execution"];

export default function LoginShowcase() {
  const { name } = useAssistantName();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = usePrefersReducedMotion();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (paused || reduced) return;
    timer.current = setInterval(() => setIdx((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [paused, reduced]);

  return (
    <div
      className="relative z-10 flex h-full flex-col justify-center"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onTouchStart={() => setPaused(true)}
    >
      <div className="relative min-h-[460px]">
        {SLIDES.map((S, i) => (
          <div
            key={i}
            aria-hidden={i !== idx}
            className={`absolute inset-0 transition-opacity duration-700 ${
              i === idx ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          >
            <S animate={!reduced && i === idx} />
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-center gap-2.5" role="tablist" aria-label="Showcase slides">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === idx}
            aria-label={`Show slide ${i + 1}: ${titles(name)[i]}`}
            onClick={() => setIdx(i)}
            className={`h-2 rounded-full transition-all ${
              i === idx ? "w-8 bg-blue-400" : "w-2 bg-white/25 hover:bg-white/40"
            }`}
          />
        ))}
      </div>

      <style>{`
        @keyframes arxLoginCandle {
          0% { transform: scaleY(0.4); opacity: 0.5; transform-origin: bottom; }
          100% { transform: scaleY(1); opacity: 1; transform-origin: bottom; }
        }
        .arx-login-candle { animation: arxLoginCandle 0.6s ease-out forwards; transform-origin: bottom; }
        @keyframes arxLoginLine {
          from { stroke-dashoffset: 600; }
          to { stroke-dashoffset: 0; }
        }
        .arx-login-line { stroke-dasharray: 600; animation: arxLoginLine 1.6s ease-out forwards; }
        @media (prefers-reduced-motion: reduce) {
          .arx-login-candle, .arx-login-line { animation: none; }
        }
      `}</style>
    </div>
  );
}
