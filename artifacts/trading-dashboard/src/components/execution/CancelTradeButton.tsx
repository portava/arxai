import React from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function CancelTradeButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={disabled} className="gap-2" data-testid="button-cancel-execution">
      <X size={14} />
      Cancel
    </Button>
  );
}
