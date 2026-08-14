import { Link, useLocation } from "wouter";
import {
  Target, Brain, Search, Activity, Menu, User,
  ShieldCheck, Wallet, Settings, HelpCircle, GraduationCap, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";

// App Shell 4.1 — mobile bottom nav surfaces the 5 most-used anchors per
// Nov-2025 nav spec: Cockpit · Trade · Scanner · AI · More/Me.
// Scanner has first-class bottom access because it drives trade discovery.
// Risk stays available in the side menu + Primary Tools group.
// The 5th slot is role-gated: ADMIN/OWNER see "More" → /admin/data-management;
// regular USER sees "Me" → /my-account. The backend rejects admin API
// calls from non-admins regardless; this just prevents a regular user
// from landing on an empty admin page skeleton.
//
// INVESTOR accounts are view-only and confined to the Investor Portal +
// universal account/help surfaces (matches INVESTOR_NAV_GROUPS in the sidebar
// and RouteAccessGuard containment). They must NEVER see Trade/Scanner/AI
// anchors, so they get a dedicated portal-scoped bottom bar.
interface BottomItem { href: string; label: string; icon: LucideIcon; arxId: string }

const BASE_ITEMS: readonly BottomItem[] = [
  { href: "/",                          label: "Cockpit", icon: Target,   arxId: "nav-cockpit" },
  { href: "/trade-command-room",        label: "Trade",   icon: Activity, arxId: "nav-trade" },
  { href: "/market-scanner",            label: "Scanner", icon: Search,   arxId: "nav-scanner" },
  { href: "/ai-command-center",         label: "AI",      icon: Brain,    arxId: "nav-ai" },
];
const ADMIN_TAIL: BottomItem = { href: "/admin/data-management", label: "More", icon: Menu, arxId: "nav-more" };
const USER_TAIL:  BottomItem = { href: "/my-account",            label: "Me",   icon: User, arxId: "nav-me"   };

// PENDING / unapproved human trader (Task #768) — reduced, non-execution bar.
// NO Trade/Scanner/AI anchors; just get-started, learn, and account surfaces,
// matching the reduced sidebar Essentials + Account groups and the pending
// route-allowlist in RouteAccessGuard.
const PENDING_ITEMS: readonly BottomItem[] = [
  { href: "/",           label: "Cockpit", icon: Target,        arxId: "nav-cockpit" },
  { href: "/school",     label: "Learn",   icon: GraduationCap, arxId: "nav-learn"   },
  { href: "/my-account", label: "Me",      icon: User,          arxId: "nav-me"      },
];

// Investor (view-only) bottom bar — Portal + universal account/help only.
const INVESTOR_ITEMS: readonly BottomItem[] = [
  { href: "/investor",   label: "Portal",   icon: ShieldCheck, arxId: "nav-portal"   },
  { href: "/my-account", label: "Account",  icon: Wallet,      arxId: "nav-account"  },
  { href: "/settings",   label: "Settings", icon: Settings,    arxId: "nav-settings" },
  { href: "/help",       label: "Help",     icon: HelpCircle,  arxId: "nav-help"     },
];

export function MobileBottomNav() {
  const [location] = useLocation();
  const { user } = useCurrentUser();
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isInvestor } = useProductRole();
  const { isApprovedTrader } = useTraderTier();
  void user;
  // Tier resolution: investor → portal bar; admin → full + admin tail; approved
  // human trader → full + Me tail; pending/unapproved (or loading approval) →
  // reduced non-execution bar.
  const ITEMS: BottomItem[] = isInvestor
    ? [...INVESTOR_ITEMS]
    : isAdmin
      ? [...BASE_ITEMS, ADMIN_TAIL]
      : isApprovedTrader
        ? [...BASE_ITEMS, USER_TAIL]
        : [...PENDING_ITEMS];
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-background border-t border-border pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary mobile navigation"
    >
      <div className="h-14 flex items-center justify-around">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = location === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex-1 h-full min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
              isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
            data-testid={`bottomnav-${item.href.replace(/\//g, "-") || "home"}`}
            data-arx-id={item.arxId}
            data-arx-label={item.label}
            data-arx-type="tab"
            data-arx-route={item.href}
          >
            <Icon size={20} aria-hidden="true" className={isActive ? "scale-110" : ""} />
            {item.label}
          </Link>
        );
      })}
      </div>
    </nav>
  );
}
