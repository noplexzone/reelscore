export function parsePositiveInt(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}
