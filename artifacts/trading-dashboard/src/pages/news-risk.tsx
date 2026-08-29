// Legacy /news-risk route. The News Risk surface is folded into the unified
// Economic Calendar page as its "News Risk" tab (surface consolidation item E)
// — the same real, DB-backed composition Theme G-FINISH introduced now lives in
// components/news/NewsRiskSection.tsx. Calendar + news risk are ONE surface;
// old bookmarks land on the right tab via this redirect.
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function NewsRiskLegacyRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/economic-calendar?tab=news-risk", { replace: true });
  }, [navigate]);
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-slate-400">
      <p className="text-sm">Redirecting to the Economic Calendar…</p>
    </div>
  );
}
