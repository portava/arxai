type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
interface Props { status: Status; onProceed: () => void; disabled?: boolean }

export function StartTradingButton({ status, onProceed, disabled }: Props) {
  if (status === "LOCKED") {
    return (
      <button disabled
        className="w-full rounded-lg bg-danger/60 px-4 py-3 text-sm font-semibold text-danger cursor-not-allowed">
        🔒 Trading LOCKED — resolve blockers above
      </button>
    );
  }
  if (status === "NOT_READY") {
    return (
      <button disabled
        className="w-full rounded-lg bg-warning/60 px-4 py-3 text-sm font-semibold text-warning cursor-not-allowed">
        Not ready — complete the failed checklist items
      </button>
    );
  }
  if (status === "CAUTION") {
    return (
      <button onClick={onProceed} disabled={disabled}
        className="w-full rounded-lg bg-warning/15 px-4 py-3 text-sm font-semibold text-warning hover:bg-warning disabled:opacity-50">
        Proceed with caution → trade smaller, watch warnings
      </button>
    );
  }
  return (
    <button onClick={onProceed} disabled={disabled}
      className="w-full rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white hover:bg-success disabled:opacity-50">
      Start trading session
    </button>
  );
}
