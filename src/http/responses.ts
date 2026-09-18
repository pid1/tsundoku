export const CT = {
  opdsNav: "application/atom+xml;profile=opds-catalog;kind=navigation",
  opdsAcq: "application/atom+xml;profile=opds-catalog;kind=acquisition",
  opdsEntry: "application/atom+xml;type=entry;profile=opds-catalog",
  opdsJson: "application/opds+json",
  opdsPublication: "application/opds-publication+json",
  opdsAuth: "application/opds-authentication+json",
  openSearch: "application/opensearchdescription+xml",
  json: "application/json; charset=utf-8",
  kosync: "application/vnd.koreader.v1+json",
} as const;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": CT.json, ...(init.headers ?? {}) },
  });
}

/** kosync clients send `accept: application/vnd.koreader.v1+json`. Answer in kind. */
export function kosyncJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": CT.kosync },
  });
}

export function xml(body: string, contentType: string, init: ResponseInit = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    ...init,
    headers: { "content-type": `${contentType}; charset=utf-8`, ...(init.headers ?? {}) },
  });
}

/**
 * A redirect we own the headers of.
 *
 * `Response.redirect()` returns a response whose headers are immutable, and
 * every response leaving the router passes through `securityHeaders()`, which
 * writes to them. Build it by hand instead.
 */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function problem(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

export const notFound = (m = "Not found") => problem(404, m);
export const badRequest = (m = "Bad request") => problem(400, m);
export const forbidden = (m = "Forbidden") => problem(403, m);
export const tooLarge = (m = "Payload too large") => problem(413, m);
export const tooMany = (m = "Too many requests") => problem(429, m);

export function noStore(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * Headers applied to every response. HSTS is deliberate: auth is HTTP Basic, so
 * a downgrade to cleartext would hand over the credential itself.
 */
export function securityHeaders(res: Response): Response {
  // Some responses carry an immutable header guard -- `Response.redirect()` and
  // anything handed back untouched from `fetch()`. Writing to those throws, and
  // an exception here turns a good response into a 500. Copy into a response we
  // own instead. Use `redirect()` above rather than relying on this.
  let out = res;
  try {
    out.headers.set("x-content-type-options", "nosniff");
  } catch {
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    out.headers.set("x-content-type-options", "nosniff");
  }
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-frame-options", "DENY");
  out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return out;
}
