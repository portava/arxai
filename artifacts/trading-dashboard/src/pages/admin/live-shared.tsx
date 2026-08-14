import { Link } from "wouter";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveSharedAccountPanel } from "@/components/admin/LiveSharedAccountPanel";
import { T015ManualLiveStatusCard } from "@/components/live/T015ManualLiveStatusCard";


export default function AdminLiveSharedPage() {
  return (
    <div className="space-y-2">
      <div className="container mx-auto px-3 md:px-6 pt-3 flex justify-end">
        <Link href="/admin/live-shared/activation">
          <Button size="sm" variant="outline" data-testid="link-activation">
            <ShieldAlert className="h-3.5 w-3.5 mr-1 text-warning" />
            Open Activation Cockpit
          </Button>
        </Link>
      </div>
      {/* Advanced Technical Details — collapsed by default so admins are not
          confronted with raw component/api/schema labels in the main UI. */}
      <div className="container mx-auto px-3 md:px-6"
           data-testid="admin-build-marker">
        <details className="rounded border border-border bg-background/40 px-3 py-2 text-xs text-txt-secondary">
          <summary className="cursor-pointer text-txt-secondary">Advanced Technical Details</summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
          </div>
        </details>
      </div>
      <T015ManualLiveStatusCard />
      <LiveSharedAccountPanel />
    </div>
  );
}
