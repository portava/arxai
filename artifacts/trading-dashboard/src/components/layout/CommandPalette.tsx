// Universal Command Palette — Ctrl/Cmd+K. Routes the user to any page,
// or triggers a safe tester action. Read-only navigation; never executes
// real broker orders.
//
// Role visibility: items flagged `admin: true` are advanced / operator /
// tester / `/admin/*` surfaces and are filtered out for non-admin sessions —
// the remaining (non-admin) set is a safe subset of the normal-user route
// allowlist (see routeAccess.ts), so a regular trader never sees admin pages,
// tester tools, or raw `/admin/*` internal paths in the palette, and no entry
// redirects home. INVESTOR (view-only) accounts get no palette at all. Backend
// route guards remain authoritative either way.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { useViewMode } from "@/hooks/useViewMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";
import { DEFAULT_ASSISTANT_NAME, useAssistantName } from "@/lib/assistant-name";

export interface CommandPaletteItem { label: string; hint?: string; href: string; admin?: boolean; approvedOnly?: boolean; }

/**
 * Source-of-truth command registry. Exported so the regression guard
 * (CommandPalette.normalUser.test.tsx) can inspect the FULL command set
 * deterministically, rather than the truncated 12-row no-query DOM view.
 * Every entry navigates (has an `href`); there are no pure-action commands.
 */
function buildCommandPaletteItems(name: string): CommandPaletteItem[] {
  return [
  // Command
  { label: "Dashboard",                  href: "/" },
  { label: "ARX Status",                 href: "/status-command-center", hint: "Platform readiness" },
  { label: "Trading School",             href: "/school", hint: "Learn trading" },
  { label: "Account",                    href: "/my-account" },
  { label: "Settings",                   href: "/settings" },
  { label: "Help",                       href: "/help" },
  { label: "Trade Command Room",         href: "/trade-command-room", approvedOnly: true },
  { label: "Live Chart",                 href: "/live-chart", approvedOnly: true },
  { label: "Testing Control Center",     href: "/testing-control-center", admin: true },
  { label: "Admin Cockpit",              href: "/admin/cockpit", admin: true },
  // Trading
  { label: "Manual Trade Ticket",        href: "/orders", hint: "Order entry", approvedOnly: true },
  { label: "Demo Trading",               href: "/trade-command-room", hint: "Simulator", approvedOnly: true },
  { label: "Live Manual Tester",         href: "/live-manual", admin: true },
  { label: "Live AI Assist Tester",      href: "/live-ai-assist", admin: true },
  { label: "Live AI Auto Tester",        href: "/live-ai-auto-test", admin: true },
  { label: "Live Intent Queue",          href: "/live-intent-queue", admin: true },
  // AI
  { label: "Market Scanner",             href: "/market-scanner", approvedOnly: true },
  { label: "Market Heat Map",            href: "/market-heat-map", hint: "Heat scores, news heat, broad flow", approvedOnly: true },
  { label: "AI Coach",                   href: "/ai-coach", admin: true },
  { label: "Autopilot Control Center",   href: "/autopilot-control-center", admin: true },
  { label: "Shadow Mode",                href: "/testing-lab?tab=shadow", admin: true },
  { label: "AI Readiness Score",         href: "/ai-readiness-score", admin: true },
  // Strategy
  { label: "Strategy Lab",               href: "/strategy-lab", admin: true },
  { label: "Testing Lab",                href: "/testing-lab", admin: true },
  { label: "Market Replay",              href: "/market-replay", admin: true },
  { label: "Trade Grader",               href: "/trade-grader", admin: true },
  { label: "Strategy Tournament",        href: "/testing-lab?tab=tournament", admin: true },
  { label: "Strategy Promotion",         href: "/testing-lab?tab=promotion", admin: true },
  { label: "Confidence Calibration",     href: "/confidence-calibration", admin: true },
  // Risk
  { label: "Risk Command Center",        href: "/risk-command-center", approvedOnly: true },
  { label: "Risk Profile",               href: "/risk-profile", approvedOnly: true },
  { label: "Risk Events",                href: "/risk-events", admin: true },
  { label: "Market Health",              href: "/market-health", admin: true },
  { label: "News Risk",                  href: "/news-risk", approvedOnly: true },
  { label: "Data Quality",               href: "/data-quality", admin: true },
  { label: "Prop Firm Mode",             href: "/prop-firm-mode", admin: true },
  // Records
  { label: "Orders",                     href: "/orders", approvedOnly: true },
  { label: "Positions",                  href: "/positions", approvedOnly: true },
  { label: "Approval Inbox",             href: "/approval-inbox", approvedOnly: true },
  { label: "Journal",                    href: "/shadow-journal", approvedOnly: true },
  { label: "Scalp Journal",              href: "/scalp-journal", hint: `${name} scalp history & lessons`, approvedOnly: true },
  { label: "Calendar",                   href: "/trading-calendar", approvedOnly: true },
  { label: "Performance Scorecard",      href: "/performance-scorecard", approvedOnly: true },
  { label: "Audit Vault",                href: "/audit-vault", admin: true },
  { label: "Safety Logs",                href: "/safety-logs", admin: true },
  // Broker
  { label: "Broker (READ ONLY)",         href: "/broker-readonly", admin: true },
  { label: "Broker Reconciliation",      href: "/broker-reconciliation", admin: true },
  // Admin
  { label: "Self-Trade AI",              href: "/self-trade-ai", admin: true, hint: "Funded autonomous agent fleet" },
  { label: "Permissions",                href: "/admin/permissions", admin: true },
  { label: "Data Management",            href: "/admin/data-management", admin: true },
  { label: "Security Status",            href: "/admin/security-status", admin: true },
  { label: "System Health",              href: "/admin/system-health", admin: true },
  { label: "Risk Governor",              href: "/risk-settings", admin: true },
  { label: "Notifications",              href: "/notifications" },
  // Beta release (Build UU)
  { label: "Release Status",             href: "/release-status", admin: true },
  { label: "Release Notes",              href: "/release-notes", admin: true },
  { label: "Feedback Center",            href: "/feedback-center", admin: true },
  { label: "Issue Tracker",              href: "/admin/issues", admin: true },
  { label: "Diagnostics Export",         href: "/admin/diagnostics", admin: true },
  { label: "Emergency Stop",             href: "/emergency", hint: "Kill switch" },
  ];
}

