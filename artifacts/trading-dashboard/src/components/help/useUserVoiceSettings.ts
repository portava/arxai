// Ruby Voice settings — backend = source of truth.
//
// On mount this hook:
//   1. GETs /api/me/voice-settings (per-user row in `user_settings`).
//   2. Mirrors the result into the existing localStorage keys used by the
//      legacy hooks (useRubyTTS, useSpeakResponses, ArxAssistantLivePanel)
//      so they keep working without a refactor.
//   3. Performs a one-time migration: if the user has values in
//      localStorage but the backend row was just created (i.e. all server
//      fields equal their defaults AND a `migrated` flag isn't set), PUT
//      the local values back to the server so the user's existing
//      preferences are preserved.
//
// All mutations go through `update()`, which writes to the backend first,
// then mirrors into localStorage on success.
//
// SAFETY:
//   - Per-user — no cross-user data. requireUser on the server route.
//   - Never returns API keys.
//   - Falls open: if the backend is unreachable, the hook surfaces
//     `loadedFromBackend=false` and the legacy LS values continue to
//     drive the UI.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Legacy localStorage keys — kept identical to existing hooks so the
// mirror step is transparent to the rest of the app.
const LS_SPEAK_KEY      = "arx.assistant.speakResponses.v1";  // "1" | "0"
const LS_AUTO_LISTEN    = "arx.assistant.autoListen.v2";      // "1" | "0"
const LS_BROWSER_FB     = "arx.assistant.browserFallback.v1"; // "1" | "0"
const LS_TTS_PREF       = "arx.tts.preference.v1";            // { provider, voiceId }
const LS_MIGRATED_FLAG  = "arx.voicePrefs.migratedToServer.v1";

export interface UserVoicePrefs {
  enabled: boolean;
  speakResponses: boolean;
  autoListen: boolean;
  browserFallback: boolean;
  provider: "auto" | "elevenlabs" | "openai" | "browser";
  voiceId: string | null;
}

// Server defaults (mirror of meVoiceSettings.ts VOICE_DEFAULTS). Used to
// decide whether the server row is still pristine and therefore safe to
// migrate local values into.
const SERVER_DEFAULTS: UserVoicePrefs = {
  enabled: true,
  speakResponses: true,
  autoListen: true,
  browserFallback: true,
  provider: "auto",
  voiceId: null,
};
function serverPrefsArePristine(p: UserVoicePrefs): boolean {
  return (
    p.enabled         === SERVER_DEFAULTS.enabled &&
    p.speakResponses  === SERVER_DEFAULTS.speakResponses &&
    p.autoListen      === SERVER_DEFAULTS.autoListen &&
    p.browserFallback === SERVER_DEFAULTS.browserFallback &&
    p.provider        === SERVER_DEFAULTS.provider &&
    p.voiceId         === SERVER_DEFAULTS.voiceId
  );
}

function readLsBoolean(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch { return fallback; }
}

function readLsPref(): { provider: UserVoicePrefs["provider"]; voiceId: string | null } | null {
  try {
    const raw = localStorage.getItem(LS_TTS_PREF);
    if (!raw) return null;
    const j = JSON.parse(raw) as { provider?: string; voiceId?: string };
    if (!j || typeof j !== "object") return null;
    const p = (j.provider ?? "auto") as UserVoicePrefs["provider"];
    if (!["auto", "elevenlabs", "openai", "browser"].includes(p)) return null;
    return { provider: p, voiceId: j.voiceId ?? null };
  } catch { return null; }
}

function mirrorToLs(p: UserVoicePrefs): void {
  try {
    localStorage.setItem(LS_SPEAK_KEY,   p.speakResponses ? "1" : "0");
    localStorage.setItem(LS_AUTO_LISTEN, p.autoListen     ? "1" : "0");
    localStorage.setItem(LS_BROWSER_FB,  p.browserFallback ? "1" : "0");
    if (p.provider !== "auto" && p.voiceId) {
      localStorage.setItem(LS_TTS_PREF, JSON.stringify({ provider: p.provider, voiceId: p.voiceId }));
    }
  } catch { /* noop */ }
}

