import React, { useState } from "react";
import { useGetEconomicCalendar } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarDays } from "lucide-react";

export default function Calendar() {
  const [impact, setImpact] = useState<string>("ALL");
  const [days, setDays] = useState<string>("7");
  const { data, isLoading } = useGetEconomicCalendar({
    impact: impact === "ALL" ? undefined : (impact as "low" | "medium" | "high"),
    days: Number(days),
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays className="text-primary" /> Economic Calendar
          </h2>
          <p className="text-muted-foreground">Upcoming high-impact events that may affect trading.</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <Select value={impact} onValueChange={setImpact}>
            <SelectTrigger className="flex-1 min-w-[120px] sm:flex-none sm:w-[140px]" data-testid="select-impact"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All impact</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="flex-1 min-w-[100px] sm:flex-none sm:w-[120px]" data-testid="select-days"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 day</SelectItem>
              <SelectItem value="3">3 days</SelectItem>
              <SelectItem value="7">7 days</SelectItem>
              <SelectItem value="14">14 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Events</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <div className="space-y-2">{Array.from({length: 5}).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div> :
            !data || data.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">No events in this period.</p> :
            <div className="space-y-2">
              {data.map((e) => (
                <div key={e.id} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded border border-border/50">
                  <div className="text-xs font-mono text-muted-foreground sm:w-32 shrink-0">{new Date(e.eventTime).toLocaleString()}</div>
                  <Badge variant="outline" className="w-fit text-xs">{e.currency}</Badge>
                  <div className="flex-1 text-sm">{e.title}</div>
                  <Badge className={`text-xs ${e.impact === "high" ? "bg-destructive/20 text-destructive" : e.impact === "medium" ? "bg-yellow-500/20 text-yellow-500" : "bg-muted text-muted-foreground"}`}>{e.impact.toUpperCase()}</Badge>
                  <div className="text-xs font-mono text-muted-foreground sm:w-40 truncate">{e.affectedMarkets.join(", ")}</div>
                </div>
              ))}
            </div>
          }
        </CardContent>
      </Card>
    </div>
  );
}
