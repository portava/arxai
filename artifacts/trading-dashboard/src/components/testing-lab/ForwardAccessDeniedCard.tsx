// Shared access-denied card for the Testing Lab tabs that read the admin-gated
// /api/forward-testing/* endpoints.
//
// HONESTY (audit rank 69): ComparisonTab and ResultsHistoryTab used to let the
// 403 fall through to `?? 0`, so a non-admin was told there were no forward-test
// results when results existed and were merely not visible to them — and the
// drift verdict was then computed as if the sample were genuinely zero. All
// three tabs now render this one card instead. "No data" is reserved for an
// actually empty result.

import { Card, CardContent } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

export function ForwardAccessDeniedCard({ what = "Forward Testing" }: { what?: string }) {
  return (
    <Card className="mt-2 border-warning/40 bg-warning/10">
      <CardContent className="p-4 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-warning mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-warning">
            Access denied — Admin or Owner role required for {what}.
          </p>
          <p className="text-xs text-warning/70 mt-1">
            Forward-test results observe SHADOW (non-live) data and are restricted to
            Admin and Owner sessions. Results may exist; they are not readable by this
            session, so nothing here is shown as zero. Backtesting and the other
            Testing Lab tabs remain available to you.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** True for the two statuses that mean "you may not read this", not "empty". */
export function isAccessDeniedStatus(status: number): boolean {
  return status === 401 || status === 403;
}
