import React, { useState } from "react";
import { Link } from "wouter";
import { api } from "../api.js";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = new URLSearchParams(window.location.search).get("token") || "";

  async function submit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password-reset/complete", {
        method: "POST",
        suppressAuthRedirect: true,
        body: { token, password },
      });
      setMessage("Password changed. All existing sessions were signed out.");
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <h1>Choose a new password</h1>
    {!token && <div className="error" role="alert">This reset link is incomplete.</div>}
    <form className="list" onSubmit={submit}>
      <input type="password" autoComplete="new-password" minLength="12" placeholder="New password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <input type="password" autoComplete="new-password" minLength="12" placeholder="Confirm new password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      <button className="btn" disabled={busy || !token}>{busy ? "Changing…" : "Change password"}</button>
    </form>
    <Link className="auth-link" to="/login">Back to sign in</Link>
  </div>;
}
