import { Link } from "wouter";
export function RecommendedReplayDrillCard({ drill, feedback }: { drill: string; feedback: string }) {
  return (
    <div className="rounded-lg border border-ruby/40 bg-ruby/30 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-ruby">AI debrief feedback</h4>
        <span className="text-[10px] uppercase tracking-wide text-ruby/80">coaching aid</span>
      </div>
      <p className="text-xs leading-relaxed text-foreground">{feedback}</p>
      <div className="mt-2 rounded border border-ruby/40 bg-background/40 p-2">
        <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-ruby">Recommended drill</div>
        <p className="text-xs text-foreground">{drill}</p>
        <Link href="/replay-simulator" className="mt-1.5 inline-block text-[11px] text-ruby underline hover:text-ruby">
          Open Replay Simulator →
        </Link>
      </div>
    </div>
  );
}
