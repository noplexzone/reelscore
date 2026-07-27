import React, { useState } from "react";
import { api } from "../api.js";
import { useToast } from "../App.jsx";

// One-tap "log this watch" button for poster cards. Sits inside a Link, so it
// must stop the click from navigating.
export default function QuickLog({ tmdbId, title, onLogged }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const toast = useToast();

  async function log(e) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const res = await api("/watches", { method: "POST", body: { tmdb_id: tmdbId } });
      const w = res.watch;
      toast({
        label: w.isRewatch ? "Rewatch logged" : "Watch logged",
        name: w.title,
        points: w.points,
        desc:
          w.reason === "rewatch_cooldown"
            ? "Rewatched too soon — no points this time."
            : w.isRewatch
            ? "Rewatches pay 25%."
            : null,
      });
      for (const a of res.new_achievements) {
        toast({ label: "Achievement unlocked", name: a.name, desc: a.description, points: a.points });
      }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      onLogged?.(res);
    } catch (err) {
      toast({ label: "Couldn't log watch", name: title || "This film", desc: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={"quick-log" + (done ? " done" : "")}
      onClick={log}
      disabled={busy}
      title={done ? "Logged!" : `Log ${title || "this film"} as watched`}
      aria-label={`Log ${title || "this film"} as watched`}
    >
      {done ? "✓" : "+"}
    </button>
  );
}
