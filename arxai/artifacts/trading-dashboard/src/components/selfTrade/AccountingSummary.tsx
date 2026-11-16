import type { SelfTradeAccountingCoverage } from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const money = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";

/** A recorded subtotal remains useful, but never stands in for missing P/L. */
export function AccountingSummary({
  accounting,
}: {
  accounting?: SelfTradeAccountingCoverage;
}) {
  const complete = accounting?.status === "RECORDED";
  const at = accounting?.asOf ? new Date(accounting.asOf) : null;
  const observed =
    at && Number.isFinite(at.getTime()) ? at.toLocaleString() : "Unavailable";
  const day =
    accounting?.dayStart &&
    Number.isFinite(new Date(accounting.dayStart).getTime())
      ? new Date(accounting.dayStart).toISOString().slice(0, 10)
      : null;
  return (
    <section
      aria-label="Accounting coverage"
      className="space-y-3"
      data-accounting-state={accounting?.status ?? "UNAVAILABLE"}
    >
      <Alert
        className={
          complete ? "border-border" : "border-amber-500/30 bg-amber-500/5"
        }
      >
        <AlertTitle>
          {complete ? "Recorded accounting" : "Accounting incomplete"}
        </AlertTitle>
        <AlertDescription className="space-y-1 text-xs">
          {accounting ? (
            <p>
              {accounting.recordedTrades} of {accounting.closedTrades} closed
              trades have usable recorded P&amp;L.{" "}
              {accounting.unresolvedAccounting} unresolved accounting holds.
            </p>
          ) : (
            <p>
              Accounting coverage is unavailable. Complete P&amp;L and available
              risk capital are unknown.
            </p>
          )}
          {!complete && (
            <p>
              Total P&amp;L is unavailable. Recorded capital does not establish
              an available risk budget.
            </p>
          )}
          {(accounting?.notes ?? []).map((note) => (
            <p key={note}>{note}</p>
          ))}
          <p className="text-muted-foreground">Observed: {observed}</p>
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">
            Recorded P&amp;L subtotal
          </div>
          <div className="font-mono text-lg" data-testid="recorded-pnl">
            {money(accounting?.recordedRealizedPnl)}
          </div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">
            Daily net loss (UTC)
          </div>
          <div className="font-mono text-lg" data-testid="daily-loss">
            {money(complete ? accounting?.dailyLossUsed : null)}
          </div>
          <div className="text-xs text-muted-foreground">
            {complete
              ? `Recorded outcomes for ${day ?? "the observed day"} (UTC)`
              : "Unavailable until accounting is complete"}
          </div>
        </div>
      </div>
    </section>
  );
}