/**
 * Default-named registry snapshot. Exported so the regression guard
 * (CommandPalette.normalUser.test.tsx) can inspect the FULL command set
 * deterministically; the live component renders the per-user named set via
 * `buildCommandPaletteItems(name)`.
 */
export const COMMAND_PALETTE_ITEMS: CommandPaletteItem[] = buildCommandPaletteItems(DEFAULT_ASSISTANT_NAME);

/**
 * Pure resolver of which command items a given session may see — the single
 * source of truth for palette role-visibility. INVESTOR (view-only) accounts
 * see NONE; admin/owner sees everything. Human traders are two-tier (Task
 * #768): an APPROVED (live / shared-bridge) trader sees every non-admin item,
 * while a PENDING / unapproved trader (or one whose approval is still loading)
 * sees only the non-admin, non-`approvedOnly` subset (dashboard, ARX status,
 * school, account, settings, help, notifications, emergency). The regression
 * guard resolves these sets deterministically rather than scraping the DOM.
 */
export function visibleCommandPaletteItems(
  opts: { isAdmin: boolean; isInvestor: boolean; isApprovedTrader?: boolean },
  items: CommandPaletteItem[] = COMMAND_PALETTE_ITEMS,
): CommandPaletteItem[] {
  if (opts.isInvestor) return [];
  return items.filter((i) => {
    if (i.admin) return opts.isAdmin;
    if (i.approvedOnly) return opts.isAdmin || Boolean(opts.isApprovedTrader);
    return true;
  });
}

export function CommandPalette() {
  const [, setLocation] = useLocation();
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isInvestor } = useProductRole();
  const { isApprovedTrader } = useTraderTier();
  const { name } = useAssistantName();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === "Escape" && open) { setOpen(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); else { setQ(""); setHi(0); } }, [open]);

  const items = useMemo(() => buildCommandPaletteItems(name), [name]);
  const visibleItems = useMemo(() => visibleCommandPaletteItems({ isAdmin, isInvestor, isApprovedTrader }, items), [isAdmin, isInvestor, isApprovedTrader, items]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return visibleItems.slice(0, 12);
    return visibleItems.filter((i) => i.label.toLowerCase().includes(term) || i.href.includes(term) || (i.hint?.toLowerCase().includes(term) ?? false)).slice(0, 30);
  }, [q, visibleItems]);

  function go(item: CommandPaletteItem) { setOpen(false); setLocation(item.href); }

  // INVESTOR (view-only) accounts never get the command palette.
  if (isInvestor) return null;

  if (!open) return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette"
      data-testid="cmdk-trigger"
      className="fixed bottom-20 left-3 md:bottom-6 md:left-6 z-40 inline-flex items-center gap-2 rounded-full border bg-background/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
    >
      <Search size={14} /> <span className="hidden md:inline">Search</span> <kbd className="ml-1 hidden md:inline rounded border px-1 text-[10px]">Ctrl K</kbd>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-20" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Command palette" data-testid="cmdk-dialog">
      <div className="w-full max-w-xl rounded-lg border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search size={16} className="text-muted-foreground" />
          <input
            ref={inputRef} value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); const item = results[hi]; if (item) go(item); }
            }}
            placeholder="Search pages, symbols, actions…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="cmdk-input"
          />
          <kbd className="rounded border px-1 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted-foreground">No matches.</li>}
          {results.map((it, i) => (
            <li key={it.href + it.label}>
              <button
                onMouseEnter={() => setHi(i)}
                onClick={() => go(it)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${i === hi ? "bg-muted" : ""}`}
                data-testid={`cmdk-result-${it.href.replace(/\//g, "-") || "home"}`}
              >
                <span>{it.label}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{it.hint ?? it.href}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
