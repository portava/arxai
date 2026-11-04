import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Home, Shield, AlertOctagon, LogOut } from "lucide-react";
import { ARXShellFrame } from "@/components/layout/ARXShellFrame";
import { NotificationBell } from "@/components/alerts/NotificationBell";
import { SafetyHeader } from "@/components/ss/SafetyHeader";
import { EnvironmentPill } from "@/components/dashboard/cockpit/EnvironmentPill";
import "@/index.css";

const title = "Risikoüberwachung und Sicherheitsbenachrichtigungen für internationale Handelskonten";
const account = "Demonstrationskonto — Internationales Sicherheitsprüfungsportfolio — Nur lesender Zugriff";
const notices = [
  "Trading remains paused while account permissions and the independent risk review are checked. No order can be submitted from this fixture.",
  "Die Verbindung zum Broker ist nicht verfügbar. Bitte überprüfen Sie die Sicherheitsinformationen und die Kontoberechtigungen.",
  "RiskReviewReferenceWithoutWhitespace".repeat(5),
];
const items = [
  { id: "cockpit", label: "Cockpit", shortLabel: "Desk", href: "/", icon: Home },
  { id: "risk", label: "Risk", href: "/risk-command-center", icon: Shield },
];

function Fixture() {
  const params = new URLSearchParams(location.search);
  const cockpit = params.get("variant") === "cockpit";
  const [allToolsOpen, setAllToolsOpen] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [compact, setCompact] = useState(params.get("dock") === "compact");
  const [selected, setSelected] = useState("cockpit");
  const [action, setAction] = useState("");
  const common = {
    title, eyebrow: "ARX · KONTROLLIERTE SICHERHEITSÜBERPRÜFUNG · ISOLATED FIXTURE",
    dockMode: compact ? "compact" as const : "expanded" as const,
    allToolsOpen, onAllToolsOpenChange: setAllToolsOpen,
    mobileToolsOpen, onMobileToolsOpenChange: setMobileToolsOpen,
    layoutMenuContent: <div className="arx-shell-layout-controls">
      <fieldset className="arx-shell-layout-choice"><legend>Dock</legend><div>
        <button aria-pressed={!compact} onClick={() => setCompact(false)}>Expanded</button>
        <button aria-pressed={compact} onClick={() => setCompact(true)}>Compact</button>
      </div></fieldset>
    </div>,
    allToolsContent: <div className="arx-shell-tools">
      <button className="arx-shell-tool-result" onClick={() => { setAction("tools"); setAllToolsOpen(false); }}>Fixture risk information</button>
    </div>,
    // Same slot hierarchy as AppLayout; account/notice text is deliberately controlled.
    // These inert actions never impersonate an authenticated or live account.
    headerActions: <div className="arx-shell-actions-main">
      <EnvironmentPill compact />
      <button className="arx-shell-emergency-link" data-fixture-action="emergency" onClick={() => setAction("emergency")}>
        <AlertOctagon size={14} aria-hidden="true" /><span>Emergency Stop</span>
      </button>
      <NotificationBell />
      <button className="arx-shell-signout" aria-label="Sign out" onClick={() => setAction("signout")}><LogOut size={15} /></button>
      <div className="arx-shell-cockpit-controls">
        <label className="min-w-0 max-w-full text-xs">Account
          <select aria-label="Fixture account" className="block w-full min-w-0 max-w-full rounded border border-border bg-background p-1" onChange={() => setAction("account")}>
            <option>{account}</option><option>Alternate read-only fixture account</option>
          </select>
        </label>
      </div>
    </div>,
    safetyNotice: <div className="arx-shell-status-strip">
      <div className="arx-shell-status-components"><span>DEMO · execution disabled</span><span>999 unread notifications</span></div>
      <div className="min-w-0">
        <SafetyHeader />
        {notices.map((notice, i) => <p key={notice} data-fixture-notice={i}>{notice}</p>)}
        <button className="arx-shell-emergency-link" data-fixture-action="review" onClick={() => setAction("review")}>Review safety information</button>
      </div>
    </div>,
    children: <section className="p-3"><h2>Isolated shell content</h2><p>Not a signed-in workspace.</p><output data-testid="fixture-action">{action}</output><output data-testid="fixture-panel">{selected}</output></section>,
  };
  return cockpit
    ? <ARXShellFrame {...common} variant="cockpit" dockItems={items.map(({ href, ...item }) => ({ ...item, onSelect: () => setSelected(item.id) }))} />
    : <ARXShellFrame {...common} variant="page" routeContent dockItems={items} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
