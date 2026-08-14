import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpCircle, Lock, ShieldOff } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface HelpTopic { help_key: string; title: string; category: string; page_route: string | null; content: string; safety_note: string; related_build: string }

export function HelpDrawer({ route, trigger }: { route?: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [topics, setTopics] = useState<HelpTopic[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const url = route ? `${BASE}/api/help/page?route=${encodeURIComponent(route)}` : `${BASE}/api/help/topics`;
    fetch(url).then(r => r.json()).then(d => setTopics(d.topics ?? [])).finally(() => setLoading(false));
  }, [open, route]);

  return (
    <>
      <span onClick={() => setOpen(true)}>
        {trigger ?? (
          <Button variant="outline" size="sm"><HelpCircle className="h-4 w-4 mr-1" />Explain this</Button>
        )}
      </span>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><HelpCircle className="h-4 w-4" />Help{route ? ` — ${route}` : ""}</SheetTitle>
            <SheetDescription>
              <Badge variant="outline" className="bg-success/15 text-success border-success/30 mr-1">LIVE</Badge>
              <Badge variant="outline" className="bg-danger/15 text-danger border-danger/30"><ShieldOff className="h-3 w-3 mr-1" />LIVE TRADING DISABLED</Badge>
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {!loading && topics.length === 0 && <p className="text-xs text-muted-foreground">No help topics for this page yet. Open the Help Center for the full library.</p>}
            {topics.map(t => (
              <div key={t.help_key} className="border rounded-md p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[10px]">{t.category}</Badge>
                  <Badge variant="outline" className="text-[10px]">Build {t.related_build}</Badge>
                </div>
                <h4 className="font-semibold text-sm">{t.title}</h4>
                <p className="text-xs mt-1">{t.content}</p>
                <p className="text-[10px] text-muted-foreground mt-2 italic">{t.safety_note}</p>
              </div>
            ))}
            <div className="pt-2">
              <a href={`${BASE}/help`} className="text-xs underline">Open full Help Center →</a>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
