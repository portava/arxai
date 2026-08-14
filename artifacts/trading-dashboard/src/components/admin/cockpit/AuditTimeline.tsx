// Admin Cockpit — Audit timeline + manual note composer. The timeline reads the
// merged cockpit + admin audit log (read-only). Adding a manual note delegates
// to the audited /manual-note endpoint, which writes both the note and a
// cockpit audit row.

import { useState } from "react";
import { useGetAdminCockpitAuditLog, getGetAdminCockpitAuditLogQueryKey, useAddAdminCockpitNote } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cockpitQuery, Chip, Panel, SectionState, timeAgo, useCockpitAction } from "./cockpitShared";

export function AuditTimeline() {
  const q = useGetAdminCockpitAuditLog(undefined, { query: { queryKey: getGetAdminCockpitAuditLogQueryKey(), ...cockpitQuery } });
  const entries = q.data?.entries ?? [];
  const action = useCockpitAction();
  const [note, setNote] = useState("");
  const addNote = useAddAdminCockpitNote({
    mutation: {
      onSuccess: () => {
        setNote("");
        action.onDone("Note recorded");
      },
      onError: action.onError,
    },
  });
  const noteValid = note.trim().length >= 1;

  return (
    <Panel title="Audit timeline" testid="cockpit-audit">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add an operator note (recorded to the cockpit audit log)…"
          className="min-h-[40px] flex-1"
          data-testid="cockpit-note-input"
        />
        <Button
          disabled={!noteValid || addNote.isPending}
          onClick={() => addNote.mutate({ data: { note: note.trim(), targetType: "platform" } })}
          data-testid="cockpit-note-submit"
        >
          {addNote.isPending ? "Saving…" : "Add note"}
        </Button>
      </div>

      <SectionState query={q} empty={entries.length === 0} emptyLabel="No audit activity yet.">
        <ul className="space-y-2" data-testid="cockpit-audit-list">
          {entries.map((e) => (
            <li key={e.id} className="rounded-xl border border-border bg-background/40 p-2.5" data-testid={`cockpit-audit-${e.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="info">{e.source}</Chip>
                <span className="text-xs font-semibold text-foreground">{e.action}</span>
                {e.actorRole && <span className="text-[10px] text-txt-muted">by {e.actorRole}{e.actorId != null ? ` #${e.actorId}` : ""}</span>}
                {e.targetUserId != null && <span className="text-[10px] text-txt-muted">→ {e.targetType ?? "user"} #{e.targetUserId}</span>}
                <span className="ml-auto text-[10px] text-txt-muted">{timeAgo(e.createdAt)}</span>
              </div>
              {e.reason && <div className="mt-1 text-xs text-txt-secondary">Reason: {e.reason}</div>}
              {e.detail && <div className="text-[11px] text-txt-muted">{e.detail}</div>}
            </li>
          ))}
        </ul>
      </SectionState>
    </Panel>
  );
}
