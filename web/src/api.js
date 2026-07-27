let token = null;
let user = null;
try {
  // Migrate existing session from sessionStorage (pre-v0.1 installs).
  const migToken = window.sessionStorage?.getItem("rs_token");
  if (migToken) {
    window.localStorage?.setItem("rs_token", migToken);
    window.localStorage?.setItem("rs_user", window.sessionStorage?.getItem("rs_user") || "null");
    window.sessionStorage?.removeItem("rs_token");
    window.sessionStorage?.removeItem("rs_user");
  }
  token = window.localStorage?.getItem("rs_token") || null;
  user = JSON.parse(window.localStorage?.getItem("rs_user") || "null");
} catch { /* storage unavailable — stay in-memory */ }

export function getUser() { return user; }
export function isAuthed() { return !!token; }

export function setSession(t, u) {
  token = t; user = u;
  try {
    window.localStorage?.setItem("rs_token", t);
    window.localStorage?.setItem("rs_user", JSON.stringify(u));
  } catch {}
}

export function clearSession() {
  token = null; user = null;
  try {
    window.localStorage?.removeItem("rs_token");
    window.localStorage?.removeItem("rs_user");
  } catch {}
}

export async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/auth/login" && path !== "/auth/register") {
    clearSession();
    window.location.href = "/login";
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const posterUrl = (p, size = "w342") =>
  p ? `https://image.tmdb.org/t/p/${size}${p}` : null;
