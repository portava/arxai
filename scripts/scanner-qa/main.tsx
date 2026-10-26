import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { BroadScanOpportunityMap } from "../../artifacts/trading-dashboard/src/components/scanner/BroadScanOpportunityMap";
const setFixture = (kind: string) => window.dispatchEvent(new CustomEvent("scanner-fixture", { detail: kind }));
const root = createRoot(document.getElementById("root")!);
const queryClient = new QueryClient();
function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const [group, setGroup] = useState<"all" | "forex">("all");
  return <main style={{ background: "#09090b", color: "#fafafa", minHeight: "100vh", padding: 20 }}>
  <h1 style={{ fontSize: 22, fontWeight: 600 }}>Scanner · browser acceptance</h1>
  <p style={{ color: "#fbbf24", margin: "8px 0 16px" }}>OFFLINE FIXTURE — invented rows, no market feed or trading</p>
  <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
    <button onClick={() => setFixture("fresh")}>Fresh fixture</button>
    <button onClick={() => setFixture("expired")}>Expire fixture</button>
    <button onClick={() => setFixture("error")}>Failed refresh</button>
  </div>
  <p data-testid="fixture-selection">Selected: {selected ?? "none"}</p>
  <button onClick={() => setGroup(group === "all" ? "forex" : "all")}>Change fixture universe</button>
  <BroadScanOpportunityMap marketGroup={group} selectedSymbol={selected} onPick={setSelected} />
</main>;
}
root.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
