import React, { useState, useEffect } from "react";
import { useGetBotStatus, useUpdateBotStatus, useGetStrategies, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Play, Square, Pause, AlertOctagon, Bot as BotIcon, Activity, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { BotStatusUpdateMode, BotStatusUpdateRiskMode } from "@workspace/api-client-react";
import { safeDate } from "@/lib/safeFormat";

const SYMBOLS = [
  "Volatility 75 Index",
  "Volatility 75 (1s) Index",
  "Volatility 25 (1s) Index",
  "Volatility 100 Index",
  "Step Index"
];

export default function BotControl() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: botStatus, isLoading: isLoadingStatus, isError: statusError } = useGetBotStatus();
  const { data: strategies, isLoading: isLoadingStrats } = useGetStrategies();
  const updateBotStatus = useUpdateBotStatus();

  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<BotStatusUpdateMode | null>(null);

  const [localStatus, setLocalStatus] = useState({
    symbol: "",
    strategy: "",
    riskMode: "Balanced",
    mode: "OFF",
    isRunning: false,
    isPaused: false
  });

  useEffect(() => {
    if (botStatus) {
      setLocalStatus({
        symbol: botStatus.symbol,
        strategy: botStatus.strategy,
        riskMode: botStatus.riskMode,
        mode: botStatus.mode,
        isRunning: botStatus.isRunning,
        isPaused: botStatus.isPaused
      });
    }
  }, [botStatus]);

  const handleUpdate = (updates: Partial<typeof localStatus>) => {
    const nextMode = updates.mode as BotStatusUpdateMode | undefined;
    
    if (nextMode === "LIVE" && localStatus.mode !== "LIVE") {
      setPendingMode("LIVE");
      setLiveConfirmOpen(true);
      return;
    }

    applyUpdate(updates);
  };

  const applyUpdate = (updates: Partial<typeof localStatus>) => {
    const payload = {
      ...updates,
      mode: updates.mode as BotStatusUpdateMode | undefined,
      riskMode: updates.riskMode as BotStatusUpdateRiskMode | undefined,
    };

    updateBotStatus.mutate({ data: payload }, {
      onSuccess: (data) => {
        // bot_settings is read by no scanner, loop or execution path, so a
        // save changes nothing that runs. Say exactly that.
        toast({
          title: "Preference saved",
          description: "Saved to your bot settings. No engine reads them, so nothing was started, stopped or traded.",
        });
        queryClient.setQueryData(getGetBotStatusQueryKey(), data);
      },
      onError: () => {
        toast({ title: "Not saved", description: "Your bot preference could not be saved.", variant: "destructive" });
      }
    });
  };

  const confirmLiveMode = () => {
    if (pendingMode) {
      applyUpdate({ mode: pendingMode });
    }
    setLiveConfirmOpen(false);
    setPendingMode(null);
  };

  if (isLoadingStatus) {
    return <div className="space-y-6"><Skeleton className="h-[400px] w-full max-w-2xl mx-auto" /></div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BotIcon className="text-primary" /> Bot Control Panel
          </h2>
          <p className="text-muted-foreground">Saved bot preferences: mode, risk level, symbol, strategy and start / pause / stop.</p>
        </div>
      </div>

      {/* bot_settings (the store behind /bot/status) is written only by the
          /bot routes. No scanner, trading loop or execution path reads it, and
          nothing records a scan against it. So START is a saved request, not a
          running engine, and LIVE arms nothing. */}
      <p
        data-testid="bot-control-scope"
        className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
      >
        These controls only save preferences. No scanner, trading loop or execution path reads them:
        START does not start a bot, STOP does not stop one, and LIVE does not arm live trading or place
        trades. Live trading has its own arming steps and safety gates, which nothing here changes.
      </p>

      <Card className="border-2 shadow-xl border-border">
        <CardHeader className="bg-muted/20 border-b border-border">
          <div className="flex justify-between items-start">
            <div>
              <CardTitle>Saved Bot Preferences</CardTitle>
              <CardDescription>Stored on your account. Nothing that trades reads them.</CardDescription>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Saved setting:</span>
                <div
                  data-testid="bot-control-saved-state"
                  className="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider font-mono bg-muted text-muted-foreground"
                >
                  {!botStatus
                    ? "Not loaded"
                    : localStatus.isRunning ? (localStatus.isPaused ? "Pause requested" : "Start requested") : "Stop requested"}
                </div>
              </div>
              <p data-testid="bot-control-last-scan" className="text-xs text-muted-foreground">
                {!botStatus
                  ? "Last scan: unknown (settings not loaded)"
                  : botStatus.lastScanAt
                    ? `Last scan recorded on this setting: ${safeDate(botStatus.lastScanAt, "datetime", "unreadable time")}`
                    : "Last scan: none recorded — no engine scans for this setting"}
              </p>
            </div>
          </div>
        </CardHeader>

        {statusError && !botStatus && (
          <p data-testid="bot-control-error" role="alert" className="px-6 pt-4 text-sm text-rose-400">
            Your saved bot settings could not be loaded. The values below are not your saved settings.
          </p>
        )}
        
        <CardContent className="grid gap-6 p-6">
          <div className="grid sm:grid-cols-2 gap-6">
            <div className="space-y-3">
              <Label>Trading Mode</Label>
              <Select value={localStatus.mode} onValueChange={(v) => handleUpdate({ mode: v })}>
                <SelectTrigger className={localStatus.mode === "LIVE" ? "border-destructive text-destructive font-bold" : ""}>
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OFF">OFF</SelectItem>
                  <SelectItem value="DEMO">DEMO (preference only)</SelectItem>
                  <SelectItem value="LIVE" className="text-destructive font-bold">LIVE (preference only — arms nothing)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <Label>Risk Level</Label>
              <Select value={localStatus.riskMode} onValueChange={(v) => handleUpdate({ riskMode: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select risk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Conservative">Conservative</SelectItem>
                  <SelectItem value="Balanced">Balanced</SelectItem>
                  <SelectItem value="Aggressive" className="text-orange-500">Aggressive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="grid sm:grid-cols-2 gap-6">
            <div className="space-y-3">
              <Label>Target Symbol</Label>
              <Select value={localStatus.symbol} onValueChange={(v) => handleUpdate({ symbol: v })}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder="Select symbol" />
                </SelectTrigger>
                <SelectContent>
                  {SYMBOLS.map(sym => (
                    <SelectItem key={sym} value={sym} className="font-mono text-sm">{sym}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <Label>Active Strategy</Label>
              <Select value={localStatus.strategy} onValueChange={(v) => handleUpdate({ strategy: v })}>
                <SelectTrigger>
                  <SelectValue placeholder={isLoadingStrats ? "Loading..." : "Select strategy"} />
                </SelectTrigger>
                <SelectContent>
                  {strategies?.filter(s => s.enabled).map(strat => (
                    <SelectItem key={strat.name} value={strat.name}>
                      {strat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>

        <CardFooter className="bg-muted/10 border-t border-border p-6 flex justify-between items-center">
          <div className="flex gap-2">
            <Button 
              variant={localStatus.isRunning && !localStatus.isPaused ? "secondary" : "default"}
              size="lg"
              className={!localStatus.isRunning || localStatus.isPaused ? "bg-green-600 hover:bg-green-700 text-white" : ""}
              onClick={() => handleUpdate({ isRunning: true, isPaused: false })}
              disabled={updateBotStatus.isPending || (localStatus.isRunning && !localStatus.isPaused)}
            >
              <Play className="mr-2" size={18} /> START
            </Button>
            
            <Button 
              variant="outline"
              size="lg"
              className={localStatus.isPaused ? "bg-yellow-500/20 text-yellow-500 border-yellow-500/50" : ""}
              onClick={() => handleUpdate({ isPaused: !localStatus.isPaused })}
              disabled={!localStatus.isRunning || updateBotStatus.isPending}
            >
              <Pause className="mr-2" size={18} /> {localStatus.isPaused ? "RESUME" : "PAUSE"}
            </Button>
            
            <Button 
              variant="outline"
              size="lg"
              className="hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
              onClick={() => handleUpdate({ isRunning: false, isPaused: false })}
              disabled={!localStatus.isRunning || updateBotStatus.isPending}
            >
              <Square className="mr-2" size={18} /> STOP
            </Button>
          </div>
        </CardFooter>
      </Card>

      <AlertDialog open={liveConfirmOpen} onOpenChange={setLiveConfirmOpen}>
        <AlertDialogContent
          className="border-destructive shadow-lg shadow-destructive/20"
          data-testid="dialog-live-unlock"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <ShieldAlert /> Save LIVE as your bot preference?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-foreground/90 text-sm leading-relaxed">
              This only saves LIVE as a preference on this panel. No engine reads it: it does not arm
              live trading, connect to MT5 or place any trade. Live trading has its own arming steps
              and safety gates, and saving this does not change them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-live-unlock-cancel">
              Keep current mode
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmLiveMode}
              className="bg-destructive hover:bg-destructive/90 text-white"
              data-testid="button-live-unlock-confirm"
            >
              Save LIVE preference
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}