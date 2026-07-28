import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../App.jsx";

export default function Admin() {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [newCode, setNewCode] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [u, i] = await Promise.all([api(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`), api("/admin/invites")]);
      setUsers(u.users); setInvites(i.invites); setError("");
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function act(path, body, label) {
    try { await api(path, { method: "POST", body }); toast({ label: "Admin", name: label }); await load(); }
    catch (e) { setError(e.message); }
  }
  async function createInvite(e) {
    e.preventDefault();
    try {
      const data = await api("/admin/invites", { method: "POST", body: email ? { email } : {} });
      setNewCode(data.invite_code); setEmail(""); await load();
    } catch (e) { setError(e.message); }
  }

  return <main className="page"><header className="page-header"><div><p className="eyebrow">Hosted operations</p><h1>Admin</h1></div></header>
    {error && <div className="error">{error}</div>}
    <section className="section"><div className="section-head"><h2>Users</h2><form onSubmit={(e) => { e.preventDefault(); load(); }}><input aria-label="Search users" placeholder="Search username" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="btn">Search</button></form></div>
      <div className="list">{users.map((u) => <article className="card" key={u.id}><div className="card-body"><div className="card-title">{u.username}</div><div className="muted">{u.role} · {u.status} · Providers: {u.linked_services.length ? u.linked_services.join(", ") : "none"}</div><div className="actions">
        <button className="btn ghost" onClick={() => act(`/admin/users/${u.id}/status`, { status: u.status === "active" ? "disabled" : "active" }, u.status === "active" ? `Disabled ${u.username}` : `Reactivated ${u.username}`)}>{u.status === "active" ? "Disable" : "Reactivate"}</button>
        <button className="btn ghost" onClick={() => act(`/admin/users/${u.id}/role`, { role: u.role === "admin" ? "user" : "admin" }, `Updated ${u.username}'s role`)}>{u.role === "admin" ? "Remove admin" : "Make admin"}</button>
        <button className="btn ghost" onClick={() => act(`/admin/users/${u.id}/sessions/revoke`, {}, `Revoked ${u.username}'s sessions`)}>Revoke sessions</button>
      </div></div></article>)}</div>
    </section>
    <section className="section"><div className="section-head"><h2>Invites</h2></div><form className="list" onSubmit={createInvite}><input type="email" placeholder="Email label (optional)" value={email} onChange={(e) => setEmail(e.target.value)} /><button className="btn">Create invite</button></form>
      {newCode && <div className="card"><div className="card-body"><div className="muted">Copy now; it is shown once.</div><code>{newCode}</code></div></div>}
      <div className="list">{invites.map((i) => <article className="card" key={i.id}><div className="card-body"><div className="card-title">{i.email || `Invite #${i.id}`}</div><div className="muted">{i.used_at ? `Used by ${i.used_by_name}` : i.revoked ? "Revoked" : `Expires ${new Date(i.expires_at).toLocaleString()}`}</div>{!i.revoked && !i.used_at && <button className="btn ghost" onClick={() => act(`/admin/invites/${i.id}/revoke`, {}, "Invite revoked")}>Revoke</button>}</div></article>)}</div>
    </section>
  </main>;
}
