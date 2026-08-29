import React, { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { COMPLIANCE } from "@/lib/compliance";
import { ARXLogoMark } from "@/components/brand/ARXLogo";

export function Footer() {
  const year = new Date().getFullYear();
  const [v, setV] = useState<{ version?: string; stage?: string; mt5Deferred?: boolean } | null>(null);
  useEffect(() => { void fetch("/api/release/version").then((r) => r.ok ? r.json() : null).then(setV).catch(() => {}); }, []);
  return (
    <footer
      role="contentinfo"
      className="border-t border-border bg-background/60 backdrop-blur-sm mt-8"
      data-testid="app-footer"
    >
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-4 flex flex-col md:flex-row gap-3 md:gap-6 items-start md:items-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0 flex-wrap">
          <ARXLogoMark size={18} mode="dark" />
          <span className="font-semibold text-foreground/80" title="Analyze. Risk. eXecute.">ARX AI</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Analyze · Risk · eXecute</span>
          <span>· © {year}</span>
          {v?.version && <Badge variant="outline" className="text-[10px] font-mono" data-testid="footer-version">{v.version}</Badge>}
          {v?.stage && v.stage !== "LIVE" && <Badge className="text-[10px] bg-warning/10 text-warning border border-warning/25">{v.stage}</Badge>}
          {v?.mt5Deferred && false && <Badge className="text-[10px] bg-muted/60 text-txt-secondary border border-border">MT5 DEFERRED</Badge>}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground flex-1">
          <span className="font-semibold text-foreground/70 uppercase tracking-wider mr-2">Risk disclosure:</span>
          {COMPLIANCE.footer.body}
        </p>
      </div>
    </footer>
  );
}
