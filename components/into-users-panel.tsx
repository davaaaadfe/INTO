"use client";

import { FormEvent, useEffect, useState } from "react";

type SafeUser = { id: string; email: string; displayName: string; status: "invited" | "active" | "disabled"; version: number };

export function IntoUsersPanel() {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [verificationUrl, setVerificationUrl] = useState("");
  const [busy, setBusy] = useState("");

  async function loadUsers() {
    const response = await fetch("/api/users");
    const body = await response.json() as { users?: SafeUser[]; error?: string };
    if (!response.ok || !body.users) throw new Error(body.error ?? "Users could not be loaded.");
    setUsers(body.users);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => loadUsers().catch((error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("invite"); setMessage(""); setVerificationUrl("");
    try {
      const response = await fetch("/api/users/invitations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, requestKey: crypto.randomUUID() }),
      });
      const body = await response.json() as { verificationUrl?: string; error?: string };
      if (!response.ok || !body.verificationUrl) throw new Error(body.error ?? "Invitation failed.");
      setVerificationUrl(body.verificationUrl); setEmail(""); setName("");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invitation failed.");
    } finally { setBusy(""); }
  }

  async function setStatus(user: SafeUser, status: "active" | "disabled") {
    setBusy(user.id); setMessage("");
    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: user.version, status }),
      });
      const body = await response.json() as { user?: SafeUser; error?: string };
      if (!response.ok || !body.user) throw new Error(body.error ?? "User status could not be changed.");
      setUsers((current) => current.map((item) => item.id === body.user!.id ? body.user! : item));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "User status could not be changed.");
      await loadUsers().catch(() => undefined);
    } finally { setBusy(""); }
  }

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-4" aria-labelledby="users-title">
      <h2 id="users-title" className="text-lg font-semibold">Users</h2>
      <p className="mt-1 text-sm text-stone-500">Invite verified people and manage account status.</p>
      <form className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={invite}>
        <label className="text-sm font-semibold">Email<input className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label className="text-sm font-semibold">Name<input className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
        <button className="self-end rounded-md bg-emerald-800 px-4 py-2 font-semibold text-white disabled:bg-stone-300" disabled={busy === "invite"}>Invite</button>
      </form>
      <div aria-live="polite" className="mt-3 text-sm">
        {message ? <p role="alert" className="text-red-700">{message}</p> : null}
        {verificationUrl ? <p className="break-all rounded-md border border-emerald-200 bg-emerald-50 p-3">One-time verification link: <a className="font-semibold underline" href={verificationUrl}>{verificationUrl}</a></p> : null}
      </div>
      <ul className="mt-4 divide-y divide-stone-200">
        {users.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><div className="font-semibold">{user.displayName}</div><div className="text-sm text-stone-500">{user.email} - {user.status}</div></div>
          {user.status !== "invited" ? <button className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold disabled:bg-stone-100" disabled={busy === user.id} onClick={() => setStatus(user, user.status === "active" ? "disabled" : "active")}>{user.status === "active" ? "Disable" : "Enable"}</button> : null}
        </li>)}
      </ul>
    </section>
  );
}
