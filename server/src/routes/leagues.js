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

export const leagues = Router();
export const publicLeagueInvites = Router();

const previewLimiter = rateLimit({
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
