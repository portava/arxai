import React from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";
import type { LucideIcon } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Extract<StatusTone, "danger" | "warning" | "info" | "success">;
  icon?: LucideIcon;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "danger", icon: Icon, onConfirm, loading, children,
}: Props) {
  const colors = STATUS_COLORS[tone];

  const handleConfirm = async () => {
    await onConfirm();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border-card-border">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {Icon && (
              <span className={cn("inline-flex items-center justify-center w-8 h-8 rounded-full", colors.bg, colors.text)}>
                <Icon size={16} />
              </span>
            )}
            {title}
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="text-sm">{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children && <div className="text-sm">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading} data-testid="confirm-cancel">{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={loading}
            className={cn(tone === "danger" && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
            data-testid="confirm-action"
          >
            {loading ? "Working..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
