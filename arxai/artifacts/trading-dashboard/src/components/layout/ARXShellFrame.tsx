import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutGrid, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { ARXLogoMark } from "@/components/brand/ARXLogo";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ContentWidth, DockMode, LayoutDensity } from "./shellLayoutModel";
import "./arx-shell-frame.css";

type ShellItemBase = {
  id: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
};

export type CockpitShellItem = ShellItemBase & {
  onSelect: () => void;
  href?: never;
};

export type PageShellItem = ShellItemBase & {
  href: string;
  onSelect?: never;
  onNavigate?: () => void;
};

export type ARXShellItem = CockpitShellItem | PageShellItem;

type ShellFrameBaseProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  dockMode?: DockMode;
  contentWidth?: ContentWidth;
  density?: LayoutDensity;
  routeContent?: boolean;
  contentClassName?: string;
  emergencyAction?: ReactNode;
  headerActions?: ReactNode;
  allToolsContent?: ReactNode;
  allToolsOpen: boolean;
  onAllToolsOpenChange: (open: boolean) => void;
  layoutMenuContent?: ReactNode;
  safetyNotice?: ReactNode;
  sectionNavigation?: ReactNode;
  children: ReactNode;
  mobileToolsOpen: boolean;
  onMobileToolsOpenChange: (open: boolean) => void;
  mobileTrayItems?: ARXShellItem[];
};

export type CockpitShellFrameProps = ShellFrameBaseProps & {
  variant: "cockpit";
  dockItems: CockpitShellItem[];
};

export type PageShellFrameProps = ShellFrameBaseProps & {
  variant: "page";
  dockItems: PageShellItem[];
};

export type ARXShellFrameProps = CockpitShellFrameProps | PageShellFrameProps;

