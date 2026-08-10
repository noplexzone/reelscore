import React, { useState } from "react";
import { Link } from "wouter";
import { api } from "../api.js";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/auth/password-reset/request", {
        method: "POST",
        suppressAuthRedirect: true,
        body: { email },
      });
      setMessage(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <h1>Reset password</h1>
    <p className="muted">Enter your verified email address. The response is the same whether or not an account exists.</p>
    <form className="list" onSubmit={submit}>
      <input type="email" autoComplete="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
    </form>
    <Link className="auth-link" to="/login">Back to sign in</Link>
  </div>;
}
