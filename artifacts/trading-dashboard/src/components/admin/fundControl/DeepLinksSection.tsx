// Deep links — the Fund Control Center is the front door. Rather than duplicate
// the already-strong investor, audit, reconciliation, allocation, and master
// bridge pages, link out to them so there is one place to manage the fund.

import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import {
  Users,
  ScrollText,
  ShieldAlert,
  Server,
  Layers,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";

const LINKS: Array<{ href: string; title: string; body: string; icon: LucideIcon; testid: string }> = [
  {
    href: "/admin/investors",
    title: "Investor Management",
    body: "Review investor accounts, holdings, statements and per-user fund activity.",
    icon: Users,
    testid: "deeplink-investors",
  },
  {
    href: "/admin/allocations",
    title: "Allocations",
    body: "Manage strategy-pool allocation policy and per-user capital allocation.",
    icon: Layers,
    testid: "deeplink-allocations",
  },
  {
    href: "/admin/reconciliation-center",
    title: "Reconciliation Center",
    body: "Full discrepancy controls including freezes and capacity limits.",
    icon: ShieldAlert,
    testid: "deeplink-reconciliation",
  },
  {
    href: "/admin/master-bridge",
    title: "Master Bridge",
    body: "Operator controls for MT5 bridges: rotate tokens, watchdog, emergency close.",
    icon: Server,
    testid: "deeplink-master-bridge",
  },
  {
    href: "/admin/audit-center",
    title: "Audit Logs",
    body: "Every reason-gated admin action is recorded here for review.",
    icon: ScrollText,
    testid: "deeplink-audit",
  },
];

export function DeepLinksSection() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="deeplinks-section">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href}>
          <a data-testid={l.testid}>
            <Card className="h-full transition-colors hover:border-primary/60">
              <CardContent className="flex items-start gap-3 p-4">
                <l.icon className="mt-0.5 h-5 w-5 text-primary" />
                <div className="flex-1">
                  <p className="flex items-center justify-between font-semibold">
                    {l.title}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{l.body}</p>
                </div>
              </CardContent>
            </Card>
          </a>
        </Link>
      ))}
    </div>
  );
}
