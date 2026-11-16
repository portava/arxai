import type { ReactNode } from "react";
import { LiveModeBadge } from "@/components/live/LiveModeBadge";
import { SafetyHeader } from "@/components/ss/SafetyHeader";
import NotificationCenter from "@/components/NotificationCenter";
import { MobileMenuTrigger, Topbar } from "./Topbar";

export function GlobalHeader({
  sidebarContent,
}: {
  sidebarContent: (onNavigate: () => void) => ReactNode;
}) {
  return <>
    <Topbar
      onMobileMenu={
        <MobileMenuTrigger>
          {(close) => sidebarContent(close)}
        </MobileMenuTrigger>
      }
    />
    <div className="flex items-center justify-between gap-2 border-b border-zinc-900 bg-zinc-950/60 px-4 py-1">
      <LiveModeBadge />
      <NotificationCenter />
    </div>
    <SafetyHeader />
  </>;
}
