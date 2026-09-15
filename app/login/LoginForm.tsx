"use client";

import { FormEvent, useState } from "react";

export default function LoginForm({ nextPath }: { nextPath: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/local-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: form.get("password"), next: nextPath }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; redirectTo?: string };
      if (!response.ok || !result.redirectTo) throw new Error(result.error ?? "Unable to sign in.");
      window.location.assign(result.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="owner-password" className="text-sm font-medium text-foreground">Owner password</label>
        <input
          id="owner-password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          maxLength={1024}
          aria-describedby={error ? "login-error" : "login-help"}
          className="h-12 rounded-lg border border-border bg-background px-4 text-base text-foreground outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        <p id="login-help" className="text-xs leading-5 text-muted-foreground">This private workspace is available only to its owner.</p>
      </div>
      {error && <p id="login-error" role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-lg bg-amber-300 px-4 text-sm font-semibold text-[#17120a] transition hover:bg-amber-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Enter HeliosGen"}
      </button>
    </form>
  );
}
