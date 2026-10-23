import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type PageTab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  content: React.ReactNode;
};

export interface PageTabsProps {
  tabs: PageTab[];
  defaultTab?: string;
  storageKey?: string;
  className?: string;
  /** Visual style. "default" keeps existing look; "pill" gives an ARX-blue
   *  active tab (used by the redesigned Scanner). */
  variant?: "default" | "pill";
  /** Optional listener so parent pages can react to tab switches. */
  onTabChange?: (id: string) => void;
}

/**
 * Mobile-friendly page-level tabs. Persists the active tab per page in
 * localStorage when storageKey is provided so a user returning to the
 * page lands on the tab they were last using. Defaults to the first tab.
 * The TabsList scrolls horizontally on narrow viewports so 4+ tabs never
 * cause the page itself to overflow.
 */
export function PageTabs(props: PageTabsProps) {
  const { tabs, defaultTab, storageKey, className, variant = "default", onTabChange } = props;
  const first = tabs[0]?.id ?? "";
  const initial = (() => {
    if (!storageKey || typeof window === "undefined") return defaultTab ?? first;
    try {
      const saved = window.localStorage.getItem(`arx.pageTab.${storageKey}`);
      if (saved && tabs.some((t) => t.id === saved)) return saved;
    } catch { /* localStorage may be blocked */ }
    return defaultTab ?? first;
  })();
  const [active, setActive] = React.useState(initial);

  function handleChange(next: string) {
    setActive(next);
    if (storageKey && typeof window !== "undefined") {
      try { window.localStorage.setItem(`arx.pageTab.${storageKey}`, next); } catch { /* ignore */ }
    }
    onTabChange?.(next);
  }

  return (
    <Tabs value={active} onValueChange={handleChange} className={cn("w-full", className)}>
      <div className="overflow-x-auto -mx-1 px-1 scrollbar-thin">
        <TabsList
          className={cn(
            "inline-flex w-auto min-w-full justify-start gap-1",
            variant === "pill" && "rounded-xl border border-border bg-card p-1",
          )}
          data-testid="page-tabs-list"
        >
          {tabs.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className={cn(
                "flex items-center gap-1.5 px-3 whitespace-nowrap",
                variant === "pill" &&
                  "rounded-lg text-txt-secondary data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-none",
              )}
              data-testid={`page-tab-${t.id}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-4 focus-visible:outline-none">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
