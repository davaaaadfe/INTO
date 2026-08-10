"use client";

import { FormEvent, useState } from "react";

export function IntoVerificationScreen({ token }: { token: string }) {
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, displayName, password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Verification failed.");
      window.location.replace("/");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f7f4] px-5 py-10 text-[#171b1d]">
      <section className="w-full max-w-md rounded-lg border border-stone-300 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-emerald-800">INTO</p>
        <h1 className="mt-2 text-2xl font-semibold">Verify your account</h1>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-semibold text-stone-700">Display name
            <input className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" autoFocus required maxLength={120} />
          </label>
          <label className="block text-sm font-semibold text-stone-700">Password
            <input className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={12} maxLength={1024} />
          </label>
          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
          <button className="w-full rounded-md bg-emerald-800 px-4 py-2.5 font-semibold text-white disabled:bg-stone-300" disabled={loading || !token || !displayName || password.length < 12}>
            {loading ? "Verifying..." : "Verify and sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
