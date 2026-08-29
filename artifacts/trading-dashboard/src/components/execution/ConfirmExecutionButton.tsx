import React from "react";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";

interface Props {
  onClick: () => void;
  disabled?: boolean;
  verdict: "APPROVED" | "WARN" | "BLOCKED";
}

/**
 * Confirm Execution Button — Build F.
 * Hard-disabled when verdict is BLOCKED. Amber styling on WARN to make the
 * "I've read the warnings" decision deliberate.
 */
export function ConfirmExecutionButton({ onClick, disabled, verdict }: Props) {
  const meta = {
    APPROVED: { label: "Confirm Trade", icon: ShieldCheck, className: "bg-primary hover:bg-primary/90" },
    WARN:     { label: "Confirm Despite Warnings", icon: ShieldAlert, className: "bg-warning hover:bg-warning/90 text-black" },
    BLOCKED:  { label: "Cannot Confirm — Blocked", icon: ShieldX, className: "bg-muted text-muted-foreground cursor-not-allowed" },
  }[verdict];
  const Icon = meta.icon;
  return (
    <Button
      onClick={onClick}
      disabled={disabled || verdict === "BLOCKED"}
      className={`gap-2 ${meta.className}`}
      data-testid="button-confirm-execution"
    >
      <Icon size={14} />
      {meta.label}
    </Button>
  );
}
