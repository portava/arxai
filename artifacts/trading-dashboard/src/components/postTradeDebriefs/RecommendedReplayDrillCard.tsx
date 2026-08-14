import { Link } from "wouter";
export function RecommendedReplayDrillCard({ drill, feedback }: { drill: string; feedback: string }) {
  return (
    <div className="rounded-lg border border-sky-700 bg-sky-950/30 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-sky-200">AI debrief feedback</h4>
        <span className="text-[10px] uppercase tracking-wide text-sky-400/80">coaching aid</span>
      </div>
      <p className="text-xs leading-relaxed text-slate-200">{feedback}</p>
      <div className="mt-2 rounded border border-sky-800 bg-slate-950/40 p-2">
        <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-300">Recommended drill</div>
        <p className="text-xs text-slate-100">{drill}</p>
        <Link href="/replay-lab" className="mt-1.5 inline-block text-[11px] text-sky-400 underline hover:text-sky-300">
          Open Replay Lab →
        </Link>
      </div>
    </div>
  );
}
