import type { Env } from "../types.js";
import type { Principal } from "./index.js";
import { hmacHex, safeEqualHex } from "./password.js";

const COOKIE = "tsundoku_session";
const MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

interface Payload {
  uid: string;
  usr: string;
  rol: "admin" | "reader";
  exp: number;
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Stateless signed cookie: no session table, so logout everywhere is a
 * SESSION_KEY rotation rather than a delete. For a household that is the right
 * trade -- it keeps the hot path to zero database reads.
 */
export async function mintSession(env: Env, principal: Principal): Promise<string> {
  const payload: Payload = {
    uid: principal.userId,
    usr: principal.username,
    rol: principal.role,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(env.SESSION_KEY, body);
  return `v1.${body}.${sig}`;
}

export async function readSession(env: Env, request: Request): Promise<Principal | null> {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;

  const match = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;

  const token = match.slice(COOKIE.length + 1);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const expected = await hmacHex(env.SESSION_KEY, parts[1]);
  if (!safeEqualHex(expected, parts[2])) return null;

  try {
    const payload = JSON.parse(b64urlDecode(parts[1])) as Payload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: payload.uid, username: payload.usr, role: payload.rol };
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
