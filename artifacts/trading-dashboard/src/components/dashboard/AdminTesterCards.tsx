import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Sess = { role: string; fullTesterAccess: boolean; mt5Deferred: boolean };

export function AdminTesterCards() {
  const [s, setS] = useState<Sess | null>(null);
  useEffect(() => {
    void fetch("/api/auth/session").then((r) => r.json()).then(setS);
  }, []);
  const cell = (label: string, value: string, tone: "ok" | "warn" | "bad" = "ok") => (
    <Card data-testid={`tester-card-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="py-3">
        <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
        <Badge className={tone === "ok" ? "bg-success/20 text-success" : tone === "warn" ? "bg-warning/20 text-warning" : "bg-danger/20 text-danger"}>{value}</Badge>
      </CardContent>
    </Card>
  );
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2 my-3">
      {cell("Current Role", s?.role ?? "…")}
      {cell("Tester Access", s?.fullTesterAccess ? "ACTIVE" : "OFF", s?.fullTesterAccess ? "ok" : "warn")}
      {cell("Persistence", "POSTGRES")}
      {cell("Reports", "EXPORTS")}
      {cell("MT5", "DEFERRED", "warn")}
    </div>
  );
}
