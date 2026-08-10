import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { api, hydrateSession } from "../api.js";

export default function VerifyEmail() {
  const [state, setState] = useState({ status: "working", message: "Verifying your email…" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get("token") || "";
    if (!token) {
      setState({ status: "error", message: "This verification link is incomplete." });
      return;
    }
    api("/auth/email/verify", {
      method: "POST",
      suppressAuthRedirect: true,
      body: { token },
    })
      .then(async () => {
        await hydrateSession();
        setState({ status: "done", message: "Email verified. You can now sign in and connect providers." });
      })
      .catch((error) => setState({ status: "error", message: error.message }));
  }, []);

  return <div className="auth-wrap">
    <div className="brand">REEL<em>SCORE</em></div>
    <p className={state.status === "error" ? "error" : "notice"}>{state.message}</p>
    <Link className="btn" to="/login">Continue to sign in</Link>
  </div>;
}
