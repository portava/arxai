import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
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
import LoginShowcase from "@/components/login/LoginShowcase";
import { useAssistantName } from "@/lib/assistant-name";
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
  const { name } = useAssistantName();

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
      navigate(productRoleHomePath(normalizeProductRole(result.user.role)));
    } catch (err) {
      setFormError((err as Error).message || "Sign in failed.");
    }
  }

  function openInviteFromCode() {
    const trimmed = inviteCode.trim();
    if (!trimmed) return;
    // Hand the code off to the existing registration flow, which validates
    // `inviteCode` server-side via POST /api/auth/register.
    navigate(`/register?invite=${encodeURIComponent(trimmed)}`);
  }

  return (
    <main className="min-h-screen w-full bg-[#050914] text-white overflow-x-hidden">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
        {/* ───────── Left: animated showcase ───────── */}
        <section className="relative hidden lg:flex flex-col justify-between p-10 xl:p-12 border-r border-white/10">
          {/* ambient gradients */}
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(circle_at_60%_25%,rgba(40,123,255,0.22),transparent_35%),radial-gradient(circle_at_80%_70%,rgba(126,58,242,0.18),transparent_38%)]"
          />
          <div
            aria-hidden
            className="absolute inset-0 opacity-30 bg-[linear-gradient(rgba(59,130,246,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.08)_1px,transparent_1px)] bg-[size:48px_48px]"
          />

          {/* Brand header */}
          <div className="relative z-10">
            <div className="text-4xl font-black tracking-tight">
              ARX <span className="text-blue-400">AI</span>
            </div>
            <p className="mt-3 text-xs tracking-[0.28em] text-blue-200">
              ANALYZE. RISK. eXECUTE.
            </p>
          </div>

          {/* Animated 3-slide showcase */}
          <LoginShowcase />

          <p className="relative z-10 text-xs text-slate-500">
            Trading involves risk. ARX AI is built to support disciplined
            decisions, not guarantee results.
          </p>
        </section>

        {/* ───────── Right: sign-in card ───────── */}
        <section className="flex items-center justify-center p-4 sm:p-8 lg:p-12">
          <div className="w-full max-w-xl rounded-[2rem] border border-blue-300/30 bg-white/[0.035] p-6 sm:p-8 lg:p-10 shadow-[0_0_70px_rgba(37,99,235,0.18)] backdrop-blur-xl">
            <div className="text-center">
              <div className="text-4xl sm:text-5xl font-black tracking-tight">
                ARX <span className="text-blue-400">AI</span>
              </div>
              <p className="mt-2 text-[11px] tracking-[0.28em] text-blue-200">
                ANALYZE. RISK. eXECUTE.
              </p>
              <h2 className="mt-7 text-2xl sm:text-3xl font-black">
                Welcome back
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Sign in to continue to your ARX AI account.
              </p>
            </div>

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
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
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
                    className="pl-10 h-12 bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
                    aria-invalid={!!emailError}
                    aria-describedby={emailError ? "email-error" : undefined}
                    data-testid="input-email"
                  />
                </div>
                {emailError && (
                  <p
                    id="email-error"
                    className="text-xs text-red-300"
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
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10 pr-12 h-12 bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
                    data-testid="input-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-300 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
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
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
                  <Checkbox
                    id="remember"
                    checked={remember}
                    onCheckedChange={(v) => setRemember(v === true)}
                    className="border-white/30 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
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
                  className="text-blue-300 hover:text-blue-200 underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500/40 rounded"
                  data-testid="button-forgot-password"
                >
                  Forgot password?
                </button>
              </div>

              {/* Error banner */}
              {formError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span data-testid="text-login-error">{formError}</span>
                </div>
              )}

              {/* Sign in */}
              <Button
                type="submit"
                disabled={login.isPending}
                className="w-full h-12 text-base font-bold bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 shadow-lg shadow-blue-500/20 disabled:opacity-70"
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
            <div className="my-6 flex items-center gap-4 text-xs uppercase tracking-wider text-slate-500">
              <div className="h-px flex-1 bg-white/10" />
              OR
              <div className="h-px flex-1 bg-white/10" />
            </div>

            {/* Invite + Request */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setInviteOpen(true)}
                className="h-12 border-white/15 bg-transparent text-white hover:bg-white/5 hover:text-white"
                data-testid="button-use-invite-code"
              >
                <Key className="h-4 w-4 mr-2" />
                Use Invite Code
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRequestOpen(true)}
                className="h-12 border-white/15 bg-transparent text-white hover:bg-white/5 hover:text-white"
                data-testid="button-request-access"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Request Access
              </Button>
            </div>

            {/* Ruby note */}
            <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs leading-5 text-slate-300">
              <span className="font-bold text-blue-300">{name}</span> helps
              analyze markets, risk, and execution — but{" "}
              <span className="font-bold text-blue-300">final control</span>{" "}
              stays protected by your permissions.
            </div>

            {/* Footer */}
            <p className="mt-6 text-center text-xs text-slate-500">
              Your data is encrypted. Your permissions protect everything.
            </p>
            <p className="mt-1 text-center text-sm">
              <span className="text-blue-400 font-semibold">Secure.</span>{" "}
              <span className="text-slate-300">Private.</span>{" "}
              <span className="text-slate-400">Yours.</span>
            </p>
            <p className="mt-6 text-center text-xs text-slate-500">
              ARX AI is invite-only. Use your invite code, or request access
              and an operator will review your account.
            </p>
          </div>
        </section>
      </div>

      {/* ───────── Forgot password modal ───────── */}
      <Dialog
        open={forgotOpen}
        onOpenChange={(open) => {
          setForgotOpen(open);
          if (!open) resetForgot();
        }}
      >
        <DialogContent className="bg-[#0a1428] border-blue-400/20 text-white">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription className="text-slate-400">
              Enter the email address on your account and we'll send a link to
              reset your password.
            </DialogDescription>
          </DialogHeader>

          {forgotDone ? (
            <div
              className="flex items-start gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-100"
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
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  />
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    className="pl-10 h-12 bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
                    data-testid="input-forgot-email"
                  />
                </div>
              </div>

              {forgotError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
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
                  className="border-white/15 bg-transparent text-white hover:bg-white/5 hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={forgot.isPending || !forgotEmail.trim()}
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500"
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
        <DialogContent className="bg-[#0a1428] border-blue-400/20 text-white">
          <DialogHeader>
            <DialogTitle>Use an invite code</DialogTitle>
            <DialogDescription className="text-slate-400">
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
              className="bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
              autoComplete="off"
              data-testid="input-invite-code"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInviteOpen(false)}
              className="border-white/15 bg-transparent text-white hover:bg-white/5 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={openInviteFromCode}
              disabled={!inviteCode.trim()}
              className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500"
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
        <DialogContent className="bg-[#0a1428] border-blue-400/20 text-white">
          <DialogHeader>
            <DialogTitle>Request access</DialogTitle>
            <DialogDescription className="text-slate-400">
              ARX AI is invite-only. Tell us how to reach you and an operator
              will review your request.
            </DialogDescription>
          </DialogHeader>

          {reqDone ? (
            <div
              className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-100"
              data-testid="request-access-success"
            >
              Thanks — your request has been received. If you’re a fit, an
              operator will reach out with an invite. You can close this window.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="req-email" className="text-sm">
                  Email <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="req-email"
                  type="email"
                  value={reqEmail}
                  onChange={(e) => setReqEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
                  autoComplete="email"
                  data-testid="input-request-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-name" className="text-sm">
                  Name <span className="text-slate-500">(optional)</span>
                </Label>
                <Input
                  id="req-name"
                  value={reqName}
                  onChange={(e) => setReqName(e.target.value)}
                  placeholder="Your name"
                  className="bg-black/25 border-white/15 text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-500/20"
                  autoComplete="name"
                  data-testid="input-request-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-note" className="text-sm">
                  Note <span className="text-slate-500">(optional)</span>
                </Label>
                <textarea
                  id="req-note"
                  value={reqNote}
                  onChange={(e) => setReqNote(e.target.value)}
                  placeholder="A short note about your trading background."
                  rows={3}
                  maxLength={1000}
                  className="w-full rounded-md bg-black/25 border border-white/15 text-white placeholder:text-slate-500 px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-500/20"
                  data-testid="input-request-note"
                />
              </div>
              {reqError && (
                <p className="text-sm text-red-400" data-testid="request-access-error">
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
                className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500"
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
                  className="border-white/15 bg-transparent text-white hover:bg-white/5 hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void submitRequestAccess()}
                  disabled={reqSubmitting || !reqEmail.trim()}
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500"
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
