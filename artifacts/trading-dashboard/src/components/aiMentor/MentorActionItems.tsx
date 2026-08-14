import { Play, Check, SkipForward } from "lucide-react";
import type { MentorActionItem } from "./types";
import { useAssistantName } from "@/lib/assistant-name";

const STATUS_LABEL: Record<MentorActionItem["status"], string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
  SKIPPED: "Skipped",
};
const STATUS_TONE: Record<MentorActionItem["status"], string> = {
  PENDING: "border-border bg-secondary/60 text-txt-secondary",
  IN_PROGRESS: "border-primary/40 bg-primary/10 text-primary",
  DONE: "border-success/40 bg-success/10 text-success",
  SKIPPED: "border-border bg-secondary/40 text-txt-muted",
};

export function MentorActionItems({ items, onChangeStatus }:
  { items: MentorActionItem[]; onChangeStatus?: (id: number, status: MentorActionItem["status"]) => void }) {
  const { name } = useAssistantName();
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-txt-muted">
        No action items right now. {name} will add them after coaching, trade reviews, or weekly reset.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/50">
      {items.map((it) => {
        const done = it.status === "DONE";
        return (
          <li key={it.id} className="flex items-center gap-3 py-3" data-testid={`action-item-${it.id}`}>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${done ? "border-success bg-success/20 text-success" : "border-border"}`}>
              {done && <Check className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${done ? "text-txt-muted line-through" : "text-foreground"}`}>{it.actionTitle}</div>
              <div className="text-[11px] text-txt-muted">{it.actionDescription}</div>
            </div>
            <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[it.status]}`}>
              {STATUS_LABEL[it.status]}
            </span>
            {onChangeStatus && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => onChangeStatus(it.id, "IN_PROGRESS")}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-border text-primary hover:bg-primary/10"
                  title="Start / In progress" aria-label="Start"
                  data-testid={`action-start-${it.id}`}
                >
                  <Play className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onChangeStatus(it.id, "DONE")}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-border text-success hover:bg-success/10"
                  title="Done" aria-label="Done"
                  data-testid={`action-done-${it.id}`}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onChangeStatus(it.id, "SKIPPED")}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-border text-txt-muted hover:bg-secondary"
                  title="Skip" aria-label="Skip"
                  data-testid={`action-skip-${it.id}`}
                >
                  <SkipForward className="h-4 w-4" />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
