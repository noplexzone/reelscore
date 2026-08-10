import React, { useState } from "react";
import { Link } from "wouter";
import { api, getUser } from "../api.js";

export default function ClaimEmail() {
  const user = getUser();
  const [email, setEmail] = useState(user?.email || "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/auth/email/claim", { method: "POST", body: { email } });
      setMessage(data.message || "Check your email to verify this address.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <section className="panel account-claim">
      <h1>Verify your email</h1>
      <p className="muted">A verified address is required before connecting Trakt or importing provider history.</p>
      <form className="list" onSubmit={submit}>
        <input type="email" autoComplete="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        {error && <div className="error" role="alert">{error}</div>}
        {message && <div className="notice" role="status">{message}</div>}
        <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send verification email"}</button>
      </form>
      <Link className="auth-link" to="/">Return home</Link>
    </section>
  </main>;
}