function normalizePath(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function DockItem({
  item,
  variant,
  active,
}: {
  item: ARXShellItem;
  variant: ARXShellFrameProps["variant"];
  active: boolean;
}) {
  const Icon = item.icon;
  const className = `arx-shell-dock-item${active ? " is-active" : ""}`;
  const content = <>
    <Icon size={17} aria-hidden="true" />
    <span>{item.label}</span>
  </>;

  if (variant === "page" && "href" in item && item.href) {
    return <Link
      href={item.href}
      className={className}
      onClick={() => item.onNavigate?.()}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      data-testid={`shell-dock-${item.id}`}
    >{content}</Link>;
  }

  if ("onSelect" in item && item.onSelect) {
    return <button
      type="button"
      className={className}
      onClick={item.onSelect}
      aria-label={`Focus ${item.label}`}
      data-testid={`shell-dock-${item.id}`}
    >{content}</button>;
  }

  return null;
}

function TrayItem({
  item,
  variant,
  active,
}: {
  item: ARXShellItem;
  variant: ARXShellFrameProps["variant"];
  active: boolean;
}) {
  const Icon = item.icon;
  const className = `arx-shell-tray-item${active ? " is-active" : ""}`;
  const content = <>
    <Icon size={17} aria-hidden="true" />
    <span>{item.shortLabel ?? item.label}</span>
  </>;

  if (variant === "page" && "href" in item && item.href) {
    return <Link
      href={item.href}
      className={className}
      onClick={() => item.onNavigate?.()}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      data-testid={`shell-tray-${item.id}`}
    >{content}</Link>;
  }
  if ("onSelect" in item && item.onSelect) {
    return <button
      type="button"
      className={className}
      onClick={item.onSelect}
      aria-label={`Focus ${item.label}`}
      data-testid={`shell-tray-${item.id}`}
    >{content}</button>;
  }
  return null;
}

export function ARXShellFrame(props: ARXShellFrameProps) {
  const [location] = useLocation();
  const currentPath = normalizePath(location);
  const isActive = (item: ARXShellItem) =>
    props.variant === "page" && "href" in item && !!item.href &&
    normalizePath(item.href) === currentPath;

  return <div
    className="arx-shell-frame"
    data-variant={props.variant}
    data-dock-mode={props.dockMode ?? "expanded"}
    data-content-width={props.contentWidth ?? "fit"}
    data-density={props.density ?? "comfortable"}
  >
    <aside className="arx-shell-dock" aria-label={props.variant === "cockpit" ? "Workspace panels" : "Page navigation"}>
      <div className="arx-shell-mark" aria-label="ARX AI"><ARXLogoMark size="sm" mode="dark" /></div>
      <button
        type="button"
        className="arx-shell-dock-item arx-shell-all-tools"
        onClick={() => props.onAllToolsOpenChange(true)}
        aria-label="Open all tools"
        data-testid="button-shell-all-tools"
      >
        <LayoutGrid size={17} aria-hidden="true" />
        <span>All tools</span>
      </button>
      <nav className="arx-shell-dock-list" aria-label={props.variant === "cockpit" ? "Focus workspace panel" : "Navigate pages"}>
        {props.dockItems.map(item => <DockItem
          key={item.id}
          item={item}
          variant={props.variant}
          active={isActive(item)}
        />)}
      </nav>
      {props.emergencyAction && <div className="arx-shell-emergency-action">{props.emergencyAction}</div>}
      <span className="arx-shell-dock-caption" aria-hidden="true">ARX · COMMAND</span>
    </aside>

    <div className="arx-shell-main-column">
      <header className="arx-shell-header">
        <div className="arx-shell-mobile-brand" aria-label="ARX AI"><ARXLogoMark size="sm" mode="dark" /></div>
        <div className="arx-shell-heading">
          {props.eyebrow && <div className="arx-shell-eyebrow">{props.eyebrow}</div>}
          <h1>{props.title}</h1>
        </div>
        {props.layoutMenuContent && <details className="arx-shell-layout-menu">
          <summary aria-label="Open layout menu"><SlidersHorizontal size={15} aria-hidden="true" /><span>Layout</span></summary>
          <div className="arx-shell-layout-popover">{props.layoutMenuContent}</div>
        </details>}
        {props.headerActions && <div className="arx-shell-header-actions">{props.headerActions}</div>}
        <button
          type="button"
          className="arx-shell-mobile-tools"
          onClick={() => props.onMobileToolsOpenChange(true)}
          aria-label="Open mobile tools"
          data-testid="button-shell-mobile-tools"
        ><LayoutGrid size={17} aria-hidden="true" /></button>
      </header>

      {props.safetyNotice && <section className="arx-shell-safety-notice" aria-label="Safety notice">
        {props.safetyNotice}
      </section>}
      {props.sectionNavigation}

      <main
        id="main-content"
        className={`arx-shell-content${props.routeContent ? " arx-route-content" : ""}${props.contentClassName ? ` ${props.contentClassName}` : ""}`}
        tabIndex={-1}
      >
        {props.children}
      </main>
    </div>

    <Sheet open={props.allToolsOpen} onOpenChange={props.onAllToolsOpenChange}>
      <SheetContent side="right" className="arx-shell-sheet arx-shell-all-tools-sheet">
        <SheetHeader>
          <SheetTitle>All tools</SheetTitle>
        </SheetHeader>
        <div className="arx-shell-sheet-body">{props.allToolsContent}</div>
      </SheetContent>
    </Sheet>

    <Sheet open={props.mobileToolsOpen} onOpenChange={props.onMobileToolsOpenChange}>
      <SheetContent side="bottom" className="arx-shell-sheet arx-shell-mobile-sheet">
        <SheetHeader>
          <SheetTitle>{props.variant === "cockpit" ? "Workspace tools" : "Page navigation"}</SheetTitle>
        </SheetHeader>
        <nav className="arx-shell-mobile-sheet-items" aria-label="Mobile tools">
          {(props.mobileTrayItems ?? props.dockItems).map(item => <TrayItem
            key={item.id}
            item={item}
            variant={props.variant}
            active={isActive(item)}
          />)}
        </nav>
      </SheetContent>
    </Sheet>

    <nav className="arx-shell-mobile-tray" aria-label={props.variant === "cockpit" ? "Workspace tool tray" : "Page shortcuts"}>
      {(props.mobileTrayItems ?? props.dockItems).map(item => <TrayItem
        key={item.id}
        item={item}
        variant={props.variant}
        active={isActive(item)}
      />)}
      {props.emergencyAction && <div className="arx-shell-mobile-emergency">{props.emergencyAction}</div>}
      <button
        type="button"
        className="arx-shell-tray-item arx-shell-tray-tools"
        onClick={() => props.onAllToolsOpenChange(true)}
        aria-label="Open all tools"
        data-testid="button-shell-tray-tools"
      ><LayoutGrid size={17} aria-hidden="true" /><span>Tools</span></button>
    </nav>
  </div>;
}
