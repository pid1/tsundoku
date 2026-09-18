import { fromHex, toHex } from "../util.js";

const encoder = new TextEncoder();
const keyCache = new Map<string, CryptoKey>();

async function hmacKey(pepper: string): Promise<CryptoKey> {
  const cached = keyCache.get(pepper);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache.set(pepper, key);
  return key;
}

export async function hmacHex(pepper: string, message: string): Promise<string> {
  const key = await hmacKey(pepper);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

/**
 * MD5 is a non-standard Cloudflare extension to SubtleCrypto. We need it only
 * because the kosync wire protocol is defined in terms of MD5 -- KOReader sends
 * `x-auth-key: md5(password)` and we do not get to choose otherwise. It is never
 * used as the sole protection for anything.
 */
export async function md5Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await (crypto.subtle.digest as (algorithm: string, data: BufferSource) => Promise<ArrayBuffer>)(
    "MD5",
    data,
  );
  return toHex(digest);
}

/**
 * Verifier for HTTP Basic on OPDS routes.
 *
 * This is a keyed hash under a pepper, not a slow KDF. Basic auth sends
 * credentials on every request and the Workers free plan caps CPU at 10ms per
 * invocation; a high-iteration KDF does not fit there. The pepper lives in
 * Workers Secrets rather than D1, so a database leak alone yields nothing
 * crackable. See PLAN.md section 5.
 */
export function opdsVerifier(pepper: string, username: string, password: string): Promise<string> {
  return hmacHex(pepper, `opds:${username.toLowerCase()}:${password}`);
}

/** Verifier for the kosync header scheme, keyed on md5(password) as sent. */
export function kosyncVerifier(pepper: string, username: string, md5key: string): Promise<string> {
  return hmacHex(pepper, `kosync:${username.toLowerCase()}:${md5key.toLowerCase()}`);
}

export async function verifiersFor(
  pepper: string,
  username: string,
  password: string,
): Promise<{ opds: string; kosync: string }> {
  const md5 = await md5Hex(password);
  const [opds, kosync] = await Promise.all([
    opdsVerifier(pepper, username, password),
    kosyncVerifier(pepper, username, md5),
  ]);
  return { opds, kosync };
}

interface SubtleWithTimingSafe {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = fromHex(a);
  const bb = fromHex(b);
  const subtle = crypto.subtle as unknown as SubtleWithTimingSafe;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ba, bb);
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/** Minimum typed-password length. Generated passwords are the default path. */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordComplaint(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters. Use the generated one.`;
  }
  if (password.length > 512) return "Password is implausibly long.";
  return null;
}
