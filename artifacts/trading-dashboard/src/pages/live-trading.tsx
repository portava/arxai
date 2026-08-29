import { LiveTradingUnlockCard } from "@/components/live/LiveTradingUnlockCard";
import { RequestLiveBridgeAccessCard } from "@/components/live/RequestLiveBridgeAccessCard";
import { LiveKillSwitchButton } from "@/components/live/LiveKillSwitchButton";
import { LiveSettingsCard } from "@/components/live/LiveSettingsCard";
import { OpenLivePositions } from "@/components/live/OpenLivePositions";
import { RecentLiveCommands } from "@/components/live/RecentLiveCommands";
import { LiveEaHeartbeatDebugCard } from "@/components/live/LiveEaHeartbeatDebugCard";
import { CopyLiveEaInputsCard } from "@/components/live/CopyLiveEaInputsCard";
import { MasterLiveBridgeBanner } from "@/components/live/MasterLiveBridgeBanner";
import { MasterLiveAccessBanner } from "@/components/live/MasterLiveAccessGuard";
import { LiveReadinessStatusCard } from "@/components/readiness/LiveReadinessStatusCard";
import { ShieldAlert } from "lucide-react";

export default function LiveTradingPage() {
  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-7xl mx-auto w-full space-y-4">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-danger" /> Live Trading
        </h1>
        <p className="text-sm text-muted-foreground">
          Protected, gated, logged, reversible. Demo trading is unaffected by anything on this page.
        </p>
      </header>

      <LiveReadinessStatusCard />
      <MasterLiveBridgeBanner />
      <MasterLiveAccessBanner />
      <RequestLiveBridgeAccessCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveEaHeartbeatDebugCard />
        <CopyLiveEaInputsCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveTradingUnlockCard />
        <div className="space-y-4">
          <LiveKillSwitchButton />
          <LiveSettingsCard />
        </div>
      </div>

      <OpenLivePositions />
      <RecentLiveCommands />
    </div>
  );
}
