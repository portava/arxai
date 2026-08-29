interface Item { id: string; label: string; status: "PASS"|"WARN"|"FAIL"|"INFO"; detail: string }
const dot = (s: Item["status"]) =>
  s === "PASS" ? "bg-success" : s === "WARN" ? "bg-warning"
  : s === "FAIL" ? "bg-danger" : "bg-muted";
const tone = (s: Item["status"]) =>
  s === "PASS" ? "text-success" : s === "WARN" ? "text-warning"
  : s === "FAIL" ? "text-danger" : "text-txt-secondary";

export function PreSessionChecklist({ items }: { items: Item[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Pre-session checklist</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 rounded border border-border bg-background/40 p-2 text-xs">
            <span className={`mt-1 inline-block size-2 shrink-0 rounded-full ${dot(it.status)}`} />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-foreground">{it.label}</span>
                <span className={`font-mono text-[10px] ${tone(it.status)}`}>{it.status}</span>
              </div>
              <div className="text-[11px] text-txt-secondary">{it.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
