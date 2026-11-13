/**
 * Canvas LMS institution URL, e.g. `https://canvas.example.edu/`. Normalized to an origin.
 * HTTPS is required: Canvas redirects HTTP only after credentials were already sent in clear.
 * Loopback http:// is allowed solely for tests against a local mock server.
 */
export type ParsedBaseUrl = { ok: true; origin: string } | { ok: false; error: string };

export function parseCanvasBaseUrl(input: string): ParsedBaseUrl {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter your school's Canvas address, e.g. https://canvas.example.edu" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'Not a valid web address' };
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'Canvas must be reached over https://' };
  }
  if (url.username || url.password) return { ok: false, error: 'Do not put credentials in the address' };
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { ok: false, error: 'Use just the Canvas address, e.g. https://canvas.example.edu (no path)' };
  }
  return { ok: true, origin: url.origin };
}
