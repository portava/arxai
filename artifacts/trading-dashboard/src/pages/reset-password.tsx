import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useResetPassword } from "@workspace/api-client-react";
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, Lock } from "lucide-react";

// Task #202 — self-serve reset-password page.
// - Anonymous-reachable: AuthGate explicitly allows /reset-password while
//   logged out so a user who forgot their password can follow the emailed link.
// - Consumes the single-use token from ?token= in the URL and posts it with the
//   new password via the generated useResetPassword hook. Inputs are validated
//   client-side with the generated Zod schema before submit.
// - On success the user's existing sessions are already invalidated server-side;
//   we simply send them to /login to sign in with the new password.

const MIN_PASSWORD = 8;

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = useMemo(() => new URLSearchParams(search).get("token") ?? "", [search]);

  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const missingToken = token.trim().length === 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (missingToken) {
      setFormError("This reset link is missing its token. Request a new link from the sign-in page.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFormError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setFormError("Passwords do not match.");
      return;
    }
    if (reset.isPending) return;
    try {
      // Server validates token + password with the generated Zod schema.
      await reset.mutateAsync({ data: { token, password } });
      setDone(true);
    } catch (err) {
      // useResetPassword surfaces a normalised message; never raw backend text.
      setFormError(
        (err as Error)?.message ||
          "This reset link is invalid or has expired. Please request a new one.",
      );
    }
  }

  return (
    <main className="min-h-screen w-full bg-[#050914] text-white flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md rounded-[2rem] border border-primary/30 bg-white/[0.035] p-6 sm:p-8 lg:p-10 shadow-[0_0_70px_rgba(37,99,235,0.18)] backdrop-blur-xl">
        <div className="text-center">
          <div className="text-3xl sm:text-4xl font-black tracking-tight">
            ARX <span className="text-primary">AI</span>
          </div>
          <p className="mt-2 text-[11px] tracking-[0.28em] text-primary">
            ANALYZE. RISK. eXECUTE.
          </p>
          <h2 className="mt-7 text-2xl font-black">Set a new password</h2>
          <p className="mt-1 text-sm text-txt-secondary">
            Choose a new password for your ARX AI account.
          </p>
        </div>

        {done ? (
          <div className="mt-8 space-y-5">
            <div
              className="flex items-start gap-3 rounded-lg border border-success/20 bg-success/10 p-4 text-sm text-success"
              data-testid="reset-password-success"
            >
              <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0" />
              <span>
                Your password has been reset. For your security, any existing
                sessions have been signed out. You can now sign in with your new
                password.
              </span>
            </div>
            <Button
              type="button"
              onClick={() => navigate("/login")}
              className="w-full h-12 text-base font-bold bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
              data-testid="button-go-to-login"
            >
              <span className="inline-flex items-center gap-2">
                Go to sign in <ArrowRight className="h-4 w-4" />
              </span>
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate data-testid="form-reset-password">
            {missingToken && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  This reset link is incomplete. Request a new one from the
                  sign-in page.
                </span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-sm font-semibold">
                New password
              </Label>
              <div className="relative">
                <Lock
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-secondary"
                />
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-12 h-12 bg-black/25 border-white/15 text-white placeholder:text-txt-muted focus-visible:border-primary focus-visible:ring-primary/20"
                  data-testid="input-new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-md text-txt-secondary hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  data-testid="button-toggle-new-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-sm font-semibold">
                Confirm new password
              </Label>
              <div className="relative">
                <Lock
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-secondary"
                />
                <Input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder="Re-enter your new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="pl-10 h-12 bg-black/25 border-white/15 text-white placeholder:text-txt-muted focus-visible:border-primary focus-visible:ring-primary/20"
                  data-testid="input-confirm-password"
                />
              </div>
            </div>

            {formError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span data-testid="text-reset-error">{formError}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={reset.isPending || missingToken}
              className="w-full h-12 text-base font-bold bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary shadow-lg shadow-blue-500/20 disabled:opacity-70"
              data-testid="button-submit-reset"
            >
              {reset.isPending ? "Resetting…" : "Reset password"}
            </Button>

            <p className="text-center text-sm text-txt-secondary">
              <Link
                href="/login"
                className="text-primary hover:text-primary underline-offset-4 hover:underline"
                data-testid="link-back-to-login"
              >
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
