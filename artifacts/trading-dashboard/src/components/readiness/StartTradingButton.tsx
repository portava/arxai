type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
interface Props { status: Status; onProceed: () => void; disabled?: boolean }

export function StartTradingButton({ status, onProceed, disabled }: Props) {
  if (status === "LOCKED") {
    // The readiness LOCKED status is an advisory label (api-server
    // routes/tradingReadiness.ts). It locks nothing: order execution is decided
    // separately by the safety layer's gates, so the copy must not say
    // "Trading LOCKED".
    return (
      <div className="space-y-1">
        <button disabled data-testid="btn-readiness-locked"
          className="w-full rounded-lg bg-red-900/60 px-4 py-3 text-sm font-semibold text-red-100 cursor-not-allowed">
          Readiness LOCKED — resolve the blockers above
        </button>
        <p data-testid="text-readiness-locked-advisory" className="text-[11px] text-slate-400">
          Advisory: this pre-session check does not lock or unlock trading. Order execution is decided separately by the safety layer.
        </p>
      </div>
    );
  }
  if (status === "NOT_READY") {
    return (
      <button disabled
        className="w-full rounded-lg bg-orange-900/60 px-4 py-3 text-sm font-semibold text-orange-100 cursor-not-allowed">
        Not ready — complete the failed checklist items
      </button>
    );
  }
  if (status === "CAUTION") {
    return (
      <button onClick={onProceed} disabled={disabled}
        className="w-full rounded-lg bg-amber-700 px-4 py-3 text-sm font-semibold text-amber-50 hover:bg-amber-600 disabled:opacity-50">
        Proceed with caution → trade smaller, watch warnings
      </button>
    );
  }
  return (
    <button onClick={onProceed} disabled={disabled}
      className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
      Start trading session
    </button>
  );
}
