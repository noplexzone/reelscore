import { createServer } from "http";

/** Start a test Express app on a random port. Returns { port, base, close }. */
export async function startTestServer() {
  const { createApp } = await import("../../src/index.js");
  const app = createApp();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Parse Set-Cookie headers from a fetch Response. */
export function parseCookies(response) {
  const out = {};
  const raw = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  for (const c of raw) {
    const [kv] = c.split(";");
    const eq = kv.indexOf("=");
    if (eq < 0) continue;
    const k = kv.slice(0, eq).trim();
    const v = kv.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

/** Inspect a single cookie header string for flags. */
export function cookieHas(setCookieStr, flag) {
  return setCookieStr.toLowerCase().includes(flag.toLowerCase());
}

/** Return raw Set-Cookie strings for a response. */
export function rawSetCookies(response) {
  if (response.headers.getSetCookie) return response.headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}
