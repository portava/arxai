import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useRegister, type RegisterError } from "@/hooks/useCurrentUser";
import { Shield, AlertCircle, Key } from "lucide-react";

function formatArxKey(raw: string): string {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parts: string[] = [];
  if (stripped.startsWith("ARX")) {
    parts.push("ARX");
    const rest = stripped.slice(3);
    for (let i = 0; i < rest.length; i += 4) {
      parts.push(rest.slice(i, i + 4));
    }
  } else {
    for (let i = 0; i < stripped.length; i += 4) {
      parts.push(stripped.slice(i, i + 4));
    }
  }
  return parts.filter(Boolean).join("-").slice(0, 17);
}

export default function RegisterPage() {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registrationKey, setRegistrationKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const register = useRegister();

  function handleKeyChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const formatted = formatArxKey(e.target.value);
    setRegistrationKey(formatted);
    setKeyError(null);
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setKeyError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!registrationKey.trim()) {
      setKeyError("A registration key is required.");
      return;
    }
    try {
      await register.mutateAsync({ email, password, name: name || undefined, registrationKey });
      navigate("/");
    } catch (err) {
      const regErr = err as RegisterError;
      if (regErr.field === "registrationKey") {
        setKeyError(regErr.message);
      } else {
        setError(regErr.message);
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-background">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary">
            <Shield className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">ARX AI</h1>
          <p className="text-sm text-muted-foreground">Analyze · Risk · eXecute</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create your account</CardTitle>
            <CardDescription>You'll get a private workspace for trade sessions, MT5 demo connections, and AI analysis history.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" data-testid="form-register">
              <div className="space-y-2">
                <Label htmlFor="name">Name (optional)</Label>
                <Input
                  id="name" type="text" autoComplete="name"
                  value={name} onChange={(e) => setName(e.target.value)}
                  data-testid="input-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email" type="email" autoComplete="email" required
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password" type="password" autoComplete="new-password" required minLength={8}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-password"
                />
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="registrationKey" className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  Registration Key
                </Label>
                <Input
                  id="registrationKey"
                  type="text"
                  required
                  placeholder="ARX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                  value={registrationKey}
                  onChange={handleKeyChange}
                  className={keyError ? "border-destructive" : ""}
                  data-testid="input-registration-key"
                />
                {keyError ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="text-key-error">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{keyError}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">ARX is private right now. Enter your one-time access key to register.</p>
                )}
              </div>
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span data-testid="text-register-error">{error}</span>
                </div>
              )}
              <Button type="submit" className="w-full" disabled={register.isPending || !registrationKey.trim()} data-testid="button-submit-register">
                {register.isPending ? "Creating account…" : "Create account"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary underline-offset-4 hover:underline" data-testid="link-login">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Live broker execution is disabled. ARX AI is demo-only by default.
        </p>
      </div>
    </div>
  );
}
