import { PageHeader } from "@/components/trading/PageHeader";
import { CalendarCheck } from "lucide-react";
import { WeeklyReviewPanel } from "@/components/weeklyReview";

export default function WeeklyReviewPage() {
  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <PageHeader
        title="Weekly review"
        description="Performance summary, score trends, and your improvement plan for next week."
        icon={CalendarCheck}
      />
      <WeeklyReviewPanel />
    </div>
  );
}
