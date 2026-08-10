import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, hydrateSession } from "../api.js";

function displayDate(value) {
  if (!value) return "Unknown";
  const normalized = /Z$|[+-]\d\d:\d\d$/u.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function RecoveryCodes({ codes, onDismiss }) {
  const [copied, setCopied] = useState(false);

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return <div className="recovery-box" role="status">
    <h3>Save these recovery codes now</h3>
    <p>Each code works once. They will not be shown again after you dismiss this list.</p>
    <div className="recovery-codes">{codes.map((code) => <code key={code}>{code}</code>)}</div>
    <div className="settings-actions">
      <button type="button" className="btn small" onClick={copyCodes}>{copied ? "Copied" : "Copy codes"}</button>
      <button type="button" className="btn ghost small" onClick={onDismiss}>I saved them</button>
    </div>
  </div>;
}

export default function Settings() {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [setup, setSetup] = useState(null);
  const [setupCode, setSetupCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryProof, setRecoveryProof] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableProof, setDisableProof] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [timezone, setTimezone] = useState("");
  const [timezoneLoading, setTimezoneLoading] = useState(true);
  const timezoneLoadVersion = useRef(0);
  const [timezoneError, setTimezoneError] = useState("");
  const [timezoneNotice, setTimezoneNotice] = useState("");
  const [timezoneBusy, setTimezoneBusy] = useState(false);

  const load = useCallback(async () => {
    const [mfa, sessionData] = await Promise.all([
      api("/auth/mfa/status"),
      api("/auth/sessions"),
    ]);
    setStatus(mfa);
    setSessions(sessionData.sessions || []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    const version = ++timezoneLoadVersion.current;
    api("/me")
      .then((account) => { if (timezoneLoadVersion.current === version) setTimezone(account.timezone || "UTC"); })
      .catch((err) => { if (timezoneLoadVersion.current === version) setTimezoneError(err.message); })
      .finally(() => { if (timezoneLoadVersion.current === version) setTimezoneLoading(false); });
    return () => { timezoneLoadVersion.current += 1; };
  }, []);

  function useBrowserTimezone() {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTimezone) setTimezone(browserTimezone);
  }

  async function saveTimezone(event) {
    event.preventDefault();
    setTimezoneBusy(true);
    setTimezoneError("");
    setTimezoneNotice("");
    try {
      const updated = await api("/me/settings", { method: "POST", body: { timezone } });
      setTimezone(updated.timezone);
      setTimezoneNotice("Timezone saved. Watch days and streaks were recalculated.");
    } catch (err) {
      setTimezoneError(err.message);
    } finally {
      setTimezoneBusy(false);
    }
  }

  async function run(action, operation) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function beginSetup() {
    run("begin", async () => {
      const data = await api("/auth/mfa/setup/begin", { method: "POST" });
      setSetup(data);
      setSetupCode("");
      setRecoveryCodes(null);
    });
  }

  function confirmSetup(event) {
    event.preventDefault();
    run("confirm", async () => {
      const data = await api("/auth/mfa/setup/confirm", { method: "POST", body: { code: setupCode } });
      setSetup(null);
      setSetupCode("");
      setRecoveryCodes(data.recovery_codes);
      setStatus((current) => ({ ...current, mfa_enabled: true, recovery_codes_remaining: data.recovery_codes.length }));
      await hydrateSession();
      setNotice("Two-factor authentication is enabled.");
    });
  }

  function regenerate(event) {
    event.preventDefault();
    run("regenerate", async () => {
      const data = await api("/auth/mfa/recovery/regenerate", {
        method: "POST",
        body: { password: recoveryPassword, code: recoveryProof },
      });
      setRecoveryCodes(data.recovery_codes);
      setRecoveryPassword("");
      setRecoveryProof("");
      setStatus((current) => ({ ...current, recovery_codes_remaining: data.recovery_codes.length }));
      setNotice("Previous recovery codes are no longer valid.");
    });
  }

  function disable(event) {
    event.preventDefault();
    run("disable", async () => {
      await api("/auth/mfa/disable", {
        method: "POST",
        body: { password: disablePassword, code: disableProof },
      });
      setDisablePassword("");
      setDisableProof("");
      setRecoveryCodes(null);
      setStatus({ mfa_enabled: false, recovery_codes_remaining: 0 });
      await hydrateSession();
      await load();
      setNotice("Two-factor authentication is disabled. Other sessions were revoked.");
    });
  }

  function revokeSession(id) {
    run(`revoke-${id}`, async () => {
      await api(`/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      setSessions((current) => current.filter((session) => session.id !== id));
      setNotice("Session revoked.");
    });
  }

  function revokeOthers() {
    run("revoke-others", async () => {
      const data = await api("/auth/sessions/revoke-others", { method: "POST" });
      setSessions((current) => current.filter((session) => session.current));
      setNotice(`${data.revoked} other session${data.revoked === 1 ? "" : "s"} revoked.`);
    });
  }

  const otherSessions = sessions.filter((session) => !session.current).length;

  return <main className="settings-page">
    <h1>Account settings</h1>
    {error && <div className="error settings-message" role="alert">{error}</div>}
    {notice && <div className="notice settings-message" role="status">{notice}</div>}

    <section className="card settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>Timezone</h2>
          <p className="muted">Your local calendar day determines current streaks.</p>
        </div>
      </div>
      {timezoneError && <div className="error settings-message" role="alert">{timezoneError}</div>}
      {timezoneNotice && <div className="notice settings-message" role="status">{timezoneNotice}</div>}
      {timezoneLoading && <p className="muted">Loading timezone…</p>}
      <form className="list" onSubmit={saveTimezone}>
        <label htmlFor="account-timezone">IANA timezone</label>
        <input id="account-timezone" list="common-timezones" value={timezone} onChange={(event) => setTimezone(event.target.value)} autoComplete="off" disabled={timezoneLoading} required />
        <datalist id="common-timezones">
          {["UTC", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/New_York", "Asia/Tokyo", "Australia/Sydney", "Europe/London"].map((zone) => <option value={zone} key={zone} />)}
        </datalist>
        <div className="settings-actions">
          <button className="btn" disabled={timezoneBusy || timezoneLoading || !timezone}>{timezoneBusy ? "Saving…" : "Save timezone"}</button>
          <button type="button" className="btn ghost" disabled={timezoneBusy || timezoneLoading} onClick={useBrowserTimezone}>Use browser timezone</button>
        </div>
      </form>
    </section>

    <section className="card settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>Two-factor authentication</h2>
          <p className="muted">Protect your account with an authenticator app and one-use recovery codes.</p>
        </div>
        {status && <span className={`status-pill ${status.mfa_enabled ? "enabled" : ""}`}>{status.mfa_enabled ? "Enabled" : "Disabled"}</span>}
      </div>

      {!status ? <p className="muted">Loading security settings…</p> : !status.mfa_enabled ? <>
        {!setup && <button className="btn" disabled={!!busy} onClick={beginSetup}>{busy === "begin" ? "Starting…" : "Set up authenticator app"}</button>}
        {setup && <div className="setup-box">
          <h3>Add ReelScore to your authenticator</h3>
          <ol>
            <li>Open your authenticator app and add an account.</li>
            <li><a className="inline-link" href={setup.otpauth_uri}>Open the setup link</a>, or enter this secret manually:</li>
          </ol>
          <code className="setup-secret">{setup.secret}</code>
          <form className="list" onSubmit={confirmSetup}>
            <input autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit authenticator code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required />
            <div className="settings-actions">
              <button className="btn" disabled={!!busy}>{busy === "confirm" ? "Verifying…" : "Verify and enable"}</button>
              <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setSetup(null)}>Cancel</button>
            </div>
          </form>
        </div>}
      </> : <>
        <p><strong>{status.recovery_codes_remaining}</strong> unused recovery code{status.recovery_codes_remaining === 1 ? "" : "s"} remaining.</p>
        {recoveryCodes && <RecoveryCodes codes={recoveryCodes} onDismiss={() => setRecoveryCodes(null)} />}
        <h3>Generate new recovery codes</h3>
        <p className="muted">This immediately invalidates every existing recovery code.</p>
        <form className="settings-form" onSubmit={regenerate}>
          <input type="password" autoComplete="current-password" placeholder="Current password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} required />
          <input autoComplete="one-time-code" placeholder="Authenticator or recovery code" value={recoveryProof} onChange={(event) => setRecoveryProof(event.target.value)} required />
          <button className="btn ghost" disabled={!!busy}>{busy === "regenerate" ? "Generating…" : "Generate new codes"}</button>
        </form>
        <hr className="divider" />
        <h3>Disable two-factor authentication</h3>
        <form className="settings-form" onSubmit={disable}>
          <input type="password" autoComplete="current-password" placeholder="Current password" value={disablePassword} onChange={(event) => setDisablePassword(event.target.value)} required />
          <input autoComplete="one-time-code" placeholder="Authenticator or recovery code" value={disableProof} onChange={(event) => setDisableProof(event.target.value)} required />
          <button className="btn danger" disabled={!!busy}>{busy === "disable" ? "Disabling…" : "Disable MFA"}</button>
        </form>
      </>}
    </section>

    <section className="card settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>Active sessions</h2>
          <p className="muted">Review browsers signed in to your account. Your current session is preserved.</p>
        </div>
        <button className="btn ghost small" disabled={!!busy || otherSessions === 0} onClick={revokeOthers}>{busy === "revoke-others" ? "Revoking…" : "Revoke all others"}</button>
      </div>
      <div className="session-list">{sessions.map((session) => <div className="session-row" key={session.id}>
        <div className="grow">
          <div><strong>{session.current ? "This device" : (session.user_agent || "Unknown browser")}</strong>{session.current && <span className="status-pill enabled">Current</span>}</div>
          {!session.current && session.user_agent && <div className="muted session-agent">{session.user_agent}</div>}
          <div className="muted">Last active {displayDate(session.last_seen_at)}{session.ip ? ` · ${session.ip}` : ""}</div>
          <div className="muted">Created {displayDate(session.created_at)} · Expires {displayDate(session.expires_at)}</div>
        </div>
        {!session.current && <button className="btn ghost small" disabled={!!busy} onClick={() => revokeSession(session.id)}>{busy === `revoke-${session.id}` ? "Revoking…" : "Revoke"}</button>}
      </div>)}</div>
      {sessions.length === 0 && <p className="muted">No active sessions found.</p>}
    </section>
  </main>;
}
