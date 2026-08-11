import { Router } from "express";
import rateLimit from "express-rate-limit";
import { parsePositiveInt } from "../validation.js";
import {
  createLeague,
  listLeagues,
  getLeague,
  createInvite,
  inspectInvite,
  acceptInvite,
  revokeInvite,
  leaveLeague,
  setMemberRole,
  transferOwnership,
  archiveLeague,
} from "../services/league-service.js";
import {
  createSeason,
  updateScheduledSeason,
  cancelScheduledSeason,
  materializeSeasonForActor,
  finalizeSeason,
  reconcileSeasonForManager,
  listSeasons,
  getSeason,
} from "../services/season-service.js";
import { listLeaderboard } from "../services/leaderboard-service.js";

export const leagues = Router();
export const publicLeagueInvites = Router();

const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
const reconcileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

function routeId(res, value, label) {
  const id = typeof value === "string" && /^[1-9]\d*$/.test(value) ? parsePositiveInt(value) : null;
  if (!id) res.status(400).json({ error: `Invalid ${label} ID.` });
  return id;
}
function handle(res, next, status, fn) {
  try { return res.status(status).json(fn()); }
  catch (error) { return next(error); }
}

publicLeagueInvites.post("/preview", previewLimiter, (req, res, next) =>
  handle(res, next, 200, () => ({ invite: inspectInvite(req.body?.token) }))
);

leagues.get("/", (req, res, next) =>
  handle(res, next, 200, () => ({ leagues: listLeagues(req.user.id) }))
);
leagues.post("/", (req, res, next) =>
  handle(res, next, 201, () => ({ league: createLeague(req.user.id, req.body) }))
);
leagues.post("/invites/accept", (req, res, next) =>
  handle(res, next, 200, () => ({ league: acceptInvite(req.user.id, req.body?.token) }))
);
leagues.post("/invites/:inviteId/revoke", (req, res, next) => {
  const inviteId = routeId(res, req.params.inviteId, "invite");
  if (!inviteId) return;
  return handle(res, next, 200, () => ({ invite: revokeInvite(req.user.id, inviteId) }));
});

function seasonRouteIds(req, res) {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return null;
  const seasonId = routeId(res, req.params.seasonId, "season");
  if (!seasonId) return null;
  return { leagueId, seasonId };
}
function requireSeasonInRoute(userId, leagueId, seasonId) {
  const season = getSeason(userId, seasonId);
  if (season.league_id !== leagueId) throw Object.assign(new RangeError("Season not found."), { status: 404 });
  return season;
}
function rejectLifecycleClockInput(body) {
  if (body === undefined) return;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw Object.assign(new TypeError("Season lifecycle actions do not accept request fields."), { status: 400 });
  }
}

leagues.get("/:leagueId/seasons", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ seasons: listSeasons(req.user.id, leagueId) }));
});
leagues.post("/:leagueId/seasons", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 201, () => ({ season: createSeason(req.user.id, leagueId, req.body) }));
});
leagues.get("/:leagueId/leaderboards/:scope", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ leaderboard: listLeaderboard(req.user.id, leagueId, { ...req.query, scope: req.params.scope }) }));
});
leagues.get("/:leagueId/seasons/:seasonId/leaderboard", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => ({ leaderboard: listLeaderboard(req.user.id, ids.leagueId, { ...req.query, scope: "season", seasonId: ids.seasonId }) }));
});

leagues.get("/:leagueId/seasons/:seasonId", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => ({ season: requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId) }));
});
leagues.patch("/:leagueId/seasons/:seasonId", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => {
    requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId);
    return { season: updateScheduledSeason(req.user.id, ids.seasonId, req.body) };
  });
});
leagues.post("/:leagueId/seasons/:seasonId/cancel", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => {
    requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId);
    rejectLifecycleClockInput(req.body);
    return { season: cancelScheduledSeason(req.user.id, ids.seasonId) };
  });
});
leagues.post("/:leagueId/seasons/:seasonId/materialize", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => {
    requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId);
    rejectLifecycleClockInput(req.body);
    return { season: materializeSeasonForActor(req.user.id, ids.seasonId) };
  });
});
leagues.post("/:leagueId/seasons/:seasonId/finalize", (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => {
    requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId);
    rejectLifecycleClockInput(req.body);
    return { season: finalizeSeason(req.user.id, ids.seasonId) };
  });
});

leagues.post("/:leagueId/seasons/:seasonId/reconcile", reconcileLimiter, (req, res, next) => {
  const ids = seasonRouteIds(req, res); if (!ids) return;
  return handle(res, next, 200, () => {
    requireSeasonInRoute(req.user.id, ids.leagueId, ids.seasonId);
    return { reconciliation: reconcileSeasonForManager(req.user.id, ids.leagueId, ids.seasonId, req.body, { ip: req.ip }) };
  });
});

leagues.get("/:leagueId", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ league: getLeague(req.user.id, leagueId) }));
});
leagues.post("/:leagueId/invites", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 201, () => ({ invite: createInvite(req.user.id, leagueId, req.body) }));
});
leagues.post("/:leagueId/leave", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ membership: leaveLeague(req.user.id, leagueId) }));
});
leagues.patch("/:leagueId/members/:userId/role", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  const userId = routeId(res, req.params.userId, "user");
  if (!userId) return;
  return handle(res, next, 200, () => ({ member: setMemberRole(req.user.id, leagueId, userId, req.body?.role) }));
});
leagues.post("/:leagueId/transfer", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ league: transferOwnership(req.user.id, leagueId, req.body?.new_owner_user_id) }));
});
leagues.post("/:leagueId/archive", (req, res, next) => {
  const leagueId = routeId(res, req.params.leagueId, "league");
  if (!leagueId) return;
  return handle(res, next, 200, () => ({ league: archiveLeague(req.user.id, leagueId) }));
});
