import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Menu, User, Sun, Moon } from "lucide-react";
import { ARXLogoMark } from "@/components/brand/ARXLogo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LiveModeBadge } from "@/components/live/LiveModeBadge";
import NotificationCenter from "@/components/NotificationCenter";
import { SymbolPicker } from "./SymbolPicker";
import { ViewModeSwitch, UserMenu } from "./Topbar";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";
import {
  workspaceTabs,
  workspaceTabForPath,
  workspaceSubnav,
} from "./workspaceNavigation";

export function WorkspaceHeader({
  menu,
  theme,
  onThemeChange,
}: {
  menu: (close: () => void) => ReactNode;
  theme: "light" | "dark";
  onThemeChange: () => void;
}) {
  const [location] = useLocation();
  const [more, setMore] = useState(false);
  const { isLoading } = useCurrentUser();
  const { effectiveIsAdmin } = useViewMode();
  const { isInvestor } = useProductRole();
  const { isApprovedTrader, isLoading: tierLoading } = useTraderTier();
  const access = {
    isInvestor,
    isAdmin: effectiveIsAdmin,
    isApprovedTrader,
    isLoading: isLoading || (!effectiveIsAdmin && !isInvestor && tierLoading),
  };
  const tabs = workspaceTabs(access),
    active = workspaceTabForPath(location, tabs),
    subnav = workspaceSubnav(location, access);
  function arrowNav(e: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a")];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? links.length - 1
          : (at + (e.key === "ArrowRight" ? 1 : -1) + links.length) %
            links.length;
    links[next]?.focus();
  }
  return (
    <>
      <header className="workspace-header" data-testid="workspace-header">
        <Link
          href={isInvestor ? "/investor" : "/"}
          className="workspace-brand"
          aria-label="ARX overview"
        >
          <ARXLogoMark size={27} mode={theme} />
          <strong>ARX</strong>
        </Link>
        <nav
          className="workspace-tabs"
          aria-label="Workspace sections"
          onKeyDown={arrowNav}
        >
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active?.href === tab.href ? "page" : undefined}
              className={active?.href === tab.href ? "active" : ""}
              data-testid={`workspace-tab-${tab.label.split(" ")[0].toLowerCase()}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="workspace-header-actions">
          <LiveModeBadge />
          <NotificationCenter />
          <Sheet>
            <SheetTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Account and connection"
              >
                <User size={18} />
              </Button>
            </SheetTrigger>
            <SheetContent className="workspace-account">
              <SheetTitle>Account & connection</SheetTitle>
              <SheetDescription>
                Your account, selected market and workspace appearance.
              </SheetDescription>
              <div className="space-y-6 pt-6">
                <UserMenu />
                <ViewModeSwitch />
                {!isInvestor && (
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">
                      Selected market
                    </p>
                    <SymbolPicker />
                  </div>
                )}
                <Button variant="outline" onClick={onThemeChange}>
                  {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
                  <span className="ml-2">
                    Use {theme === "light" ? "dark" : "light"} appearance
                  </span>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet open={more} onOpenChange={setMore}>
            <SheetTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="All tools and settings"
              >
                <Menu size={20} />
              </Button>
            </SheetTrigger>
            <SheetContent
              className="w-[340px] max-w-[95vw] p-0 pt-12"
              side="right"
            >
              <SheetTitle className="absolute top-4 left-5">
                All tools
              </SheetTitle>
              <SheetDescription className="sr-only">
                Search or browse the existing ARX tools available to your
                account.
              </SheetDescription>
              {menu(() => setMore(false))}
            </SheetContent>
          </Sheet>
        </div>
      </header>
      {subnav.length > 0 && (
        <nav className="workspace-subnav" aria-label={`${active?.label} tools`}>
          {subnav.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={
                location.split("?")[0] === link.href ? "page" : undefined
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