async function fetchMe(): Promise<{ id: number | null } | null> {
  try {
    // NOTE: server route is /api/me (mounted in routes/auth.ts), not
    // /api/auth/me, and the response shape is { user: { id, ... } }.
    const r = await fetch("/api/me", { credentials: "include" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as
      | { user?: { id?: number }; id?: number; userId?: number }
      | null;
    if (!j) return null;
    const id = j.user?.id ?? j.id ?? j.userId ?? null;
    return { id };
  } catch { return null; }
}

async function fetchPrefs(): Promise<UserVoicePrefs | null> {
  try {
    const r = await fetch("/api/me/voice-settings", { credentials: "include" });
    if (!r.ok) return null;
    const j = await r.json() as { ok: boolean; prefs: UserVoicePrefs };
    if (!j?.ok) return null;
    return j.prefs;
  } catch { return null; }
}

async function putPrefs(patch: Partial<UserVoicePrefs>): Promise<UserVoicePrefs | null> {
  try {
    const r = await fetch("/api/me/voice-settings", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    const j = await r.json() as { ok: boolean; prefs: UserVoicePrefs };
    return j?.ok ? j.prefs : null;
  } catch { return null; }
}

function migratedFlagKey(userId: number | null): string {
  // Per-user flag — same browser may serve different ARX accounts.
  return userId == null ? LS_MIGRATED_FLAG : `${LS_MIGRATED_FLAG}.u${userId}`;
}

async function runMigrationIfNeeded(
  serverPrefs: UserVoicePrefs,
  userId: number | null,
): Promise<UserVoicePrefs> {
  const flagKey = migratedFlagKey(userId);
  let already = false;
  try { already = localStorage.getItem(flagKey) === "1"; } catch { /* noop */ }
  if (already) return serverPrefs;

  // Safety gate: only migrate when the server row is still at defaults.
  // If the user has already saved anything server-side from another
  // device/session, do not let stale LS overwrite it. Mark migrated so
  // we don't re-check forever.
  if (!serverPrefsArePristine(serverPrefs)) {
    try { localStorage.setItem(flagKey, "1"); } catch { /* noop */ }
    return serverPrefs;
  }

  // Build a migration patch from the user's existing local values, only
  // for keys actually present in LS (so we don't override server defaults
  // with our own defaults).
  //
  // IMPORTANT: we intentionally DO NOT migrate `provider` / `voiceId`
  // from LS_TTS_PREF. That LS key is auto-populated by `useRubyTTS`
  // once `/api/me/assistant/tts/voices` resolves (it picks the server's
  // `defaultProvider` / `defaultVoice` when no LS pref exists) — those
  // are NOT user-chosen values and migrating them would silently
  // overwrite the pristine server row with e.g. elevenlabs/rachel
  // every time a fresh device loads the app. Real user voice changes
  // are wired explicitly through `userVoiceSettings.update()` at the
  // UI handler level.
  const patch: Partial<UserVoicePrefs> = {};
  let hasAnything = false;
  try {
    if (localStorage.getItem(LS_SPEAK_KEY)   !== null) { patch.speakResponses  = readLsBoolean(LS_SPEAK_KEY,   true); hasAnything = true; }
    if (localStorage.getItem(LS_AUTO_LISTEN) !== null) { patch.autoListen      = readLsBoolean(LS_AUTO_LISTEN, true); hasAnything = true; }
    if (localStorage.getItem(LS_BROWSER_FB)  !== null) { patch.browserFallback = readLsBoolean(LS_BROWSER_FB,  true); hasAnything = true; }
  } catch { /* noop */ }

  if (!hasAnything) {
    try { localStorage.setItem(flagKey, "1"); } catch { /* noop */ }
    return serverPrefs;
  }

  const updated = await putPrefs(patch);
  if (!updated) {
    // PUT failed — DO NOT set the migrated flag. We'll retry on the
    // next mount. Keep serverPrefs as-is and skip the LS mirror at the
    // caller (since serverPrefs are still defaults, mirroring would
    // stomp the user's real LS values).
    return serverPrefs;
  }
  try { localStorage.setItem(flagKey, "1"); } catch { /* noop */ }
  return updated;
}

export interface UseUserVoiceSettingsApi {
  prefs: UserVoicePrefs | null;
  loadedFromBackend: boolean;
  isLoading: boolean;
  update: (patch: Partial<UserVoicePrefs>) => Promise<void>;
  refetch: () => Promise<void>;
}

const QUERY_KEY = ["me", "voice-settings"] as const;

export function useUserVoiceSettings(): UseUserVoiceSettingsApi {
  const qc = useQueryClient();
  const q = useQuery<UserVoicePrefs | null>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const p = await fetchPrefs();
      if (!p) return null;
      const me = await fetchMe();
      const userId = me?.id ?? null;
      const beforeMigration = p;
      const finalP = await runMigrationIfNeeded(p, userId);
      // Mirror to LS only when we actually got a meaningful server
      // value: either the server row was non-pristine, or migration
      // PUT succeeded (finalP !== beforeMigration). Otherwise leave
      // the legacy LS values alone so the next mount can retry.
      if (!serverPrefsArePristine(beforeMigration) || finalP !== beforeMigration) {
        mirrorToLs(finalP);
      }
      return finalP;
    },
    staleTime: 5 * 60_000,
  });

  const mut = useMutation({
    mutationFn: async (patch: Partial<UserVoicePrefs>) => {
      const next = await putPrefs(patch);
      if (next) mirrorToLs(next);
      return next;
    },
    onSuccess: (next) => {
      if (next) qc.setQueryData(QUERY_KEY, next);
    },
  });

  return {
    prefs:             q.data ?? null,
    loadedFromBackend: !!q.data,
    isLoading:         q.isLoading,
    update: async (patch) => { await mut.mutateAsync(patch); },
    refetch: async () => { await q.refetch(); },
  };
}

// Side-effect-free getter exported so non-React callers (e.g. the TTS
// fetch payload) can mark requests as "driven by backend prefs" for
// diagnostics. Backed by the localStorage migration flag.
export function voicePrefsAreServerBacked(): boolean {
  try { return localStorage.getItem(LS_MIGRATED_FLAG) === "1"; } catch { return false; }
}
