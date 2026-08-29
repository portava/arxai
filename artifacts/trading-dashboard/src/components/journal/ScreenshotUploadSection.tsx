import { useState } from "react";

// Build I — screenshot URLs only (no object storage in monorepo yet).
// Operator pastes a publicly-reachable URL; the entry stores it as text.
export function ScreenshotUploadSection({
  value, onChange,
}: { value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    try { new URL(v); } catch { return; }
    if (value.includes(v)) { setDraft(""); return; }
    onChange([...value, v]); setDraft("");
  };
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Screenshots</div>
      <div className="flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://…"
          className="flex-1 rounded border border-border bg-card px-2 py-1 text-sm text-foreground" />
        <button type="button" onClick={add} className="rounded-md border border-border bg-card px-3 py-1 text-xs text-foreground hover:bg-secondary">Add</button>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {value.map((url) => (
            <li key={url} className="group relative">
              <img src={url} alt="screenshot" className="h-20 w-32 rounded border border-border object-cover" />
              <button type="button" onClick={() => onChange(value.filter((u) => u !== url))}
                className="absolute -right-1 -top-1 rounded-full bg-danger px-1.5 text-[10px] text-white opacity-0 group-hover:opacity-100">×</button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-txt-muted">Paste a public image URL. Local upload requires object storage (not configured).</p>
    </div>
  );
}
