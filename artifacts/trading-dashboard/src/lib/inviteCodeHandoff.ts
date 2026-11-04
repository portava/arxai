const PENDING_INVITE_CODE_KEY = "arx.registration.pendingInviteCode";

type Navigate = (path: string) => void;

/**
 * Carry a legacy invite from the sign-in modal to registration without keeping
 * the one-time code in the URL or browser history.
 */
export function beginInviteRegistration(rawCode: string, navigate: Navigate): boolean {
  const code = rawCode.trim();
  if (!code) return false;

  try {
    window.sessionStorage.setItem(PENDING_INVITE_CODE_KEY, code);
    navigate("/register");
  } catch {
    // Compatibility fallback for browsers that disable session storage.
    navigate(`/register?invite=${encodeURIComponent(code)}`);
  }
  return true;
}

/**
 * Consume the code staged by the sign-in modal. Also accepts links created by
 * the previous query-string handoff, then immediately removes that value from
 * the address bar and current history entry.
 */
export function consumePendingInviteCode(): string | null {
  try {
    const staged = window.sessionStorage.getItem(PENDING_INVITE_CODE_KEY)?.trim();
    if (staged) {
      window.sessionStorage.removeItem(PENDING_INVITE_CODE_KEY);
      return staged;
    }
  } catch {
    // Continue to the legacy URL fallback.
  }

  const currentUrl = new URL(window.location.href);
  const inviteCode = currentUrl.searchParams.get("invite")?.trim();
  if (!inviteCode) return null;

  currentUrl.searchParams.delete("invite");
  try {
    window.history.replaceState(
      window.history.state,
      "",
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    );
  } catch {
    // The form remains usable even when history cannot be replaced.
  }
  return inviteCode;
}
