let user = null;
let csrfToken = null;

export function getUser() { return user; }
export function isAuthed() { return !!user; }

export function setSession(u, csrf) {
  user = u || null;
  csrfToken = csrf || null;
}

export function clearSession() {
  user = null;
  csrfToken = null;
}

export async function hydrateSession() {
  try {
    const data = await api("/auth/me", { suppressAuthRedirect: true });
    setSession(data.user, data.csrf_token);
    return data.user;
  } catch {
    clearSession();
    return null;
  }
}

export async function logout() {
  try {
    await api("/auth/logout", { method: "POST", suppressAuthRedirect: true });
  } finally {
    clearSession();
  }
}

export async function api(path, opts = {}) {
  const { suppressAuthRedirect = false, headers: extraHeaders = {}, ...fetchOpts } = opts;
  const method = (fetchOpts.method || "GET").toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = { ...extraHeaders };
  if (fetchOpts.body !== undefined && !(fetchOpts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (mutating && csrfToken && path !== "/auth/login" && path !== "/auth/register") {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const res = await fetch("/api" + path, {
    ...fetchOpts,
    method,
    credentials: "same-origin",
    headers,
    body: fetchOpts.body === undefined
      ? undefined
      : fetchOpts.body instanceof FormData
        ? fetchOpts.body
        : JSON.stringify(fetchOpts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !suppressAuthRedirect && path !== "/auth/login" && path !== "/auth/register") {
    clearSession();
    window.location.href = "/login";
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const posterUrl = (p, size = "w342") =>
  p ? `https://image.tmdb.org/t/p/${size}${p}` : null;
