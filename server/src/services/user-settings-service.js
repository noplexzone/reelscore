import { db } from "../db.js";
import { assertTimeZone, localDay } from "../time.js";
import {
  applyPreparedAchievementReconciliation,
  prepareStaticAchievementReconciliation,
} from "./achievement-service.js";

const PREPARED_SETTINGS = Symbol("prepared-user-settings-update");
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function positiveId(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError("userId must be a positive integer number.");
  }
  return value;
}

function badRequest(message) {
  return Object.assign(new TypeError(message), { status: 400 });
}

export async function prepareUserSettingsUpdate(userId, settings) {
  const uid = positiveId(userId);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw badRequest("Settings must be an object.");
  }
  const update = {};
  if (hasOwn(settings, "public_profile")) {
    if (typeof settings.public_profile !== "boolean") throw badRequest("public_profile must be a boolean.");
    update.publicProfile = settings.public_profile ? 1 : 0;
  }
  if (hasOwn(settings, "timezone")) {
    try { update.timezone = assertTimeZone(settings.timezone); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
  }
  const preparedAchievements = hasOwn(update, "timezone")
    ? prepareStaticAchievementReconciliation(uid)
    : null;
  return Object.freeze({ [PREPARED_SETTINGS]: true, userId: uid, update: Object.freeze(update), preparedAchievements });
}

export function applyPreparedUserSettingsUpdate(userId, prepared, options = {}) {
  const uid = positiveId(userId);
  if (!prepared || prepared[PREPARED_SETTINGS] !== true || prepared.userId !== uid) {
    throw new TypeError("A matching prepared user settings update is required.");
  }
  const preparedAchievements = hasOwn(options, "preparedAchievements")
    ? options.preparedAchievements
    : prepared.preparedAchievements;

  return db.transaction(() => {
    const user = db.prepare("SELECT id,public_profile,timezone FROM users WHERE id=?").get(uid);
    if (!user) throw Object.assign(new RangeError(`User ${uid} not found.`), { status: 404 });
    const { update } = prepared;
    if (hasOwn(update, "publicProfile")) {
      db.prepare("UPDATE users SET public_profile=? WHERE id=?").run(update.publicProfile, uid);
    }
    if (hasOwn(update, "timezone")) {
      db.prepare("UPDATE users SET timezone=? WHERE id=?").run(update.timezone, uid);
      const rows = db.prepare("SELECT id,watched_at_utc FROM watches WHERE user_id=? ORDER BY id").all(uid);
      const updateWatch = db.prepare("UPDATE watches SET watched_day_local=?,timezone_used=? WHERE id=? AND user_id=?");
      for (const row of rows) updateWatch.run(localDay(row.watched_at_utc, update.timezone), update.timezone, row.id, uid);
      applyPreparedAchievementReconciliation(uid, preparedAchievements);
    }
    const current = db.prepare("SELECT public_profile,timezone FROM users WHERE id=?").get(uid);
    return { public_profile: !!current.public_profile, timezone: current.timezone };
  }).immediate();
}

export async function updateUserSettings(userId, settings) {
  const prepared = await prepareUserSettingsUpdate(userId, settings);
  return applyPreparedUserSettingsUpdate(userId, prepared);
}
