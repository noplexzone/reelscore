import React, { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { api, getUser } from "../api.js";
import { useToast } from "../App.jsx";

const DEFAULT_SEASON = { name: "", mode: "challenge", rule_version: "season-v1", start_date: "", end_date: "" };
const DEFAULT_CHALLENGE = { slug: "", title: "", description: "", points: 25, rule_version: "challenge-v1" };

function formatDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}
function todayMonth() { return new Date().toISOString().slice(0, 7); }
function mondayOfThisWeek() {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}
function roleCanManage(role) { return role === "owner" || role === "admin"; }
function safeSlug(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function ErrorLine({ message }) { return message ? <p className="error">{message}</p> : null; }

function LeagueList() {
  const [leagues, setLeagues] = useState([]);
  const [create, setCreate] = useState({ name: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", default_mode: "challenge" });
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const toast = useToast();
  const load = () => api("/leagues").then((d) => setLeagues(d.leagues || []));
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  async function createLeague(e) {
    e.preventDefault(); setError("");
    try {
      const { league } = await api("/leagues", { method: "POST", body: { ...create, name: create.name.trim() } });
      toast({ label: "League created", name: league.name });
      setCreate((value) => ({ ...value, name: "" })); await load();
    } catch (err) { setError(err.message); }
  }
  async function joinLeague(e) {
    e.preventDefault(); setError("");
    const token = invite.includes("invite=") ? invite.split("invite=").pop() : invite;
    try {
      const { league } = await api("/leagues/invites/accept", { method: "POST", body: { token: decodeURIComponent(token.trim()) } });
      toast({ label: "League joined", name: league.name }); setInvite(""); await load();
    } catch (err) { setError(err.message); }
  }
  return <main className="leagues-page">
    <div className="league-hero card"><div><p className="eyebrow">Private leagues</p><h1>Season boards, challenge bonuses, and rival receipts.</h1><p className="muted">Keep the movie diary private while giving each group its own competitive layer.</p></div><span className="league-count">{leagues.length}</span></div>
    <ErrorLine message={error} />
    <section className="league-grid">
      <form className="card league-form" onSubmit={createLeague}><h2>Create league</h2><input required placeholder="League name" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /><input required placeholder="Timezone" value={create.timezone} onChange={(e) => setCreate({ ...create, timezone: e.target.value })} /><select value={create.default_mode} onChange={(e) => setCreate({ ...create, default_mode: e.target.value })}><option value="challenge">Challenge season</option><option value="casual">Casual</option><option value="verified">Verified only</option></select><button className="btn">Create</button></form>
      <form className="card league-form" onSubmit={joinLeague}><h2>Join with invite</h2><input required placeholder="Paste /join#invite=… or token" value={invite} onChange={(e) => setInvite(e.target.value)} /><button className="btn ghost">Join league</button></form>
    </section>
    <h2 className="section-title">Your leagues</h2>
    {leagues.length === 0 ? <div className="card muted">No private leagues yet. Create one or paste an invite.</div> : <div className="list">{leagues.map((league) => <Link className="card row" to={`/leagues/${league.id}`} key={league.id}><div className="grow"><b>{league.name}</b><div className="muted">{league.default_mode} · {league.timezone} · {league.role}</div></div>{league.archived_at && <span className="status-pill">Archived</span>}<span className="pts">Open</span></Link>)}</div>}
  </main>;
}

function Leaderboard({ league, selectedSeason }) {
  const [scope, setScope] = useState("lifetime");
  const [weekStart, setWeekStart] = useState(mondayOfThisWeek());
  const [month, setMonth] = useState(todayMonth());
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const seasonId = selectedSeason?.id;
  async function load() {
    setError("");
    let path = `/leagues/${league.id}/leaderboards/${scope}`;
    if (scope === "weekly") path += `?weekStart=${encodeURIComponent(weekStart)}`;
    if (scope === "monthly") path += `?month=${encodeURIComponent(month)}`;
    if (scope === "season") { if (!seasonId) { setBoard(null); return; } path = `/leagues/${league.id}/seasons/${seasonId}/leaderboard`; }
    try { setBoard((await api(path)).leaderboard); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [league.id, scope, weekStart, month, seasonId]);
  return <section><div className="section-heading"><h2 className="section-title">Leaderboard</h2><div className="segmented">{["lifetime", "weekly", "monthly", "season"].map((s) => <button key={s} className={scope === s ? "active" : ""} onClick={() => setScope(s)}>{s}</button>)}</div></div>{scope === "weekly" && <input className="period-input" type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />}{scope === "monthly" && <input className="period-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}{scope === "season" && !seasonId && <div className="card muted">Create or select a season to view its snapshot board.</div>}<ErrorLine message={error} />{board && <div className="list leaderboard-list">{board.entries.map((entry) => <div className="card row" key={entry.user_id}><span className="rank">#{entry.rank}</span><div className="grow"><b>{entry.username}</b></div><span className={entry.points ? "pts" : "pts zero"}>{entry.points.toLocaleString()}</span></div>)}</div>}</section>;
}

function SeasonPanel({ league, seasons, selectedSeason, onSeasonChange, onReload }) {
  const [form, setForm] = useState(DEFAULT_SEASON);
  const [error, setError] = useState("");
  const canManage = roleCanManage(league.role) && !league.archived_at;
  const toast = useToast();
  async function createSeason(e) {
    e.preventDefault(); setError("");
    try { const { season } = await api(`/leagues/${league.id}/seasons`, { method: "POST", body: form }); toast({ label: "Season created", name: season.name }); setForm(DEFAULT_SEASON); await onReload(season.id); }
    catch (err) { setError(err.message); }
  }
  async function action(name) {
    setError("");
    try { const { season } = await api(`/leagues/${league.id}/seasons/${selectedSeason.id}/${name}`, { method: "POST", body: {} }); toast({ label: `Season ${name}`, name: season.name }); await onReload(season.id); }
    catch (err) { setError(err.message); }
  }
  return <section><div className="section-heading"><h2 className="section-title">Seasons</h2>{seasons.length > 0 && <select value={selectedSeason?.id || ""} onChange={(e) => onSeasonChange(Number(e.target.value))}>{seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</div><ErrorLine message={error} />{selectedSeason ? <div className="card season-card"><div className="grow"><b>{selectedSeason.name}</b><div className="muted">{selectedSeason.mode} · {formatDate(selectedSeason.starts_at)} – {formatDate(selectedSeason.ends_at)}</div></div><span className="status-pill enabled">{selectedSeason.state}</span>{canManage && <div className="season-actions">{!selectedSeason.participants_locked_at && <button className="btn small" onClick={() => action("materialize")}>Lock participants</button>}{!selectedSeason.finalized_at && !selectedSeason.cancelled_at && <button className="btn ghost small" onClick={() => action("finalize")}>Finalize</button>}{!selectedSeason.participants_locked_at && <button className="btn ghost small" onClick={() => action("cancel")}>Cancel</button>}</div>}</div> : <div className="card muted">No seasons yet.</div>}{canManage && <form className="card league-form compact" onSubmit={createSeason}><h3>Schedule season</h3><input required placeholder="Season name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="challenge">Challenge</option><option value="casual">Casual</option><option value="verified">Verified</option></select><input required placeholder="Rule version" value={form.rule_version} onChange={(e) => setForm({ ...form, rule_version: e.target.value })} /><input required type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /><input required type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /><button className="btn small">Create season</button></form>}</section>;
}

function ChallengePanel({ league, selectedSeason, onReload }) {
  const [definitions, setDefinitions] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [definition, setDefinition] = useState(DEFAULT_CHALLENGE);
  const [assign, setAssign] = useState({ challenge_definition_id: "", user_id: "" });
  const [evidence, setEvidence] = useState({});
  const [error, setError] = useState("");
  const canManage = roleCanManage(league.role) && !league.archived_at;
  const canAssign = canManage && selectedSeason?.mode === "challenge" && selectedSeason?.participants_locked_at && !selectedSeason?.finalized_at && !selectedSeason?.cancelled_at;
  const toast = useToast();
  const seasonMembers = useMemo(() => selectedSeason?.participants || league.members || [], [selectedSeason, league.members]);
  async function load() {
    if (!selectedSeason) return; setError("");
    try { const [defs, dash] = await Promise.all([api(`/leagues/${league.id}/challenges`), api(`/leagues/${league.id}/seasons/${selectedSeason.id}/challenge-dashboard`)]); setDefinitions(defs.challenges || []); setDashboard(dash.dashboard); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [league.id, selectedSeason?.id]);
  async function createDefinition(e) {
    e.preventDefault(); setError("");
    try { const body = { ...definition, slug: safeSlug(definition.slug || definition.title), points: Number(definition.points), description: definition.description || null }; const { challenge } = await api(`/leagues/${league.id}/challenges`, { method: "POST", body }); toast({ label: "Challenge defined", name: challenge.title, points: challenge.points }); setDefinition(DEFAULT_CHALLENGE); await load(); }
    catch (err) { setError(err.message); }
  }
  async function assignChallenge(e) {
    e.preventDefault(); setError("");
    try { const body = { challenge_definition_id: Number(assign.challenge_definition_id), user_id: Number(assign.user_id) }; const { assignment } = await api(`/leagues/${league.id}/seasons/${selectedSeason.id}/challenges/assign`, { method: "POST", body }); toast({ label: "Challenge assigned", name: `${assignment.title} → ${assignment.username}` }); await load(); await onReload(selectedSeason.id); }
    catch (err) { setError(err.message); }
  }
  async function complete(assignment) {
    setError("");
    try { const body = { evidence_note: evidence[assignment.id] || "" }; const { assignment: updated } = await api(`/leagues/${league.id}/seasons/${selectedSeason.id}/challenge-assignments/${assignment.id}/complete`, { method: "POST", body }); toast({ label: "Challenge completed", name: `${updated.username} · ${updated.title}`, points: updated.points }); await load(); }
    catch (err) { setError(err.message); }
  }
  if (!selectedSeason) return <section><h2 className="section-title">Challenges</h2><div className="card muted">Pick a season first.</div></section>;
  return <section><div className="section-heading"><h2 className="section-title">Challenge dashboard</h2>{dashboard && <div className="muted">{dashboard.totals.completed}/{dashboard.totals.assigned} completed</div>}</div><ErrorLine message={error} /><div className="challenge-summary"><div className="stat"><div className="num">{dashboard?.totals.assigned ?? 0}</div><div className="lbl">assigned</div></div><div className="stat"><div className="num flame">{dashboard?.totals.completed ?? 0}</div><div className="lbl">complete</div></div><div className="stat"><div className="num">{dashboard?.totals.pending ?? 0}</div><div className="lbl">pending</div></div></div>{canManage && <form className="card league-form compact" onSubmit={createDefinition}><h3>Define challenge</h3><input required placeholder="Title" value={definition.title} onChange={(e) => setDefinition({ ...definition, title: e.target.value, slug: definition.slug || safeSlug(e.target.value) })} /><input placeholder="slug" value={definition.slug} onChange={(e) => setDefinition({ ...definition, slug: e.target.value })} /><input placeholder="Description" value={definition.description} onChange={(e) => setDefinition({ ...definition, description: e.target.value })} /><input required type="number" min="1" max="10000" value={definition.points} onChange={(e) => setDefinition({ ...definition, points: e.target.value })} /><input required placeholder="Rule version" value={definition.rule_version} onChange={(e) => setDefinition({ ...definition, rule_version: e.target.value })} /><button className="btn small">Save definition</button></form>}{canAssign ? <form className="card league-form compact" onSubmit={assignChallenge}><h3>Assign challenge</h3><select required value={assign.challenge_definition_id} onChange={(e) => setAssign({ ...assign, challenge_definition_id: e.target.value })}><option value="">Challenge…</option>{definitions.map((d) => <option key={d.id} value={d.id}>{d.title} · {d.points} pts</option>)}</select><select required value={assign.user_id} onChange={(e) => setAssign({ ...assign, user_id: e.target.value })}><option value="">Participant…</option>{seasonMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.username}</option>)}</select><button className="btn small">Assign</button></form> : <div className="card muted">Assignments open only for manager-run challenge seasons after participants are locked.</div>}<div className="list challenge-list">{(dashboard?.assignments || []).map((a) => <div className="card challenge-card" key={a.id}><div className="row"><div className="grow"><b>{a.title}</b><div className="muted">{a.username} · {a.points} pts</div>{a.description && <div className="muted">{a.description}</div>}</div><span className={`status-pill ${a.status === "completed" ? "enabled" : ""}`}>{a.status}</span></div>{canAssign && a.status === "pending" && <div className="challenge-complete"><input placeholder="Evidence note" value={evidence[a.id] || ""} onChange={(e) => setEvidence({ ...evidence, [a.id]: e.target.value })} /><button className="btn small" onClick={() => complete(a)}>Mark complete</button></div>}</div>)}</div></section>;
}

function InviteCard({ league }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState("");
  async function createInvite() {
    setError("");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    try { setInvite((await api(`/leagues/${league.id}/invites`, { method: "POST", body: { expires_at: expires, max_uses: 10 } })).invite); }
    catch (err) { setError(err.message); }
  }
  return <div className="card row invite-card"><div className="grow"><b>Invite members</b><div className="muted">Bearer invite. Share only with people meant to join this league.</div>{invite && <code>{invite.invite_path}</code>}<ErrorLine message={error} /></div><button className="btn small" onClick={createInvite}>Create invite</button></div>;
}

function LeagueDetail({ id }) {
  const [league, setLeague] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const user = getUser();
  async function load(preferredSeasonId = selectedId) {
    setError("");
    try { const [leagueRes, seasonsRes] = await Promise.all([api(`/leagues/${id}`), api(`/leagues/${id}/seasons`)]); setLeague(leagueRes.league); setSeasons(seasonsRes.seasons || []); const next = preferredSeasonId && seasonsRes.seasons?.some((s) => s.id === preferredSeasonId) ? preferredSeasonId : seasonsRes.seasons?.[0]?.id; setSelectedId(next || null); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [id]);
  const selectedSeason = seasons.find((s) => s.id === selectedId) || null;
  if (error && !league) return <main className="leagues-page"><ErrorLine message={error} /><Link className="btn ghost" to="/leagues">Back to leagues</Link></main>;
  if (!league) return <p className="muted">Loading league…</p>;
  const canManage = roleCanManage(league.role);
  return <main className="leagues-page"><Link className="inline-link" to="/leagues">← All leagues</Link><div className="league-hero card"><div><p className="eyebrow">{league.role} league</p><h1>{league.name}</h1><p className="muted">{league.timezone} · default {league.default_mode} · signed in as {user?.username}</p></div><span className="league-count">{league.members.length}</span></div><ErrorLine message={error} /><div className="member-strip">{league.members.map((m) => <span className="chip" key={m.user_id}>{m.username}<small>{m.role}</small></span>)}</div>{canManage && <InviteCard league={league} />}<Leaderboard league={league} selectedSeason={selectedSeason} /><SeasonPanel league={league} seasons={seasons} selectedSeason={selectedSeason} onSeasonChange={setSelectedId} onReload={load} /><ChallengePanel league={league} selectedSeason={selectedSeason} onReload={load} /></main>;
}

export default function Leagues() {
  const [, params] = useRoute("/leagues/:id");
  return params?.id ? <LeagueDetail id={params.id} /> : <LeagueList />;
}
