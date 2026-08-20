import { useState } from "react";
import {
  getGetMyBrokerHubAccountQueryKey,
  getGetMyBrokerHubCapabilitiesQueryKey,
  getGetMyBrokerHubConnectionQueryKey,
  getGetMyBrokerHubInstrumentsQueryKey,
  useGetMyBrokerHubAccount,
  useGetMyBrokerHubCapabilities,
  useGetMyBrokerHubConnection,
  useGetMyBrokerHubInstruments,
} from "@workspace/api-client-react";
import { ChevronDown, Database, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

type Mt5Connection = { id: number };

function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

function formatObservedAt(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Not reported";
}

function ReadValue({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value == null || value === "" ? "—" : value}</dd>
    </div>
  );
}

function SectionUnavailable({ quiet = false }: { quiet?: boolean }) {
  return (
    <div className={cn("text-xs", quiet ? "text-muted-foreground" : "text-warning")}>
      {quiet ? "Unavailable for this connection." : "Temporarily unavailable. Try again later."}
    </div>
  );
}

export function BrokerMetadataPanel({ conn }: { conn: Mt5Connection }) {
  const [open, setOpen] = useState(false);
  const connection = useGetMyBrokerHubConnection(conn.id, {
    query: { queryKey: getGetMyBrokerHubConnectionQueryKey(conn.id), enabled: open },
  });
  const account = useGetMyBrokerHubAccount(conn.id, {
    query: { queryKey: getGetMyBrokerHubAccountQueryKey(conn.id), enabled: open },
  });
  const capabilities = useGetMyBrokerHubCapabilities(conn.id, {
    query: { queryKey: getGetMyBrokerHubCapabilitiesQueryKey(conn.id), enabled: open },
  });
  const instruments = useGetMyBrokerHubInstruments(conn.id, {
    query: { queryKey: getGetMyBrokerHubInstrumentsQueryKey(conn.id), enabled: open },
  });

  const allNotFound =
    open &&
    [connection.error, account.error, capabilities.error, instruments.error].every(
      (error) => error == null || isNotFound(error),
    ) &&
    [connection.error, account.error, capabilities.error, instruments.error].some(isNotFound);

  return (
    <div className="rounded-lg border bg-card/50" data-testid={`broker-metadata-${conn.id}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-sm font-medium">Broker metadata</div>
            <div className="text-xs text-muted-foreground">Read-only MT5 connection, account, and EA evidence</div>
          </div>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-4 border-t px-3 py-3 text-sm">
          {allNotFound ? (
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              Broker metadata is currently unavailable. This read-only feature may not be enabled for this workspace.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Metadata only · trading and automation unavailable</span>
                </div>
                {connection.isLoading ? (
                  <span className="text-xs text-muted-foreground">Checking connection…</span>
                ) : connection.data ? (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      connection.data.connected
                        ? "border-success/40 bg-success/10 text-success"
                        : "border-warning/40 bg-warning/10 text-warning",
                    )}
                  >
                    {connection.data.connected ? "Connected" : connection.data.status.replace(/_/g, " ")}
                  </span>
                ) : (
                  <SectionUnavailable quiet={isNotFound(connection.error)} />
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connection</h4>
                  {connection.data ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <ReadValue label="Venue" value={connection.data.venue} />
                      <ReadValue label="Status" value={connection.data.status.replace(/_/g, " ")} />
                      <ReadValue label="Reason" value={connection.data.reason.replace(/_/g, " ")} />
                      <ReadValue label="Observed" value={formatObservedAt(connection.data.observedAt)} />
                    </dl>
                  ) : !connection.isLoading && <SectionUnavailable quiet={isNotFound(connection.error)} />}
                </section>

                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account snapshot</h4>
                  {account.data ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <ReadValue label="Account" value={account.data.accountRefMasked} />
                      <ReadValue label="Broker" value={account.data.brokerName} />
                      <ReadValue label="Server" value={account.data.serverName} />
                      <ReadValue label="Environment" value={account.data.environment} />
                      <ReadValue label="Currency" value={account.data.currency} />
                      <ReadValue label="Snapshot" value={account.data.snapshotStatus} />
                    </dl>
                  ) : !account.isLoading && <SectionUnavailable quiet={isNotFound(account.error)} />}
                </section>

                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Read capabilities</h4>
                  {capabilities.data ? (
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      {Object.entries(capabilities.data.capabilities).map(([label, enabled]) => (
                        <ReadValue key={label} label={label.replace(/([A-Z])/g, " $1")} value={enabled ? "Available" : "Unavailable"} />
                      ))}
                    </dl>
                  ) : !capabilities.isLoading && <SectionUnavailable quiet={isNotFound(capabilities.error)} />}
                </section>
              </div>

              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">EA-discovered instruments</h4>
                  {instruments.data && (
                    <span className="text-xs text-muted-foreground">{instruments.data.discoveryStatus.replace(/_/g, " ")}</span>
                  )}
                </div>
                {instruments.isLoading ? (
                  <div className="text-xs text-muted-foreground">Loading discovered instruments…</div>
                ) : instruments.data?.discoveryStatus === "DISCOVERY_REQUIRED" ? (
                  <div className="rounded-md border border-dashed border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                    DISCOVERY_REQUIRED — no fresh broker-reported instruments are available.
                  </div>
                ) : instruments.data?.instruments.length ? (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[520px] text-left text-xs">
                      <thead className="bg-muted/30 text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">Symbol</th>
                          <th className="px-2 py-1.5 font-medium">Broker symbol</th>
                          <th className="px-2 py-1.5 font-medium">Digits</th>
                          <th className="px-2 py-1.5 font-medium">Volume range</th>
                          <th className="px-2 py-1.5 font-medium">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {instruments.data.instruments.map((instrument) => (
                          <tr key={instrument.symbol} className="border-t">
                            <td className="px-2 py-1.5 font-medium">{instrument.symbol}</td>
                            <td className="px-2 py-1.5 font-mono">{instrument.exactBrokerSymbol}</td>
                            <td className="px-2 py-1.5">{instrument.digits ?? "—"}</td>
                            <td className="px-2 py-1.5">
                              {instrument.minVolume ?? "—"}–{instrument.maxVolume ?? "—"} (step {instrument.volumeStep ?? "—"})
                            </td>
                            <td className="px-2 py-1.5 text-muted-foreground">{formatObservedAt(instrument.evidence.observedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : !instruments.isLoading ? (
                  <SectionUnavailable quiet={isNotFound(instruments.error)} />
                ) : null}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}