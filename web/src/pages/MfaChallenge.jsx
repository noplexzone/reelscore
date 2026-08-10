import React, { useEffect, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { api, isAuthed, setSession } from "../api.js";

const CHALLENGE_KEY = "reelscore-mfa-challenge";

export function saveMfaChallenge(challenge) {
  sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify({
    challenge_token: challenge.challenge_token,
    expires_at: challenge.expires_at,
  }));
}

function loadMfaChallenge() {
  try {
    const challenge = JSON.parse(sessionStorage.getItem(CHALLENGE_KEY) || "null");
    if (!challenge?.challenge_token || !Number.isFinite(challenge.expires_at)) return null;
    return challenge;
  } catch {
    return null;
  }
}

export default function MfaChallenge() {
  const [challenge] = useState(loadMfaChallenge);
  const [expired, setExpired] = useState(() => !challenge || challenge.expires_at <= Date.now());
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (expired) {
      sessionStorage.removeItem(CHALLENGE_KEY);
      return undefined;
    }
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, challenge.expires_at - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [challenge, expired]);

  if (isAuthed()) return <Redirect to="/" />;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/auth/mfa/challenge", {
        method: "POST",
        suppressAuthRedirect: true,
        body: { challenge_token: challenge.challenge_token, code },
      });
      sessionStorage.removeItem(CHALLENGE_KEY);
      setSession(data.user, data.csrf_token);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <h1 className="auth-heading">Two-factor authentication</h1>
    {expired ? <>
      <div className="error" role="alert">This sign-in challenge has expired. Sign in again.</div>
      <Link className="auth-link" to="/login">Return to sign in</Link>
    </> : <>
      <p className="auth-tagline">Enter the six-digit code from your authenticator app or one recovery code.</p>
      <form className="list" onSubmit={submit}>
        <input
          autoFocus
          autoComplete="one-time-code"
          inputMode="text"
          placeholder="Authenticator or recovery code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? "Verifying…" : "Verify and sign in"}</button>
      </form>
      <Link className="auth-link" to="/login" onClick={() => sessionStorage.removeItem(CHALLENGE_KEY)}>Cancel and sign in again</Link>
    </>}
  </div>;
}
