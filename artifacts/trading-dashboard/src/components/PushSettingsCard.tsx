// Phase 22D — Push settings card.
// Honest copy: never says push is "active" unless the server reports
// activeSubscriptions > 0 AND user prefs.pushEnabled is true.
import { useEffect, useState } from "react";
import {
  fetchPushStatus, getPushCapability, enablePush, disablePush, sendTestPush,
  type PushStatus, type PushCapability,
} from "../lib/pushManager";

type Mode =
  | "loading"
  | "not_supported"
  | "not_configured"
  | "permission_denied"
  | "ready_to_enable"
  | "enabled"
  | "disabled_locally";

function deriveMode(status: PushStatus | null, cap: PushCapability): Mode {
  if (!status) return "loading";
  if (!cap.serviceWorker || !cap.notification || !cap.pushManager) return "not_supported";
  if (!status.configured) return "not_configured";
  if (cap.permission === "denied") return "permission_denied";
  if (status.activeSubscriptions > 0 && status.pushEnabled) return "enabled";
  if (status.activeSubscriptions > 0 && !status.pushEnabled) return "disabled_locally";
  return "ready_to_enable";
}

const COPY: Record<Mode, { label: string; desc: string; color: string }> = {
  loading: { label: "Checking…", desc: "Reading push status from the server.", color: "bg-muted" },
  not_supported: { label: "Not supported", desc: "This browser does not support push notifications.", color: "bg-muted" },
  not_configured: { label: "Not configured", desc: "Push notifications are not configured on this server yet.", color: "bg-muted" },
  permission_denied: { label: "Permission denied", desc: "You blocked notifications for this site. Re-allow in your browser to enable push.", color: "bg-warning" },
  ready_to_enable: { label: "Ready to enable", desc: "Push is configured. Click Enable to allow notifications on this device.", color: "bg-primary" },
  enabled: { label: "Enabled", desc: "Push notifications are enabled for this device.", color: "bg-success" },
  disabled_locally: { label: "Disabled in preferences", desc: "This device is subscribed but your push preference is off.", color: "bg-warning" },
};

export default function PushSettingsCard() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [cap, setCap] = useState<PushCapability>(() => getPushCapability());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  async function refresh() {
    try {
      const s = await fetchPushStatus();
      setStatus(s);
      setCap(getPushCapability());
    } catch {
      setStatus({ configured: false, publicKey: null, activeSubscriptions: 0, revokedSubscriptions: 0, pushEnabled: false, setupHint: "Could not reach push status." });
    }
  }

  useEffect(() => { void refresh(); }, []);

  const mode = deriveMode(status, cap);
  const copy = COPY[mode];
  const canEnable = mode === "ready_to_enable" || mode === "disabled_locally";
  const canDisable = mode === "enabled" || mode === "disabled_locally";
  const canTest = mode === "enabled";

  async function onEnable() {
    setBusy(true); setMsg("");
    const r = await enablePush();
    setMsg(r.message);
    await refresh();
    setBusy(false);
  }
  async function onDisable() {
    setBusy(true); setMsg("");
    const r = await disablePush();
    setMsg(r.message);
    await refresh();
    setBusy(false);
  }
  async function onTest() {
    setBusy(true); setMsg("");
    const r = await sendTestPush();
    setMsg(r.message);
    setBusy(false);
  }

  return (
    <div className="border rounded p-4 space-y-3" data-testid="push-settings-card">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold">Push notifications</h2>
        <span className={`px-2 py-0.5 rounded text-xs text-white ${copy.color}`} data-testid="push-status-badge">{copy.label}</span>
        <span className="px-2 py-0.5 rounded text-xs bg-muted dark:bg-muted text-xs">In-app: active</span>
      </div>
      <p className="text-sm text-txt-muted dark:text-txt-secondary">{copy.desc}</p>
      {status?.setupHint && (
        <p className="text-xs text-txt-muted" data-testid="push-setup-hint">{status.setupHint}</p>
      )}
      <div className="text-xs text-txt-muted">
        Active subscriptions for this account: <strong>{status?.activeSubscriptions ?? 0}</strong>
        {status?.revokedSubscriptions ? <> · Revoked: {status.revokedSubscriptions}</> : null}
        {" · "}Browser permission: <strong>{cap.permission}</strong>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy || !canEnable}
          onClick={onEnable}
          className="px-3 py-1.5 bg-primary hover:bg-primary/15 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-sm"
          data-testid="push-enable-btn"
        >Enable push</button>
        <button
          disabled={busy || !canDisable}
          onClick={onDisable}
          className="px-3 py-1.5 bg-muted hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-sm"
          data-testid="push-disable-btn"
        >Disable push</button>
        <button
          disabled={busy || !canTest}
          onClick={onTest}
          className="px-3 py-1.5 bg-success hover:bg-success/15 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-sm"
          data-testid="push-test-btn"
        >Send test push</button>
      </div>
      {msg && <div className="text-xs text-txt-muted dark:text-txt-secondary" data-testid="push-status-msg">{msg}</div>}
      <div className="text-[10px] text-txt-muted">
        Push is delivery only. The Notification Center remains the source of truth.
        Demo-only / live trading disabled.
      </div>
    </div>
  );
}
