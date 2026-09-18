import { toHex } from "../util.js";

/** Strong ETag over a body we are about to send. */
export async function strongEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${toHex(digest).slice(0, 32)}"`;
}

/**
 * Cheap ETag for a feed: derived from the inputs that can change it, so we never
 * serialize a feed only to discover the client already has it.
 */
export function feedEtag(parts: Array<string | number | null | undefined>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = parts.join("");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `"${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}"`;
}

export function ifNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(etag);
}

export function notModified(etag: string, cacheControl: string): Response {
  return new Response(null, {
    status: 304,
    headers: { etag, "cache-control": cacheControl },
  });
}
