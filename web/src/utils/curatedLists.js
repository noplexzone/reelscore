export function safeProgressPercent(watched, total) {
  if (!Number.isFinite(watched) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (watched / total) * 100)));
}

export function hasValidProgress(watched, total) {
  return Number.isInteger(watched) && watched >= 0 && Number.isInteger(total) && total > 0;
}
