import { useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { api, setToken } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
