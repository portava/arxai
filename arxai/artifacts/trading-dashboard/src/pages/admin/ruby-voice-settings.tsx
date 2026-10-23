// Admin → Ruby Voice Settings.
// ADMIN/OWNER only. Surfaces provider health, the admin-configurable
// OpenAI TTS model + voice instructions, per-provider Test Voice
// buttons, the recent diagnostics ring buffer, and a quick view of the
// per-user TTS preference (mirrored from localStorage; the canonical
// store is the backend per-user row).
//
// SAFETY:
//   - Never displays API keys (server never returns them either).
//   - Never displays stack traces.
//   - All real provider calls happen server-side via /api/admin/ruby-voice/*.
//   - Admin model + voice instructions write only via PUT
//     /api/admin/ruby-voice/admin-settings which re-checks role.

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PageShell } from "@/components/ss/PageShell";
import { CheckCircle, XCircle, AlertTriangle, Loader2, Volume2, Square, RotateCcw, RefreshCw, Save } from "lucide-react";
import { useRubyTTS } from "@/components/help/useRubyTTS";
import { useUserVoiceSettings } from "@/components/help/useUserVoiceSettings";
import { useAssistantName } from "@/lib/assistant-name";

type ProviderStatus = "READY" | "MISSING_API_KEY" | "INVALID_API_KEY" | "INVALID_VOICE_ID" |
  "QUOTA_OR_RATE_LIMIT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED_REQUEST" |
  "TIMED_OUT_OR_NETWORK" | "BROWSER_FALLBACK_USED" | "NO_TTS_PROVIDER";

type SupportedModel = { id: string; label: string; supportsInstructions: boolean };

type TTSDiagEntry = {
  ts: string;
  userId: number | null;
  providerAsked: string;
  providerUsed: string;
  voiceId: string;
  status: "ok" | "error" | "no_provider";
  httpStatus: number;
  mime: string | null;
  bytes: number;
  durationMs: number;
  fallback: boolean;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  isTest: boolean;
  openaiModel?: string | null;
  styleApplied?: boolean;
  loadedFromBackend?: boolean;
  autoplayBlocked?: boolean;
};

type AdminSettings = {
  openaiModel: string;
  voiceInstructions: string;
  updatedAt: string;
  updatedByUserId: number | null;
};

type HealthResponse = {
  ok: boolean;
  providers: {
    openai: {
      configured: boolean; status: ProviderStatus; baseUrl?: string;
      activeModel?: string; activeModelSupportsStyle?: boolean;
      supportedModels?: SupportedModel[];
    };
    elevenlabs: {
      configured: boolean; status: ProviderStatus;
      defaultVoiceName?: string;
      defaultVoiceId?: string;
      defaultVoiceResolved?: boolean;
    };
    browser:    { configured: boolean; status: ProviderStatus };
  };
  adminSettings: AdminSettings | null;
  last: TTSDiagEntry | null;
  recent: TTSDiagEntry[];
};

function statusBadge(s: ProviderStatus) {
  if (s === "READY") return <Badge className="bg-success/15 text-success border border-success/30">Ready</Badge>;
  if (s === "MISSING_API_KEY") return <Badge className="bg-warning/15 text-warning border border-warning/30">Missing API key</Badge>;
  if (s === "INVALID_API_KEY") return <Badge className="bg-danger/15 text-danger border border-danger/30">Invalid API key</Badge>;
  if (s === "INVALID_VOICE_ID") return <Badge className="bg-danger/15 text-danger border border-danger/30">Invalid voice ID</Badge>;
  if (s === "QUOTA_OR_RATE_LIMIT") return <Badge className="bg-warning/15 text-warning border border-warning/30">Quota / rate limit</Badge>;
  if (s === "PROVIDER_UNAVAILABLE") return <Badge className="bg-danger/15 text-danger border border-danger/30">Provider unavailable</Badge>;
  if (s === "PROVIDER_REJECTED_REQUEST") return <Badge className="bg-danger/15 text-danger border border-danger/30">Provider rejected request</Badge>;
  if (s === "TIMED_OUT_OR_NETWORK") return <Badge className="bg-warning/15 text-warning border border-warning/30">Timed out</Badge>;
  if (s === "BROWSER_FALLBACK_USED") return <Badge className="bg-primary/15 text-primary border border-primary/30">Browser fallback used</Badge>;
  return <Badge className="bg-secondary/15 text-txt-secondary border border-border">{s}</Badge>;
}

