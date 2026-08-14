// Admin Fund Control Center — the unified admin/OWNER command center for the
// Fund Book (tasks #131–135). It surfaces the already-built backend (pools,
// broker mirror, P/L allocation, reconciliation/discrepancies) and the two
// sections no page rendered before: the Capital Movements approval queue and
// Fee Settings. Strong existing pages (investors, allocations, reconciliation,
// master bridge, audit) are deep-linked rather than duplicated.
//
// SAFETY: admin/OWNER only via AdminDiagnosticsGate (admin-previewing-as-user is
// also blocked). Broker data is mirrored (read) only. Every mutation routes
// through a ≥3-char reason dialog for the server-side audit log. Nothing here
// touches live execution, the 16-gate evaluator, or the EA.

import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LayoutDashboard,
  Layers,
  Server,
  ShieldAlert,
  Banknote,
  Settings2,
  Compass,
  Waves,
} from "lucide-react";
import { OverviewSection } from "@/components/admin/fundControl/OverviewSection";
import { PoolsSection } from "@/components/admin/fundControl/PoolsSection";
import { BrokerMirrorsSection } from "@/components/admin/fundControl/BrokerMirrorsSection";
import { DiscrepancySection } from "@/components/admin/fundControl/DiscrepancySection";
import { CapitalMovementsSection } from "@/components/admin/fundControl/CapitalMovementsSection";
import { FeeSettingsSection } from "@/components/admin/fundControl/FeeSettingsSection";
import { WaterfallSection } from "@/components/admin/fundControl/WaterfallSection";
import { DeepLinksSection } from "@/components/admin/fundControl/DeepLinksSection";

const TABS = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "pools", label: "Strategy Pools", icon: Layers },
  { value: "mirrors", label: "Broker Mirrors", icon: Server },
  { value: "discrepancies", label: "Discrepancies", icon: ShieldAlert },
  { value: "capital", label: "Capital Movements", icon: Banknote },
  { value: "fees", label: "Fee Settings", icon: Settings2 },
  { value: "waterfall", label: "Profit Waterfall", icon: Waves },
  { value: "links", label: "More", icon: Compass },
] as const;

export default function FundControlCenterPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Fund Control Center"
      pageDescription="Operator command center for the ARX fund book."
    >
      <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6 pb-32 md:pb-6" data-testid="fund-control-center">
        <header className="space-y-1">
          <h1 className="text-2xl font-black tracking-tight">Fund Control Center</h1>
          <p className="text-sm text-muted-foreground">
            One place to oversee pools, broker mirrors, reconciliation, the capital
            approval queue and fee policy. Broker figures are mirrored read-only;
            every action is reason-gated and audited.
          </p>
        </header>

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`} className="gap-1">
                <t.icon className="h-4 w-4" />
                <span className="hidden sm:inline">{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview">
            <OverviewSection />
          </TabsContent>
          <TabsContent value="pools">
            <PoolsSection />
          </TabsContent>
          <TabsContent value="mirrors">
            <BrokerMirrorsSection />
          </TabsContent>
          <TabsContent value="discrepancies">
            <DiscrepancySection />
          </TabsContent>
          <TabsContent value="capital">
            <CapitalMovementsSection />
          </TabsContent>
          <TabsContent value="fees">
            <FeeSettingsSection />
          </TabsContent>
          <TabsContent value="waterfall">
            <WaterfallSection />
          </TabsContent>
          <TabsContent value="links">
            <DeepLinksSection />
          </TabsContent>
        </Tabs>
      </div>
    </AdminDiagnosticsGate>
  );
}
