import React, { useState } from "react";
import { useGetTrades, useGetOpenTrades, getGetTradesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPrice, formatDate } from "@/lib/format";
import { Search, ListFilter, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTradingMode } from "@/hooks/useTradingMode";
import { PnlCell } from "@/components/trade-logs/PnlCell";

export default function TradeLogs() {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [activeTab, setActiveTab] = useState("all");

  const { data: allTrades, isLoading: isLoadingAll } = useGetTrades({ 
    symbol: symbolFilter || undefined, 
    status: statusFilter === "ALL" ? undefined : statusFilter 
  });
  
  const { data: openTrades, isLoading: isLoadingOpen } = useGetOpenTrades();

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "OPEN": return <Badge variant="outline" className="text-primary border-primary/50">OPEN</Badge>;
      case "CLOSED_WIN": return <Badge className="bg-green-500/20 text-green-500 hover:bg-green-500/30 border-none">WIN</Badge>;
      case "CLOSED_LOSS": return <Badge className="bg-destructive/20 text-destructive hover:bg-destructive/30 border-none">LOSS</Badge>;
      case "CANCELLED": return <Badge variant="secondary">CANCELLED</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const { shouldShowAdminDiagnostics } = useTradingMode();

  const renderPnlCell = (trade: any) => (
    <PnlCell
      id={trade.id}
      pnlStatus={trade.pnlStatus}
      pnl={trade.pnl}
      reportedEaVersion={trade.reportedEaVersion}
      dataQualityFlag={trade.dataQualityFlag}
      shouldShowAdminDiagnostics={shouldShowAdminDiagnostics}
    />
  );

  const renderTable = (trades: any[], isLoading: boolean) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Dir</TableHead>
            <TableHead>Lot</TableHead>
            <TableHead className="text-right">Entry</TableHead>
            <TableHead className="text-right">SL</TableHead>
            <TableHead className="text-right">TP</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">P&L</TableHead>
            <TableHead>Strategy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              </TableRow>
            ))
          ) : !trades || trades.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
                No trades yet — your trade history will appear here once you place your first trade.
              </TableCell>
            </TableRow>
          ) : (
            trades.map((trade) => (
              <TableRow key={trade.id} className="hover:bg-muted/50">
                <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(trade.createdAt)}
                </TableCell>
                <TableCell className="font-mono font-bold">{trade.symbol}</TableCell>
                <TableCell>
                  <span className={`flex items-center gap-1 font-mono text-xs ${trade.direction === 'BUY' ? 'text-green-500' : 'text-destructive'}`}>
                    {trade.direction === 'BUY' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {trade.direction}
                  </span>
                </TableCell>
                <TableCell className="font-mono">{trade.lot}</TableCell>
                <TableCell className="text-right font-mono">{formatPrice(trade.entryPrice)}</TableCell>
                <TableCell className="text-right font-mono text-destructive">{formatPrice(trade.stopLoss)}</TableCell>
                <TableCell className="text-right font-mono text-green-500">{formatPrice(trade.takeProfit)}</TableCell>
                <TableCell>{getStatusBadge(trade.status)}</TableCell>
                <TableCell className="text-right">
                  {renderPnlCell(trade)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">{trade.strategy}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{trade.mode}</span>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ListFilter className="text-primary" /> Trade Logs
          </h2>
          <p className="text-muted-foreground">Detailed history of all executed and open positions.</p>
        </div>
      </div>

      <Card className="border-border/50">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex flex-col sm:flex-row gap-4 justify-between">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full sm:w-[300px]">
              <TabsList className="w-full">
                <TabsTrigger value="all" className="flex-1">History</TabsTrigger>
                <TabsTrigger value="open" className="flex-1">Open Positions</TabsTrigger>
              </TabsList>
            </Tabs>
            
            {activeTab === "all" && (
              <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                <div className="relative w-full sm:w-auto">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Filter symbol..."
                    className="pl-8 w-full sm:w-[200px]"
                    value={symbolFilter}
                    onChange={(e) => setSymbolFilter(e.target.value)}
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-[150px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Statuses</SelectItem>
                    <SelectItem value="CLOSED_WIN">Winning Trades</SelectItem>
                    <SelectItem value="CLOSED_LOSS">Losing Trades</SelectItem>
                    <SelectItem value="CANCELLED">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="all" className="m-0">
              {renderTable(allTrades || [], isLoadingAll)}
            </TabsContent>
            <TabsContent value="open" className="m-0">
              {renderTable(openTrades || [], isLoadingOpen)}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}