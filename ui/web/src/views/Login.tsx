import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { api, setToken } from "../api";

export function Login({ onDone, initialError = "" }: { onDone: () => void; initialError?: string }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    api.providers().then((p) => setGoogle(p.google)).catch(() => setGoogle(false));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const res = mode === "login"
        ? await api.login(get("identity"), get("password"))
        : await api.signup(get("username"), get("email"), get("password"));
      setToken(res.token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-full place-items-center bg-fd-card px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6"><Logo size="lg" /></div>
        <h1 className="h-page">{mode === "login" ? "Sign in to the control plane" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          Operate sandboxed agent swarms: spawn, steer, checkpoint and audit.
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-4 rounded-xl border border-fd-border bg-fd-background p-5">
          {google && (
            <>
              <a
                href="/api/auth/google/start"
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-fd-border bg-fd-background px-3 text-sm font-medium hover:bg-fd-accent"
              >
                <GoogleIcon />
                Continue with Google
              </a>
              <div className="flex items-center gap-3 text-xs text-fd-muted-foreground" aria-hidden="true">
                <span className="h-px flex-1 bg-fd-border" />or<span className="h-px flex-1 bg-fd-border" />
              </div>
            </>
          )}
          {mode === "login" ? (
            <Field>
              <FieldLabel>Username or email</FieldLabel>
              <Input name="identity" autoComplete="username" required />
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel>Username</FieldLabel>
                <Input name="username" autoComplete="username" required />
              </Field>
              <Field>
                <FieldLabel>Email</FieldLabel>
                <Input name="email" type="email" autoComplete="email" required />
              </Field>
            </>
          )}
          <Field>
            <FieldLabel>Password</FieldLabel>
            <Input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
          </Field>
          {error && <p role="alert" className="rounded-md border border-rose-200 bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
          <Button type="submit" data-variant="solid" disabled={busy}>
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <p className="mt-4 text-sm text-fd-muted-foreground">
          {mode === "login" ? "New here? " : "Already have an account? "}
          <button type="button" className="font-medium text-fd-primary underline decoration-fd-border underline-offset-2 hover:decoration-fd-primary" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}

/** Google's "G", in its four brand colours, as their sign-in guidelines ask. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The alineo mark: the same burgundy tile as the docs favicon and app icon. */
export function Mark({ className = "size-6" }: { className?: string }) {
  return <img src="/logo-192.png" alt="" width={24} height={24} className={`${className} rounded-[5px]`} />;
}

/** Brand lockup from the docs brand page: mark + lowercase Inter Semibold wordmark. */
export function Logo({ size = "base" }: { size?: "base" | "lg" }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark className={size === "lg" ? "size-7" : "size-6"} />
      <span className={`${size === "lg" ? "text-xl" : "text-[17px]"} font-semibold tracking-[-0.02em]`}>alineo</span>
    </span>
  );
}
