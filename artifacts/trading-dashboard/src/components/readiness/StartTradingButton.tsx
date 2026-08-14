type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
interface Props { status: Status; onProceed: () => void; disabled?: boolean }

export function StartTradingButton({ status, onProceed, disabled }: Props) {
  if (status === "LOCKED") {
    return (
      <button disabled
        className="w-full rounded-lg bg-red-900/60 px-4 py-3 text-sm font-semibold text-red-100 cursor-not-allowed">
        🔒 Trading LOCKED — resolve blockers above
      </button>
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
