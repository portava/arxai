import { useEffect, useState } from "react";

interface Event {
  id: number; securityEventId: string; eventType: string; severity: string; status: string;
  actorRole: string | null; permissionKey: string | null; route: string | null;
  message: string | null; createdAt: string;
}

export default function SecurityEvents() {
  const [events, setEvents] = useState<Event[]>([]);
  const [logs, setLogs] = useState<unknown[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/security/events?limit=100").then((r) => r.json()),
      fetch("/api/security/access-logs?limit=50").then((r) => r.json()),
    ]).then(([e, l]) => { setEvents(e.events); setLogs(l.accessLogs); });
  }, []);

  const filtered = filter ? events.filter((e) => e.eventType === filter) : events;

  return (
    <div className="p-6 space-y-6" data-testid="security-events">
      <h1 className="text-2xl font-bold">Security Events</h1>
      <div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="border rounded p-1 text-sm">
          <option value="">All event types</option>
          {["FORBIDDEN_ACTION_ATTEMPTED","PERMISSION_DENIED","PERMISSION_GRANTED","ROLE_CHANGED","SECURITY_SETTING_CHANGED","REPEATED_DENIED_REQUESTS"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="border rounded">
        <table className="w-full text-xs">
          <thead className="bg-muted"><tr><th className="p-2 text-left">When</th><th className="p-2 text-left">Type</th><th className="p-2 text-left">Severity</th><th className="p-2 text-left">Role</th><th className="p-2 text-left">Permission</th><th className="p-2 text-left">Message</th></tr></thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className={e.severity === "CRITICAL" ? "bg-danger/10" : e.severity === "WARNING" ? "bg-warning/10" : ""}>
                <td className="p-2 font-mono">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="p-2">{e.eventType}</td>
                <td className="p-2 font-bold">{e.severity}</td>
                <td className="p-2">{e.actorRole ?? "-"}</td>
                <td className="p-2 font-mono">{e.permissionKey ?? "-"}</td>
                <td className="p-2">{e.message ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-sm text-txt-muted">{logs.length} recent access log entries also recorded.</div>
    </div>
  );
}
