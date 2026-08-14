import { useEffect, useState } from "react";

interface Item { item: string; status: "PASS" | "WARN" | "FAIL"; evidence: string; recommendedFix: string; }
interface Section { name: string; items: Item[]; }
interface Checklist { checklist_id: string; generated_at: string; sections: Section[]; finalRecommendation: string; basedOnReportId: string; }

export default function ReadinessChecklist() {
  const [data, setData] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/readiness/checklist").then((x) => x.json());
      setData(r.checklist);
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Readiness Checklist</h1>
        <div className="flex gap-2">
          <span className="px-2 py-1 rounded bg-red-100 text-red-700 text-xs font-mono">LIVE TRADING: DISABLED</span>
          <button onClick={load} disabled={loading} className="px-3 py-1 rounded bg-blue-600 text-white text-sm">{loading ? "Loading…" : "Refresh"}</button>
        </div>
      </div>

      {data && (
        <>
          <div className="p-3 border rounded bg-gray-50">
            <div className="text-xs text-gray-500">Final recommendation</div>
            <div className="font-semibold">{data.finalRecommendation}</div>
            <div className="text-xs text-gray-400 mt-1">Based on report {data.basedOnReportId}</div>
          </div>
          {data.sections.map((s) => (
            <div key={s.name} className="border rounded">
              <div className="p-2 bg-gray-100 font-semibold">{s.name}</div>
              <div className="divide-y">
                {s.items.map((it, i) => (
                  <div key={i} className={`p-2 text-sm ${it.status === "FAIL" ? "bg-red-50" : it.status === "WARN" ? "bg-yellow-50" : ""}`}>
                    <div className="flex justify-between">
                      <div className="flex-1">{it.item}</div>
                      <div className="font-mono text-xs">{it.status}</div>
                    </div>
                    {it.evidence && <div className="text-xs text-gray-600 mt-1">Evidence: {it.evidence}</div>}
                    {it.recommendedFix && <div className="text-xs text-blue-700 mt-1">Fix: {it.recommendedFix}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
