import { describe, expect, it } from "vitest";
import {
  kosyncVerifier,
  md5Hex,
  opdsVerifier,
  passwordComplaint,
  safeEqualHex,
  verifiersFor,
} from "../../src/auth/password.js";
import { clearSessionCookie, mintSession, readSession, sessionCookie } from "../../src/auth/session.js";
import { Router } from "../../src/router.js";
import type { Env } from "../../src/types.js";

const env = { PEPPER: "test-pepper", SESSION_KEY: "test-session-key" } as unknown as Env;

function requestWithCookie(value: string): Request {
  return new Request("https://books.example.com/library.html", { headers: { cookie: value } });
}

describe("credential verifiers", () => {
  it("are deterministic and 256 bits wide", async () => {
    const a = await opdsVerifier("pepper", "alice", "correct horse");
    const b = await opdsVerifier("pepper", "alice", "correct horse");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("change with the pepper, so a database leak alone is not enough", async () => {
    const a = await opdsVerifier("pepper-one", "alice", "secret");
    const b = await opdsVerifier("pepper-two", "alice", "secret");
    expect(a).not.toBe(b);
  });

  it("are bound to the username, so two users sharing a password differ", async () => {
    const a = await opdsVerifier("pepper", "alice", "secret");
    const b = await opdsVerifier("pepper", "bob", "secret");
    expect(a).not.toBe(b);
  });

  it("treat the username case-insensitively, matching the COLLATE NOCASE column", async () => {
    expect(await opdsVerifier("pepper", "Alice", "secret")).toBe(await opdsVerifier("pepper", "alice", "secret"));
  });

  it("separate the OPDS and kosync scopes for the same password", async () => {
    const password = "secret";
    const { opds, kosync } = await verifiersFor("pepper", "alice", password);
    expect(opds).not.toBe(kosync);
    // kosync is keyed on md5(password) because that is what the client sends.
    expect(kosync).toBe(await kosyncVerifier("pepper", "alice", await md5Hex(password)));
  });

  it("accepts the md5 key in either case, as clients vary", async () => {
    const upper = (await md5Hex("secret")).toUpperCase();
    expect(await kosyncVerifier("p", "alice", upper)).toBe(await kosyncVerifier("p", "alice", upper.toLowerCase()));
  });
});

describe("safeEqualHex", () => {
  it("compares equal and unequal digests", () => {
    expect(safeEqualHex("00ff", "00ff")).toBe(true);
    expect(safeEqualHex("00ff", "00fe")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(safeEqualHex("00ff", "00ffaa")).toBe(false);
    expect(safeEqualHex("", "")).toBe(true);
  });
});

describe("passwordComplaint", () => {
  it("rejects short passwords and accepts a generated one", () => {
    expect(passwordComplaint("short")).toMatch(/at least 12/);
    expect(passwordComplaint("abcd-efgh-ijkl-mnop")).toBeNull();
    expect(passwordComplaint("x".repeat(600))).toMatch(/implausibly long/);
  });
});

describe("session cookies", () => {
  const principal = { userId: "u1", username: "alice", role: "reader" as const };

  it("round-trips a signed session", async () => {
    const token = await mintSession(env, principal);
    const session = await readSession(env, requestWithCookie(`tsundoku_session=${token}`));
    expect(session).toEqual(principal);
  });

  it("rejects a tampered payload", async () => {
    const token = await mintSession(env, principal);
    const [version, payload, signature] = token.split(".");
    const forged = `${version}.${payload.slice(0, -2)}XX.${signature}`;
    expect(await readSession(env, requestWithCookie(`tsundoku_session=${forged}`))).toBeNull();
  });

  it("rejects a session signed with a different key", async () => {
    const token = await mintSession({ ...env, SESSION_KEY: "other-key" } as Env, principal);
    expect(await readSession(env, requestWithCookie(`tsundoku_session=${token}`))).toBeNull();
  });

  it("rejects an expired session", async () => {
    // Forge a payload with a past expiry and sign it correctly: expiry must be
    // enforced on read, not merely by the cookie's Max-Age.
    const body = btoa(JSON.stringify({ uid: "u1", usr: "alice", rol: "reader", exp: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const { hmacHex } = await import("../../src/auth/password.js");
    const token = `v1.${body}.${await hmacHex(env.SESSION_KEY, body)}`;
    expect(await readSession(env, requestWithCookie(`tsundoku_session=${token}`))).toBeNull();
  });

  it("ignores an absent or unrelated cookie", async () => {
    expect(await readSession(env, new Request("https://x.example.com/"))).toBeNull();
    expect(await readSession(env, requestWithCookie("other=1"))).toBeNull();
  });

  it("finds its cookie among several", async () => {
    const token = await mintSession(env, principal);
    const session = await readSession(env, requestWithCookie(`a=1; tsundoku_session=${token}; b=2`));
    expect(session?.username).toBe("alice");
  });

  it("sets the flags that keep a session out of JavaScript and off plain HTTP", () => {
    const cookie = sessionCookie("token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

describe("router", () => {
  const router = new Router();
  router.get("/opds/1.2/authors/:id", () => new Response("author"));
  router.get("/opds/1.2/authors", () => new Response("authors"));
  router.put("/syncs/progress", () => new Response("put"));
  router.get("/content/:id/:filename", () => new Response("content"));

  it("prefers an exact segment over a parameter at the same depth", () => {
    expect(router.match("GET", "/opds/1.2/authors")).not.toBeNull();
    expect(router.match("GET", "/opds/1.2/authors/a1")?.params).toEqual({ id: "a1" });
  });

  it("decodes percent-encoded parameters", () => {
    expect(router.match("GET", "/content/b1/left%20hand.epub")?.params.filename).toBe("left hand.epub");
  });

  it("routes HEAD through the GET handler", () => {
    expect(router.match("HEAD", "/opds/1.2/authors")).not.toBeNull();
  });

  it("does not match a different method or a longer path", () => {
    expect(router.match("POST", "/syncs/progress")).toBeNull();
    expect(router.match("PUT", "/syncs/progress")).not.toBeNull();
    expect(router.match("GET", "/opds/1.2/authors/a1/extra")).toBeNull();
    expect(router.match("GET", "/nothing/here")).toBeNull();
  });

  it("ignores trailing slashes", () => {
    expect(router.match("GET", "/opds/1.2/authors/")).not.toBeNull();
  });
});
