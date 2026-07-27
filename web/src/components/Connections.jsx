import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../App.jsx";

// Link Plex / Trakt and pull in watch history. Shown only on your own profile.
export default function Connections({ onSynced }) {
  const [conns, setConns] = useState(null);
  const [trakt, setTrakt] = useState(null); // pending device-code info
  const [plexUrl, setPlexUrl] = useState("");
  const [plexToken, setPlexToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(null);
  const toast = useToast();

  const load = () => api("/connections").then(setConns).catch(() => {});
  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, []);

  async function startTrakt() {
    setError("");
    try {
      const d = await api("/connections/trakt/init", { method: "POST" });
      setTrakt(d);
      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > d.expires_in * 1000) {
          clearInterval(pollRef.current);
          setTrakt(null);
          setError("The Trakt code expired — try again.");
          return;
        }
        try {
          const r = await api("/connections/trakt/exchange", {
            method: "POST",
            body: { device_code: d.device_code },
          });
          if (!r.pending) {
            clearInterval(pollRef.current);
            setTrakt(null);
            toast({ label: "Trakt linked", name: r.username || "Connected" });
            load();
          }
        } catch (e) {
          clearInterval(pollRef.current);
          setTrakt(null);
          setError(e.message);
        }
      }, (d.interval || 5) * 1000);
    } catch (e) {
      setError(e.message);
    }
  }

  async function connectPlex(e) {
    e.preventDefault();
    setError("");
    setBusy("plex-connect");
    try {
      const r = await api("/connections/plex", {
        method: "POST",
        body: { server_url: plexUrl, token: plexToken },
      });
      toast({ label: "Plex linked", name: r.server_name });
      setPlexUrl(""); setPlexToken("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function sync(service) {
    setError("");
    setBusy(`${service}-sync`);
    try {
      const r = await api(`/connections/${service}/sync`, { method: "POST" });
      toast({
        label: `${service === "plex" ? "Plex" : "Trakt"} sync complete`,
        name: `${r.imported} imported · ${r.verified} verified`,
        desc: r.skipped ? `${r.skipped} already synced` : null,
      });
      for (const a of r.new_achievements) {
        toast({ label: "Achievement unlocked", name: a.name, desc: a.description, points: a.points });
      }
      load();
      onSynced?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function unlink(service) {
    await api(`/connections/${service}`, { method: "DELETE" });
    load();
  }

  if (!conns) return null;

  return (
    <>
      <h2 className="section-title">Connections</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Link a service and its history imports automatically — synced films get a
        verified badge as proof they're really in your watch history.
      </p>
      {error && <p className="error">{error}</p>}

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row">
          <div className="grow">
            <b>Trakt</b>{" "}
            {conns.trakt.linked && <span className="verified trakt">✓ {conns.trakt.username || "linked"}</span>}
            <div className="muted">
              {!conns.trakt.configured
                ? "Not configured on this server (set TRAKT_CLIENT_ID / TRAKT_CLIENT_SECRET)."
                : conns.trakt.linked
                ? conns.trakt.last_synced_at
                  ? `Last synced ${conns.trakt.last_synced_at} UTC`
                  : "Linked — run your first sync."
                : trakt
                ? <>Go to <b>{trakt.verification_url}</b> and enter code <b className="pts">{trakt.user_code}</b> — waiting…</>
                : "Import your Trakt watch history."}
            </div>
          </div>
          {conns.trakt.linked ? (
            <>
              <button className="btn small" onClick={() => sync("trakt")} disabled={busy === "trakt-sync"}>
                {busy === "trakt-sync" ? "Syncing…" : "Sync now"}
              </button>
              <button className="btn ghost small" onClick={() => unlink("trakt")}>Unlink</button>
            </>
          ) : (
            conns.trakt.configured && !trakt && (
              <button className="btn small" onClick={startTrakt}>Connect</button>
            )
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div className="grow" style={{ minWidth: 220 }}>
            <b>Plex</b>{" "}
            {conns.plex.linked && <span className="verified plex">✓ {conns.plex.server_name || "linked"}</span>}
            <div className="muted">
              {conns.plex.linked
                ? conns.plex.last_synced_at
                  ? `Last synced ${conns.plex.last_synced_at} UTC`
                  : "Linked — run your first sync."
                : "Import watched movies from your Plex server."}
            </div>
          </div>
          {conns.plex.linked ? (
            <>
              <button className="btn small" onClick={() => sync("plex")} disabled={busy === "plex-sync"}>
                {busy === "plex-sync" ? "Syncing…" : "Sync now"}
              </button>
              <button className="btn ghost small" onClick={() => unlink("plex")}>Unlink</button>
            </>
          ) : (
            <form onSubmit={connectPlex} className="plex-form">
              <input
                placeholder="http://your-server:32400"
                value={plexUrl}
                onChange={(e) => setPlexUrl(e.target.value)}
              />
              <input
                type="password"
                placeholder="X-Plex-Token"
                value={plexToken}
                onChange={(e) => setPlexToken(e.target.value)}
              />
              <button className="btn small" disabled={busy === "plex-connect"}>
                {busy === "plex-connect" ? "Checking…" : "Connect"}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
