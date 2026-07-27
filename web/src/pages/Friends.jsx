import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../api.js";
import { useToast } from "../App.jsx";

export default function Friends() {
  const [data, setData] = useState({ friends: [], pending: [] });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const toast = useToast();

  const load = () => api("/friends").then(setData).catch(() => {});
  useEffect(load, []);

  async function sendRequest(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/friends/request", { method: "POST", body: { username: name } });
      toast({ label: "Friend request sent", name });
      setName("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function respond(user_id, accept) {
    await api("/friends/respond", { method: "POST", body: { user_id, accept } });
    load();
  }

  return (
    <>
      <h2 className="section-title">Add a friend</h2>
      <form onSubmit={sendRequest} className="form-row">
        <input
          placeholder="Their username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn">Send request</button>
      </form>
      {error && <p className="error">{error}</p>}

      {data.pending.length > 0 && (
        <>
          <h2 className="section-title">Requests</h2>
          <div className="list">
            {data.pending.map((p) => (
              <div className="card row" key={p.user_id}>
                <div className="grow"><b>{p.username}</b> wants to compare boards.</div>
                <button className="btn small" onClick={() => respond(p.user_id, true)}>
                  Accept
                </button>
                <button className="btn ghost small" onClick={() => respond(p.user_id, false)}>
                  Decline
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Leaderboard</h2>
      {data.friends.length === 0 ? (
        <div className="card muted">
          No friends yet. Send a request above — scores are better with rivals.
        </div>
      ) : (
        <div className="list">
          {data.friends.map((f, i) => (
            <Link className="card row" to={`/u/${f.username}`} key={f.id}>
              <span className="pts" style={{ width: 28 }}>{i + 1}</span>
              <div className="grow">
                <b>{f.username}</b>
                <div className="muted">
                  {f.watches} films{f.streak > 0 ? ` · ${f.streak}-day streak` : ""}
                </div>
              </div>
              <span className="pts">{f.score.toLocaleString()}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
