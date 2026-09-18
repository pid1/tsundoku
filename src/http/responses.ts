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
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return res;
}
