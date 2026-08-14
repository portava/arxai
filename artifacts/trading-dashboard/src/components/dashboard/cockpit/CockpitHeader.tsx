// Cockpit-only header — matches the mockup (menu · shield+ARX AI · symbol
// pill · bell · profile). Renders inside the Cockpit page only; the shared
// Topbar is hidden on "/" so other pages are unaffected. All pieces reuse
// existing wiring: SymbolPicker (active-symbol state), NotificationBell
// (notification count), useCurrentUser/useLogout (profile + sign out).

import type { ReactNode } from "react";
import { User as UserIcon } from "lucide-react";
import { ARXLogoMark, ARXWordmark } from "@/components/brand/ARXLogo";
import { SymbolPicker } from "@/components/layout/SymbolPicker";
import { NotificationBell } from "@/components/alerts/NotificationBell";
import { useCurrentUser, useLogout } from "@/hooks/useCurrentUser";
import { Button } from "@/components/ui/button";

export function CockpitHeader({ onMobileMenu }: { onMobileMenu?: ReactNode }) {
  const { user } = useCurrentUser();
  const logout = useLogout();

  return (
    <header className="sticky top-0 z-30 -mx-3 -mt-3 mb-1 border-b border-border bg-background/80 px-3 py-2.5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
      <div className="flex items-center gap-3">
        {/* menu (mobile drawer trigger, if provided) */}
        {onMobileMenu}

        {/* brand — always visible, matches mockup */}
        <div className="flex items-center gap-2.5" data-testid="cockpit-brand">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 ring-1 ring-primary/25">
            <ARXLogoMark size="sm" mode="dark" />
          </span>
          <ARXWordmark size="md" mode="dark" />
        </div>

        {/* centered symbol pill */}
        <div className="mx-auto flex max-w-[260px] flex-1 items-center justify-center">
          <SymbolPicker />
        </div>

        {/* bell + profile */}
        <div className="flex items-center gap-1">
          <NotificationBell />
          {user && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              data-testid="button-logout"
              title={user.name || user.email || "Account"}
              aria-label="Sign out"
            >
              <UserIcon className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