function statusIcon(s: ProviderStatus) {
  if (s === "READY") return <CheckCircle className="h-4 w-4 text-success" />;
  if (s === "MISSING_API_KEY" || s === "QUOTA_OR_RATE_LIMIT" || s === "TIMED_OUT_OR_NETWORK") return <AlertTriangle className="h-4 w-4 text-warning" />;
  return <XCircle className="h-4 w-4 text-danger" />;
}

export default function AdminRubyVoiceSettings() {
  const { name } = useAssistantName();
  const TEST_PHRASE = `${name} voice test successful. I'm online and ready.`;
  const rubyTTS = useRubyTTS();
  const userVoiceSettings = useUserVoiceSettings();
  const qc = useQueryClient();
  const [testProvider, setTestProvider] = useState<"openai" | "elevenlabs" | "auto" | "browser">("auto");
  const [testVoiceId,  setTestVoiceId]  = useState<string>("");
  const [testStatus,   setTestStatus]   = useState<{ kind: "idle" | "loading" | "ok" | "error"; message?: string; provider?: string; bytes?: number; ms?: number }>({ kind: "idle" });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const health = useQuery<HealthResponse>({
    queryKey: ["admin", "ruby-voice", "health"],
    queryFn: () => fetch("/api/admin/ruby-voice/health", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 15_000,
  });

  // ── Admin Settings (OpenAI model + Voice Instructions) ───────────────────
  const supportedModels: SupportedModel[] = health.data?.providers.openai.supportedModels ?? [];
  const adminSettings = health.data?.adminSettings ?? null;
  const [modelDraft, setModelDraft] = useState<string>("");
  const [styleDraft, setStyleDraft] = useState<string>("");
  const [adminSaveMsg, setAdminSaveMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!adminSettings) return;
    setModelDraft((cur) => cur || adminSettings.openaiModel);
    setStyleDraft((cur) => cur || adminSettings.voiceInstructions);
  }, [adminSettings]);
  const modelSupportsStyle = supportedModels.find((m) => m.id === modelDraft)?.supportsInstructions ?? false;

  const saveAdminMut = useMutation({
    mutationFn: async (patch: { openaiModel?: string; voiceInstructions?: string }) => {
      const r = await fetch("/api/admin/ruby-voice/admin-settings", {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      return j;
    },
    onSuccess: () => {
      setAdminSaveMsg("Saved.");
      void qc.invalidateQueries({ queryKey: ["admin", "ruby-voice", "health"] });
      setTimeout(() => setAdminSaveMsg(null), 2500);
    },
    onError: (e: Error) => {
      setAdminSaveMsg(`Failed: ${e.message}`);
    },
  });

  // Default test voice when providers load
  useEffect(() => {
    if (testVoiceId) return;
    const provs = rubyTTS.providers?.providers;
    if (!provs) return;
    if (testProvider === "elevenlabs" && provs.elevenlabs.voices[0]) setTestVoiceId(provs.elevenlabs.voices[0].id);
    else if (testProvider === "openai" && provs.openai.voices[0]) setTestVoiceId(provs.openai.voices[0].id);
    else if (testProvider === "auto") {
      setTestVoiceId(provs.elevenlabs.voices[0]?.id ?? provs.openai.voices[0]?.id ?? "nova");
    }
  }, [rubyTTS.providers, testProvider, testVoiceId]);

  const testMut = useMutation({
    mutationFn: async (args: { provider: "openai" | "elevenlabs" | "auto"; voiceId: string }) => {
      const t0 = performance.now();
      const r = await fetch("/api/admin/ruby-voice/test", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: args.provider, voiceId: args.voiceId, phrase: TEST_PHRASE }),
      });
      const ms = Math.round(performance.now() - t0);
      const provider = r.headers.get("X-TTS-Provider") ?? args.provider;
      const bytes = Number(r.headers.get("X-TTS-Bytes") ?? "0");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      const ct = r.headers.get("Content-Type") ?? "";
      if (!ct.startsWith("audio/")) throw new Error("UNEXPECTED_CONTENT_TYPE");
      const blob = await r.blob();
      return { blob, provider, bytes: bytes || blob.size, ms };
    },
    onMutate: () => setTestStatus({ kind: "loading" }),
    onSuccess: async ({ blob, provider, bytes, ms }) => {
      try { audioRef.current?.pause(); } catch { /* noop */ }
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => URL.revokeObjectURL(url);
      a.onerror = () => URL.revokeObjectURL(url);
      await a.play().catch(() => { /* noop */ });
      setTestStatus({ kind: "ok", provider, bytes, ms });
      void health.refetch();
    },
    onError: (err: Error) => {
      setTestStatus({ kind: "error", message: err.message });
      void health.refetch();
    },
  });

  const runTest = (provider: "openai" | "elevenlabs" | "auto" | "browser") => {
    setTestProvider(provider);
    if (provider === "browser") {
      setTestStatus({ kind: "loading" });
      try {
        window.speechSynthesis?.cancel();
        const u = new SpeechSynthesisUtterance(TEST_PHRASE);
        u.rate = 0.95; u.pitch = 1.05;
        u.onend = () => setTestStatus({ kind: "ok", provider: "browser", bytes: 0, ms: 0 });
        u.onerror = () => setTestStatus({ kind: "error", message: "Browser speechSynthesis failed" });
        window.speechSynthesis.speak(u);
      } catch (e) {
        setTestStatus({ kind: "error", message: (e as Error).message });
      }
      return;
    }
    const provs = rubyTTS.providers?.providers;
    let v = testVoiceId;
    if (provider === "elevenlabs") v = provs?.elevenlabs.voices[0]?.id ?? v;
    if (provider === "openai")     v = provs?.openai.voices[0]?.id ?? "nova";
    if (provider === "auto")       v = provs?.elevenlabs.voices[0]?.id ?? provs?.openai.voices[0]?.id ?? "nova";
    setTestVoiceId(v);
    testMut.mutate({ provider, voiceId: v });
  };

  // Phase 22V — Reset every user's Ruby voice back to system default
  // (ElevenLabs / Bella). Admin/Owner only.
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const resetAllMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/ruby-voice/reset-all-to-bella", {
        method: "POST", credentials: "include",
      });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; rowsUpdated?: number; voiceName?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      return j;
    },
    onSuccess: (j) => {
      setResetMsg(`Reset ${j.rowsUpdated ?? 0} user(s) to ${j.voiceName ?? "Bella"}.`);
      void qc.invalidateQueries({ queryKey: ["admin", "ruby-voice", "health"] });
      setTimeout(() => setResetMsg(null), 5000);
    },
    onError: (e: Error) => setResetMsg(`Failed: ${e.message}`),
  });

  const stopAll = () => {
    try { audioRef.current?.pause(); } catch { /* noop */ }
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    setTestStatus({ kind: "idle" });
  };

  return (
    <PageShell title={`${name} Voice Settings`} description="Admin-only provider health, OpenAI tone/style controls, test voice playback, and TTS diagnostics.">
      <div className="space-y-4">
        {/* Provider Health */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-foreground text-base">Provider Health</CardTitle>
              <CardDescription>Server-side API key + reachability status. Keys are never exposed.</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => health.refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {health.isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> :
             !health.data?.ok ? <div className="text-sm text-danger">Failed to load health.</div> : (
              <div className="grid sm:grid-cols-3 gap-3">
                {(["elevenlabs", "openai", "browser"] as const).map((p) => {
                  const row = health.data!.providers[p];
                  return (
                    <div key={p} className="rounded-lg border border-border bg-background/40 p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-medium capitalize text-foreground">{p}</div>
                        {statusIcon(row.status)}
                      </div>
                      <div className="mt-2">{statusBadge(row.status)}</div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {row.configured ? "API key present on server." : "Not configured."}
                      </div>
                      {p === "openai" && health.data!.providers.openai.activeModel && (
                        <div className="mt-2 text-[11px] text-txt-secondary font-mono">
                          model: <span className="text-foreground">{health.data!.providers.openai.activeModel}</span>
                          {health.data!.providers.openai.activeModelSupportsStyle
                            ? <Badge className="ml-2 bg-violet-500/15 text-violet-300 border border-violet-500/30 text-[10px]">style-aware</Badge>
                            : <Badge className="ml-2 bg-secondary text-txt-secondary border border-border text-[10px]">no style</Badge>}
                        </div>
                      )}
                      {p === "elevenlabs" && health.data!.providers.elevenlabs.defaultVoiceName && (
                        <div className="mt-2 text-[11px] text-txt-secondary">
                          default voice: <span className="text-foreground font-medium">{health.data!.providers.elevenlabs.defaultVoiceName}</span>
                          {health.data!.providers.elevenlabs.defaultVoiceResolved
                            ? <Badge className="ml-2 bg-success/15 text-success border border-success/30 text-[10px]">resolved</Badge>
                            : <Badge className="ml-2 bg-warning/15 text-warning border border-warning/30 text-[10px]">unresolved</Badge>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
             )}
            {/* Reset every user to system default (Bella). Admin/Owner only. */}
            <div className="rounded-lg border border-border bg-background/40 p-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[220px]">
                <div className="text-sm font-medium text-foreground">Reset all users to system default voice</div>
                <div className="text-xs text-muted-foreground">
                  Bulk-updates every user&rsquo;s {name} voice to <strong>{health.data?.providers.elevenlabs.defaultVoiceName ?? "Bella"}</strong>{" "}
                  and turns auto-speak back on. Use after changing the system default.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resetAllMut.mutate()}
                disabled={resetAllMut.isPending}
              >
                {resetAllMut.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/> : <RotateCcw className="h-4 w-4 mr-1"/>}
                Reset all users to {health.data?.providers.elevenlabs.defaultVoiceName ?? "Bella"}
              </Button>
              {resetMsg && (
                <span className={resetMsg.startsWith("Failed") ? "text-xs text-danger w-full" : "text-xs text-success w-full"}>
                  {resetMsg}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Admin → OpenAI Tone & Style (ADMIN/OWNER only) */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground text-base">OpenAI Voice — Model &amp; Style</CardTitle>
            <CardDescription>
              Admin-only. Choose the OpenAI TTS model and (for style-aware
              models like <code>gpt-4o-mini-tts</code>) describe how {name} should sound.
              These settings apply to every user&rsquo;s {name} voice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="openai-model" className="text-xs text-muted-foreground">OpenAI TTS Model</Label>
                <Select
                  value={modelDraft || (adminSettings?.openaiModel ?? "tts-1-hd")}
                  onValueChange={(v) => { setModelDraft(v); setAdminSaveMsg(null); }}
                >
                  <SelectTrigger id="openai-model" className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {supportedModels.length === 0
                      ? <SelectItem value="tts-1-hd">tts-1-hd (default)</SelectItem>
                      : supportedModels.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                        ))}
                  </SelectContent>
                </Select>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {modelSupportsStyle
                    ? "This model accepts a voice-style description below."
                    : "This model ignores the voice-style description."}
                </div>
              </div>
              <div className="text-xs text-muted-foreground self-end">
                {adminSettings && (
                  <>
                    Last updated <span className="text-txt-secondary">{new Date(adminSettings.updatedAt).toLocaleString()}</span>
                    {adminSettings.updatedByUserId != null && <> by user #{adminSettings.updatedByUserId}</>}
                  </>
                )}
              </div>
            </div>
            <div>
              <Label htmlFor="voice-instructions" className="text-xs text-muted-foreground">
                Voice instructions / tone (max 2000 chars)
              </Label>
              <Textarea
                id="voice-instructions"
                value={styleDraft}
                onChange={(e) => { setStyleDraft(e.target.value); setAdminSaveMsg(null); }}
                rows={5}
                maxLength={2000}
                placeholder="e.g. Warm, confident, concise. Sound like a calm trading mentor."
                className="mt-1 font-mono text-xs"
                disabled={!modelSupportsStyle}
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{styleDraft.length} / 2000</span>
                {!modelSupportsStyle && <span className="text-warning">Selected model ignores this field.</span>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                onClick={() => saveAdminMut.mutate({ openaiModel: modelDraft, voiceInstructions: styleDraft })}
                disabled={saveAdminMut.isPending || !modelDraft}
              >
                {saveAdminMut.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/> : <Save className="h-4 w-4 mr-1"/>}
                Save admin settings
              </Button>
              {adminSaveMsg && (
                <span className={adminSaveMsg.startsWith("Failed") ? "text-xs text-danger" : "text-xs text-success"}>
                  {adminSaveMsg}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Test Voice */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground text-base">Test Voice</CardTitle>
            <CardDescription>
              Plays the phrase &ldquo;{TEST_PHRASE}&rdquo; through the selected provider.
              Uses the admin-configured OpenAI model and voice style. No chat message is sent.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => runTest("elevenlabs")} disabled={testMut.isPending} size="sm">
                {testMut.isPending && testProvider === "elevenlabs" ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/> : <Volume2 className="h-4 w-4 mr-1"/>}
                Test ElevenLabs
              </Button>
              <Button onClick={() => runTest("openai")} disabled={testMut.isPending} size="sm">
                {testMut.isPending && testProvider === "openai" ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/> : <Volume2 className="h-4 w-4 mr-1"/>}
                Test OpenAI
              </Button>
              <Button onClick={() => runTest("auto")} disabled={testMut.isPending} size="sm" variant="outline">
                {testMut.isPending && testProvider === "auto" ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/> : <Volume2 className="h-4 w-4 mr-1"/>}
                Test Auto
              </Button>
              <Button onClick={() => runTest("browser")} size="sm" variant="outline">
                <Volume2 className="h-4 w-4 mr-1"/>
                Test Browser Fallback
              </Button>
              <Button onClick={stopAll} size="sm" variant="ghost">
                <Square className="h-4 w-4 mr-1"/> Stop
              </Button>
            </div>
            <div className="text-sm">
              {testStatus.kind === "loading" && <span className="text-warning">Generating audio…</span>}
              {testStatus.kind === "ok" && (
                <span className="text-success">
                  Played via <strong>{testStatus.provider}</strong>
                  {testStatus.bytes ? ` — ${testStatus.bytes.toLocaleString()} bytes` : ""}
                  {testStatus.ms ? ` in ${testStatus.ms}ms` : ""}
                </span>
              )}
              {testStatus.kind === "error" && (
                <span className="text-danger">Failed: {testStatus.message}</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Current User Preference */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground text-base">Your {name} Preferences</CardTitle>
            <CardDescription>Per-user — persists to the backend (mirrored to localStorage as a cache).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded border border-border bg-background/40 p-3">
              <div>
                <div className="font-medium text-foreground">Speak responses</div>
                <div className="text-xs text-muted-foreground">When off, {name} stays silent in chat.</div>
              </div>
              <Switch checked={rubyTTS.enabled} onCheckedChange={() => {
                const next = !rubyTTS.enabled;
                rubyTTS.toggleEnabled();
                void userVoiceSettings.update({ enabled: next, speakResponses: next });
              }} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-sm mb-1 text-muted-foreground">Provider</div>
                <Select
                  value={rubyTTS.preference?.provider ?? "browser"}
                  onValueChange={(v) => {
                    const provs = rubyTTS.providers?.providers;
                    let voiceId = rubyTTS.preference?.voiceId ?? "";
                    if (v === "elevenlabs") voiceId = provs?.elevenlabs.voices[0]?.id ?? voiceId;
                    if (v === "openai")     voiceId = provs?.openai.voices[0]?.id ?? "nova";
                    rubyTTS.setPreference({ provider: v as "openai" | "elevenlabs" | "browser", voiceId });
                    void userVoiceSettings.update({
                      provider: v as "openai" | "elevenlabs" | "browser",
                      voiceId: voiceId || null,
                    });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="browser">Browser only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm mb-1 text-muted-foreground">Voice</div>
                <Select
                  value={rubyTTS.preference?.voiceId ?? ""}
                  onValueChange={(v) => {
                    const provider = rubyTTS.preference?.provider ?? "elevenlabs";
                    rubyTTS.setPreference({ provider, voiceId: v });
                    void userVoiceSettings.update({ provider, voiceId: v || null });
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="(pick a voice)"/></SelectTrigger>
                  <SelectContent>
                    {(rubyTTS.preference?.provider === "openai"
                      ? rubyTTS.providers?.providers.openai.voices
                      : rubyTTS.providers?.providers.elevenlabs.voices) ?.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.label} — {v.accent}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => rubyTTS.replay()} disabled={!rubyTTS.lastSpoken}>
                <RotateCcw className="h-4 w-4 mr-1"/> Replay last
              </Button>
              <Button size="sm" variant="ghost" onClick={() => rubyTTS.stop()}>
                <Square className="h-4 w-4 mr-1"/> Stop speaking
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Diagnostics */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground text-base">Recent TTS Calls</CardTitle>
            <CardDescription>Last 10 server-side TTS attempts. In-memory only. No keys, no text content.</CardDescription>
          </CardHeader>
          <CardContent>
            {(health.data?.recent ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No TTS calls yet. Try a test above.</div>
            ) : (
              <div className="space-y-2">
                {health.data!.recent.map((e, i) => (
                  <div key={i} className="rounded border border-border bg-background/40 p-2 text-xs font-mono space-y-1">
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                      <div className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</div>
                      <div>
                        {e.status === "ok"
                          ? <span className="text-success">OK {e.httpStatus}</span>
                          : <span className="text-danger">{e.errorCode ?? "ERR"} {e.httpStatus}</span>}
                      </div>
                      <div>asked: {e.providerAsked}</div>
                      <div>used: <span className={e.providerUsed === "none" ? "text-danger" : "text-foreground"}>{e.providerUsed}</span></div>
                      <div>{e.bytes ? `${e.bytes.toLocaleString()}B` : "—"}</div>
                      <div>{e.durationMs}ms{e.isTest ? " · test" : ""}</div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-txt-secondary">
                      <div>model: <span className="text-foreground">{e.openaiModel ?? "—"}</span></div>
                      <div>
                        style: {e.styleApplied
                          ? <span className="text-violet-300">applied</span>
                          : <span className="text-txt-muted">—</span>}
                      </div>
                      <div>
                        prefs: {e.loadedFromBackend
                          ? <span className="text-success">backend</span>
                          : <span className="text-warning">local</span>}
                      </div>
                      <div>
                        autoplay: {e.autoplayBlocked
                          ? <span className="text-warning">blocked</span>
                          : <span className="text-txt-muted">ok</span>}
                      </div>
                    </div>
                    {(e.fallbackReason || e.errorMessage) && (
                      <div className="text-[10px] text-warning">
                        {e.fallbackReason && <>fallback: {e.fallbackReason} </>}
                        {e.errorMessage}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
