// OneClickModeToggle — the global one-click switch, mounted in the top bar so it
// is reachable from every page. OFF → ON opens the disclaimer; the mode only
// turns on after the user accepts. ON → OFF is immediate (the safe direction).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Zap, ZapOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useOneClickMode } from "@/hooks/useOneClickMode";
import { OneClickModeDisclaimer } from "@/components/oneclick/OneClickModeDisclaimer";
import { cn } from "@/lib/utils";

export function OneClickModeToggle({ compact = true }: { compact?: boolean } = {}) {
  const { mode, switching, enable, disable } = useOneClickMode();
  const { toast } = useToast();
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  // Paper / unknown account modes have no one-click. Stay out of the way.
  if (!mode.scope && !mode.loading) return null;

  const onClick = async () => {
    if (mode.on) {
      const r = await disable();
      toast(r.ok
        ? { title: "One-click off", description: "Buy, Sell and Close ask for confirmation again." }
        : { title: "Could not turn one-click off", description: r.error ?? "", variant: "destructive" });
      return;
    }
    setDisclaimerOpen(true);
  };

  const onAccept = async () => {
    const r = await enable();
    if (r.ok) {
      setDisclaimerOpen(false);
      toast({ title: `One-click ON (${mode.scope?.toUpperCase()})`, description: "Buy, Sell and Close now execute on the first click, app-wide." });
    } else {
      toast({ title: "One-click not turned on", description: r.error ?? "", variant: "destructive" });
    }
  };

  const title = mode.on
    ? `One-click is ON for ${mode.scope?.toUpperCase()}. Click to turn off.`
    : mode.canEnable
      ? "Turn on one-click trading (shows a disclaimer first)"
      : mode.blockReason ?? "One-click unavailable";

  return (
    <>
      <Button
        size="sm"
        variant={mode.on ? "default" : "outline"}
        onClick={onClick}
        disabled={switching || mode.loading || (!mode.on && !mode.canEnable)}
        title={title}
        aria-pressed={mode.on}
        className={cn(
          "h-8 gap-1.5 px-2.5 text-xs font-semibold",
          mode.on ? "bg-amber-500 text-black hover:bg-amber-400" : "text-txt-secondary",
        )}
        data-testid="one-click-mode-toggle"
        data-state={mode.on ? "on" : "off"}
      >
        {mode.on ? <Zap className="h-3.5 w-3.5" /> : <ZapOff className="h-3.5 w-3.5" />}
        {compact ? (mode.on ? "1-Click ON" : "1-Click") : (mode.on ? `One-click ON · ${mode.scope?.toUpperCase()}` : "One-click off")}
      </Button>
      <OneClickModeDisclaimer
        open={disclaimerOpen}
        onOpenChange={setDisclaimerOpen}
        mode={mode}
        busy={switching}
        onAccept={() => void onAccept()}
      />
    </>
  );
}
