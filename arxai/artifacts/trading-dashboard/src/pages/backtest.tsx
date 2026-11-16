// Legacy /backtest route. The unified Testing Lab at /testing-lab supersedes
// this page and hosts the real /api/backtest-runs engine (server-side
// deterministic candles, full metrics, trade breakdown, AI review, chart series).
//
// This redirect eliminates a historical mock-data leak: the old form loaded a
// CSV file into component state but then ignored it entirely, generating
// Math.random() `dummyCandles` and submitting those to the backend. That gave
// the appearance of user-supplied historical data while producing fabricated
// results. The modern engine never accepts client-supplied candle arrays.
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function BacktestLegacyRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/testing-lab", { replace: true });
  }, [navigate]);
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-slate-400">
      <p className="text-sm">Redirecting to Testing Lab…</p>
    </div>
  );
}
