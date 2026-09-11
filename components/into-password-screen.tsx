"use client";

import { FormEvent, useState } from "react";

const missingConfigurationMessage =
  "INTO access password is not configured. Add INTO_ACCESS_PASSWORD in Vercel Environment Variables.";

export function IntoPasswordScreen({
  configured,
}: {
  configured: boolean;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(configured ? "" : missingConfigurationMessage);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || loading) {
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "INTO could not be unlocked. Please try again.");
        return;
      }

      window.location.replace("/");
    } catch {
      setError("INTO could not be unlocked. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f7f4] px-5 py-10 text-[#171b1d]">
      <section className="w-full max-w-md rounded-lg border border-stone-300 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-emerald-800">INTO</p>
        <h1 className="mt-2 text-2xl font-semibold">
          Enter INTO password
        </h1>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-semibold text-stone-700">
            Password
            <input
              className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:bg-stone-100"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus={configured}
              disabled={!configured || loading}
            />
          </label>
          {error ? (
            <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="w-full rounded-md bg-emerald-800 px-4 py-2.5 font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            type="submit"
            disabled={!configured || !password || loading}
          >
            {loading ? "Checking..." : "Continue"}
          </button>
        </form>
      </section>
    </main>
  );
}
