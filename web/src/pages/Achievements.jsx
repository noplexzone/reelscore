import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../api.js";

const VOLUME = [
  { n: 1, points: 25, name: "Opening Night", desc: "Log your first film" },
  { n: 10, points: 50, name: "Regular", desc: "Log 10 films" },
  { n: 50, points: 150, name: "Cinephile", desc: "Log 50 films" },
  { n: 100, points: 300, name: "Projectionist", desc: "Log 100 films" },
  { n: 250, points: 750, name: "The Archive", desc: "Log 250 films" },
];
const DECADES = [
  { n: 5, points: 150, name: "Time Traveler", desc: "Films from 5 decades" },
  { n: 8, points: 350, name: "Century Pass", desc: "Films from 8 decades" },
  { n: 11, points: 700, name: "Full Reel of History", desc: "Films from 11 decades" },
];
const STREAKS = [
  { n: 3, points: 50, name: "Triple Feature", desc: "3-day watch streak" },
  { n: 7, points: 150, name: "Weeklong Premiere", desc: "7-day watch streak" },
  { n: 30, points: 600, name: "Resident Critic", desc: "30-day watch streak" },
];
const STARTER_CANON_KEY = "curated-list:starter-canon:v1";
const STARTER_CANON_HREF = "/lists/starter-canon";

function Stub({ name, desc, points, locked, progressText, href }) {
  const content = (
    <>
      <div className="body grow">
        <div className="name">{name}</div>
        <div className="desc">{desc}{locked && progressText ? ` — ${progressText}` : ""}</div>
      </div>
      <span className="tear top" aria-hidden="true" /><span className="tear bottom" aria-hidden="true" />
      <div className="stub-points">
        <span>{locked ? points : `+${points}`}</span>
        <small>PTS</small>
      </div>
    </>
  );
  return href ? <Link to={href} className={"stub stub-link" + (locked ? " locked" : "")}>{content}</Link> : <div className={"stub" + (locked ? " locked" : "")}>{content}</div>;
}

export default function Achievements() {
  const [data, setData] = useState(null);
  useEffect(() => { api("/achievements").then(setData).catch(() => {}); }, []);
  if (!data) return <p className="muted">Loading…</p>;
  return <AchievementsView data={data} />;
}

export function AchievementsView({ data }) {
  const unlockedKeys = new Set(data.unlocked.map((a) => a.key));
  const progress = data.progress;
  const starterCanonProgress = (progress.curated_lists || []).find((list) => list.slug === "starter-canon" && list.version === "v1");

  const lockedTiers = [
    ...VOLUME.filter((t) => !unlockedKeys.has(`volume:${t.n}`)).map((t) => ({
      ...t, progressText: `${progress.volume}/${t.n} films`,
    })),
    ...DECADES.filter((t) => !unlockedKeys.has(`decades:${t.n}`)).map((t) => ({
      ...t, progressText: `${progress.decades}/${t.n} decades`,
    })),
    ...STREAKS.filter((t) => !unlockedKeys.has(`streak:${t.n}`)).map((t) => ({
      ...t, progressText: `current streak ${progress.streak}`,
    })),
    ...(!unlockedKeys.has(STARTER_CANON_KEY) && starterCanonProgress ? [{
      key: STARTER_CANON_KEY,
      name: "ReelScore Starter Canon",
      desc: "Watch all 25 films in the ReelScore Starter Canon",
      points: 875,
      href: STARTER_CANON_HREF,
      progressText: `${starterCanonProgress.count}/${starterCanonProgress.total} watched`,
    }] : []),
  ];

  return (
    <>
      <h2 className="section-title">Unlocked ({data.unlocked.length})</h2>
      {data.unlocked.length === 0 ? (
        <div className="card muted">
          No trophies yet — your first logged film unlocks Opening Night.
        </div>
      ) : (
        <div className="stub-list">
          {data.unlocked.map((a) => (
            <Stub key={a.key} name={a.name} desc={a.description} points={a.points} href={a.key === STARTER_CANON_KEY ? STARTER_CANON_HREF : undefined} />
          ))}
        </div>
      )}

      <h2 className="section-title">Up next</h2>
      <div className="stub-list">
        {lockedTiers.map((t) => (
          <Stub
            key={t.key || t.name}
            name={t.name}
            desc={t.desc}
            points={t.points}
            locked
            progressText={t.progressText}
            href={t.href}
          />
        ))}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Genre trophies (10 / 25 / 50 films per genre), series completions, and
        filmography trophies for marquee actors and directors (see the Actors
        tab) unlock automatically as you log — they’ll appear here the moment
        you earn them.
      </p>
    </>
  );
}
