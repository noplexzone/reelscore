import React, { useEffect, useState } from "react";
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

function Stub({ name, desc, points, locked, progressText }) {
  return (
    <div className={"stub" + (locked ? " locked" : "")}>
      <div className="body grow">
        <div className="name">{name}</div>
        <div className="desc">{desc}{locked && progressText ? ` — ${progressText}` : ""}</div>
      </div>
      <span className="tear top" /><span className="tear bottom" />
      <div className="stub-points">
        <span>{locked ? points : `+${points}`}</span>
        <small>PTS</small>
      </div>
    </div>
  );
}

export default function Achievements() {
  const [data, setData] = useState(null);
  useEffect(() => { api("/achievements").then(setData).catch(() => {}); }, []);
  if (!data) return <p className="muted">Loading…</p>;

  const unlockedKeys = new Set(data.unlocked.map((a) => a.key));
  const p = data.progress;

  const lockedTiers = [
    ...VOLUME.filter((t) => !unlockedKeys.has(`volume:${t.n}`)).map((t) => ({
      ...t, progressText: `${p.volume}/${t.n} films`,
    })),
    ...DECADES.filter((t) => !unlockedKeys.has(`decades:${t.n}`)).map((t) => ({
      ...t, progressText: `${p.decades}/${t.n} decades`,
    })),
    ...STREAKS.filter((t) => !unlockedKeys.has(`streak:${t.n}`)).map((t) => ({
      ...t, progressText: `current streak ${p.streak}`,
    })),
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
            <Stub key={a.key} name={a.name} desc={a.description} points={a.points} />
          ))}
        </div>
      )}

      <h2 className="section-title">Up next</h2>
      <div className="stub-list">
        {lockedTiers.map((t) => (
          <Stub
            key={t.name}
            name={t.name}
            desc={t.desc}
            points={t.points}
            locked
            progressText={t.progressText}
          />
        ))}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Genre trophies (10 / 25 / 50 films per genre) and series completions unlock
        automatically as you log — they'll appear here the moment you earn them.
      </p>
    </>
  );
}
