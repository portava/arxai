import React from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

export interface PreTradeWarningModalProps {
  open: boolean;
  status: "CLEAR" | "CAUTION" | "LOCKED" | "LIVE_TRADING_DISABLED";
  headline: string;
  detail: string;
  recommendation: string;
  blockers: string[];
  warnings: string[];
  onCancel: () => void;
  /** Only enabled when status === "CAUTION" — proceed despite warnings. */
  onProceed?: () => void;
}

export function PreTradeWarningModal(props: PreTradeWarningModalProps) {
  const isLocked = props.status === "LOCKED" || props.status === "LIVE_TRADING_DISABLED";

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldAlert size={18} className={isLocked ? "text-danger" : "text-warning"} />
            {props.headline}
          </DialogTitle>
          <DialogDescription>{props.detail}</DialogDescription>
        </DialogHeader>

        {props.blockers.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="text-danger font-semibold">Blockers</div>
            <ul className="list-disc list-inside text-danger/80 space-y-0.5">
              {props.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {props.warnings.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="text-warning font-semibold">Warnings</div>
            <ul className="list-disc list-inside text-warning/80 space-y-0.5">
              {props.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        <div className="text-xs text-txt-secondary italic border-l-2 border-border pl-3 mt-2">
          → {props.recommendation}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={props.onCancel}>
            {isLocked ? "Close" : "Cancel"}
          </Button>
          {!isLocked && props.onProceed && (
            <Button variant="default" onClick={props.onProceed} className="bg-warning hover:bg-warning">
              Proceed despite warnings
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
