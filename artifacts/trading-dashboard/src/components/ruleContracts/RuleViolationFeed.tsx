interface V { type: string; severity: "INFO"|"WARN"|"HARD"; message: string; tradeId?: number | null }
export function RuleViolationFeed({ violations }: { violations: V[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Violations & warnings ({violations.length})</h3>
      {violations.length === 0
        ? <p className="text-xs text-success">No violations today — keep going.</p>
        : <ul className="max-h-64 space-y-1 overflow-auto text-xs">
            {violations.map((v, i) => (
              <li key={i} className="flex items-start gap-2 rounded border border-border bg-background/40 p-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  v.severity === "HARD" ? "bg-danger/15 text-white"
                  : v.severity === "WARN" ? "bg-warning/15 text-white"
                  : "bg-muted text-foreground"}`}>{v.severity}</span>
                <span className="font-mono text-[10px] text-txt-secondary">{v.type}</span>
                <span className="text-foreground">{v.message}</span>
                {v.tradeId != null && <span className="ml-auto font-mono text-[10px] text-txt-muted">#{v.tradeId}</span>}
              </li>
            ))}
          </ul>}
    </div>
  );
}
