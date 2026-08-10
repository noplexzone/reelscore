const formatterCache = new Map();
const LEGACY_SQLITE_UTC = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const EXPLICIT_ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i;

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function assertTimeZone(timeZone) {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Invalid IANA timezone: ${timeZone}`);
  return timeZone;
}

function hasValidCalendarFields(match) {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseInstant(value, { allowLegacy = false } = {}) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (Number.isNaN(copy.getTime())) throw new RangeError(`Invalid UTC instant: ${value}`);
    return copy;
  }
  if (typeof value !== "string") throw new RangeError(`Invalid UTC instant: ${value}`);

  const explicit = value.match(EXPLICIT_ISO_INSTANT);
  if (explicit && hasValidCalendarFields(explicit)) {
    const offset = explicit[8];
    if (offset !== "Z" && offset !== "z") {
      const [hours, minutes] = offset.slice(1).split(":").map(Number);
      if (hours > 23 || minutes > 59) throw new RangeError(`Invalid UTC instant: ${value}`);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (allowLegacy) {
    const legacy = value.match(LEGACY_SQLITE_UTC);
    if (legacy && hasValidCalendarFields(legacy)) {
      const fraction = legacy[7] ? `.${legacy[7].padEnd(3, "0")}` : "";
      return new Date(`${legacy[1]}-${legacy[2]}-${legacy[3]}T${legacy[4]}:${legacy[5]}:${legacy[6]}${fraction}Z`);
    }
  }
  throw new RangeError(`Invalid UTC instant: ${value}`);
}

export function localDay(utcInstant, timeZone) {
  assertTimeZone(timeZone);
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(parseInstant(utcInstant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function normalizeUtcInstant(value) {
  return parseInstant(value, { allowLegacy: true }).toISOString();
}
