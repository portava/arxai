// Build G — Banner shown across the app whenever broker health blocks live execution.
import { useGetBrokerHealth, getGetBrokerHealthQueryKey } from "@workspace/api-client-react";

export function ConnectionHealthBanner() {
  const { data } = useGetBrokerHealth({ query: { queryKey: getGetBrokerHealthQueryKey(), refetchInterval: 5_000 } });
  if (!data) return null;
  if (data.status === "CONNECTED") return null;
  const tone = data.severity === "DANGER"
    ? "border-danger/40 bg-danger/10 text-danger"
    : "border-warning/40 bg-warning/10 text-warning";
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <div className="font-semibold">{data.status.replace(/_/g, " ")}</div>
      <div className="mt-0.5 text-xs opacity-90">{data.aiExplanation}</div>
      {data.blockers.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-xs opacity-90">
          {data.blockers.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
    </div>
  );
}
