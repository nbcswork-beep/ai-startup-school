// The server rotates the refresh cookie on every refresh and treats a second use of the old one
// as theft, ending the whole session. So a page never refreshes twice at once: parallel 401s
// (a poll plus a click, several panels loading) share one refresh, and other tabs of this school
// wait for it through a Web Lock, then send the cookie it already rotated.
let pending = null;

async function post() {
  const response = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

/** One shared refresh: resolves to { ok, status, payload } with payload.accessToken when ok. */
export function refreshSession() {
  if (!pending) {
    const locks = globalThis.navigator?.locks;
    pending = (locks?.request ? locks.request('aiss-session-refresh', post) : post())
      .finally(() => { pending = null; });
  }
  return pending;
}
