import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useLogin } from "@/hooks/useCurrentUser";
import { useForgotPassword } from "@workspace/api-client-react";
import { normalizeProductRole, productRoleHomePath } from "@/lib/productRole";
import "./login.css";
import { beginInviteRegistration } from "@/lib/inviteCodeHandoff";
import { readReturnTo } from "@/lib/authReturnTo";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Key,
  UserPlus,
} from "lucide-react";

// ARX AI sign-in page.
// - AuthGate already prevents AppLayout/MobileBottomNav from rendering when
//   the user is anonymous, so the page intentionally renders bare (no nav,
//   no global shell). Keep that contract.
// - Wires the existing `useLogin` mutation. Never displays raw backend
//   errors — `useLogin` already normalises the response into a friendly
//   message ("Sign in failed.").
// - Forgot-password and Request-access have no dedicated backend endpoints
//   today, so each opens an honest modal that points to the operator
//   contact + registration path. No fake submissions.
// - Invite Code opens a modal that hands the code off to /register, where
//   the existing `inviteCode` field on POST /api/auth/register validates it.

const REMEMBER_EMAIL_KEY = "arx.login.rememberEmail.v1";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const [, navigate] = useLocation();
  const login = useLogin();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  // Task #202 — self-serve forgot-password request state. The modal posts the
  // email to /auth/forgot-password (neutral, no account enumeration) and always
  // shows the same confirmation regardless of whether the email exists.
  const forgot = useForgotPassword();
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotDone, setForgotDone] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  function resetForgot(): void {
    setForgotEmail("");
    setForgotDone(false);
    setForgotError(null);
  }

  async function submitForgot(): Promise<void> {
    setForgotError(null);
    if (!EMAIL_RE.test(forgotEmail.trim())) {
      setForgotError("Enter a valid email address.");
      return;
    }
    if (forgot.isPending) return;
    try {
      await forgot.mutateAsync({ data: { email: forgotEmail.trim() } });
      // Neutral success — the server never reveals whether an account exists.
      setForgotDone(true);
    } catch {
      // Only honestly-surfaced failure is a transport/validation error.
      setForgotError("Couldn't reach the server. Please try again.");
    }
  }

  // Task #203 — public "request access" form state.
  const [reqEmail, setReqEmail] = useState("");
  const [reqName, setReqName] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqDone, setReqDone] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  async function submitRequestAccess(): Promise<void> {
    setReqError(null);
    if (!EMAIL_RE.test(reqEmail.trim())) {
      setReqError("Enter a valid email address.");
      return;
    }
    setReqSubmitting(true);
    try {
      const res = await fetch("/api/auth/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: reqEmail.trim(),
          name: reqName.trim() || undefined,
          note: reqNote.trim() || undefined,
        }),
      });
      if (res.status === 400) {
        setReqError("Enter a valid email address.");
        return;
      }
      // Any other outcome is treated as the same neutral success — the server
      // never reveals whether the email was new, pending, invited, or a user.
      setReqDone(true);
    } catch {
      // Network failure is the only honestly-surfaced error.
      setReqError("Couldn't reach the server. Please try again.");
    } finally {
      setReqSubmitting(false);
    }
  }

  function resetRequestAccess(): void {
    setReqEmail("");
    setReqName("");
    setReqNote("");
    setReqError(null);
    setReqDone(false);
    setReqSubmitting(false);
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_EMAIL_KEY);
      if (saved) {
        setEmail(saved);
        setRemember(true);
      }
    } catch {
      /* localStorage unavailable — silent */
    }
  }, []);

  function validateEmail(value: string): boolean {
    if (!EMAIL_RE.test(value)) {
      setEmailError("Enter a valid email address.");
      return false;
    }
    setEmailError(null);
    return true;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validateEmail(email)) return;
    if (!password) {
      setFormError("Enter your password.");
      return;
    }
    if (login.isPending) return;
    try {
      const result = await login.mutateAsync({ email: email.trim(), password });
      try {
        if (remember) {
          window.localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
        } else {
          window.localStorage.removeItem(REMEMBER_EMAIL_KEY);
        }
      } catch {
        /* localStorage unavailable — silent */
      }
      // Route to the caller's role-based home (admin → admin command center,
      // investor → portal, trader → cockpit). AuthGate also bounces /login on
      // the next render, but navigating eagerly avoids an extra cycle.
      navigate(readReturnTo() ?? productRoleHomePath(normalizeProductRole(result.user.role)));
    } catch (err) {
      setFormError((err as Error).message || "Sign in failed.");
    }
  }

  function openInviteFromCode() {
    // The registration form consumes this one-time value and posts it using
    // the server's legacy `inviteCode` field. Keep it out of the URL/history.
    beginInviteRegistration(inviteCode, navigate);
  }

  return (
    <main className="arx-sign-in">
      <section className="arx-sign-in-card" aria-labelledby="sign-in-title">
        <div className="arx-sign-in-brand">ARX</div>
        <h1 id="sign-in-title">Sign in</h1>

            <form
              onSubmit={onSubmit}
              className="mt-8 space-y-5"
              data-testid="form-login"
              noValidate
            >
              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-semibold">
                  Email address
                </Label>
                <div className="relative">
                  <Mail
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailError) setEmailError(null);
                    }}
                    onBlur={(e) => {
                      if (e.target.value) validateEmail(e.target.value);
                    }}
                    className="pl-10 h-12 bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                    aria-invalid={!!emailError}
                    aria-describedby={emailError ? "email-error" : undefined}
                    data-testid="input-email"
                  />
                </div>
                {emailError && (
                  <p
                    id="email-error"
                    className="text-xs text-destructive"
                    data-testid="text-email-error"
                  >
                    {emailError}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-semibold">
                  Password
                </Label>
                <div className="relative">
                  <Lock
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10 pr-12 h-12 bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                    data-testid="input-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {/* Remember + forgot */}
              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2 text-muted-foreground cursor-pointer select-none">
                  <Checkbox
                    id="remember"
                    checked={remember}
                    onCheckedChange={(v) => setRemember(v === true)}
                    className="border-input data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    data-testid="checkbox-remember"
                  />
                  <span>Remember me</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    resetForgot();
                    setForgotEmail(email.trim());
                    setForgotOpen(true);
                  }}
                  className="text-primary hover:text-primary underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-primary/40 rounded"
                  data-testid="button-forgot-password"
                >
                  Forgot password?
                </button>
              </div>

              {/* Error banner */}
              {formError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span data-testid="text-login-error">{formError}</span>
                </div>
              )}

              {/* Sign in */}
              <Button
                type="submit"
                disabled={login.isPending}
                className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-70"
                data-testid="button-submit-login"
              >
                {login.isPending ? (
                  "Signing in…"
                ) : (
                  <span className="inline-flex items-center gap-2">
                    Sign In <ArrowRight className="h-4 w-4" />
                  </span>
                )}
              </Button>
            </form>

            {/* OR divider */}
            <div className="my-6 flex items-center gap-4 text-xs uppercase tracking-wider text-muted-foreground">
              <div className="h-px flex-1 bg-secondary" />
              OR
              <div className="h-px flex-1 bg-secondary" />
            </div>

            {/* Invite + Request */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setInviteOpen(true)}
                className="h-12 border-input bg-transparent text-foreground hover:bg-secondary hover:text-foreground"
                data-testid="button-use-invite-code"
              >
                <Key className="h-4 w-4 mr-2" />
                Use Invite Code
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRequestOpen(true)}
                className="h-12 border-input bg-transparent text-foreground hover:bg-secondary hover:text-foreground"
                data-testid="button-request-access"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Request Access
              </Button>
            </div>

        <p className="mt-6 text-sm text-muted-foreground">
          ARX is invite-only. An operator reviews each access request.
        </p>
      </section>

      {/* ───────── Forgot password modal ───────── */}
      <Dialog
        open={forgotOpen}
        onOpenChange={(open) => {
          setForgotOpen(open);
          if (!open) resetForgot();
        }}
      >
        <DialogContent className="arx-sign-in-dialog">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Enter the email address on your account and we'll send a link to
              reset your password.
            </DialogDescription>
          </DialogHeader>

          {forgotDone ? (
            <div
              className="flex items-start gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-success"
              data-testid="forgot-password-success"
            >
              <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0" />
              <span>
                If an account exists for that email, a password reset link has
                been sent. Check your inbox and follow the link to choose a new
                password.
              </span>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitForgot();
              }}
              className="space-y-4"
              noValidate
            >
              <div className="space-y-2">
                <Label htmlFor="forgot-email" className="text-sm font-semibold">
                  Email address
                </Label>
                <div className="relative">
                  <Mail
                    aria-hidden
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    className="pl-10 h-12 bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                    data-testid="input-forgot-email"
                  />
                </div>
              </div>

              {forgotError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span data-testid="text-forgot-error">{forgotError}</span>
                </div>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setForgotOpen(false)}
                  className="border-input bg-transparent text-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={forgot.isPending || !forgotEmail.trim()}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="button-submit-forgot"
                >
                  {forgot.isPending ? "Sending…" : "Send reset link"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ───────── Invite code modal ───────── */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="arx-sign-in-dialog">
          <DialogHeader>
            <DialogTitle>Use an invite code</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Paste the invite code you received. We’ll take you to the
              registration page to finish setting up your account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="invite-code" className="text-sm">
              Invite code
            </Label>
            <Input
              id="invite-code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="e.g. ARX-XXXX-XXXX"
              className="bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              autoComplete="off"
              data-testid="input-invite-code"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInviteOpen(false)}
              className="border-input bg-transparent text-foreground hover:bg-secondary hover:text-foreground"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={openInviteFromCode}
              disabled={!inviteCode.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-continue-invite"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───────── Request access modal ───────── */}
      <Dialog
        open={requestOpen}
        onOpenChange={(open) => {
          setRequestOpen(open);
          if (!open) resetRequestAccess();
        }}
      >
        <DialogContent className="arx-sign-in-dialog">
          <DialogHeader>
            <DialogTitle>Request access</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              ARX AI is invite-only. Tell us how to reach you and an operator
              will review your request.
            </DialogDescription>
          </DialogHeader>

          {reqDone ? (
            <div
              className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-success"
              data-testid="request-access-success"
            >
              Thanks — your request has been received. If you’re a fit, an
              operator will reach out with an invite. You can close this window.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="req-email" className="text-sm">
                  Email <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="req-email"
                  type="email"
                  value={reqEmail}
                  onChange={(e) => setReqEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                  autoComplete="email"
                  data-testid="input-request-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-name" className="text-sm">
                  Name <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="req-name"
                  value={reqName}
                  onChange={(e) => setReqName(e.target.value)}
                  placeholder="Your name"
                  className="bg-background border-input text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                  autoComplete="name"
                  data-testid="input-request-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-note" className="text-sm">
                  Note <span className="text-muted-foreground">(optional)</span>
                </Label>
                <textarea
                  id="req-note"
                  value={reqNote}
                  onChange={(e) => setReqNote(e.target.value)}
                  placeholder="A short note about your trading background."
                  rows={3}
                  maxLength={1000}
                  className="w-full rounded-md bg-background border border-input text-foreground placeholder:text-muted-foreground px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
                  data-testid="input-request-note"
                />
              </div>
              {reqError && (
                <p className="text-sm text-destructive" data-testid="request-access-error">
                  {reqError}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {reqDone ? (
              <Button
                type="button"
                onClick={() => setRequestOpen(false)}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="button-request-done"
              >
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRequestOpen(false)}
                  className="border-input bg-transparent text-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void submitRequestAccess()}
                  disabled={reqSubmitting || !reqEmail.trim()}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="button-submit-request"
                >
                  {reqSubmitting ? "Submitting…" : "Submit request"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
