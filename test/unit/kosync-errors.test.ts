import { describe, expect, it } from "vitest";
import { registerKosyncRoutes } from "../../src/routes/kosync.js";
import { Router } from "../../src/router.js";
import type { Env } from "../../src/types.js";

/**
 * KOReader switches on the numeric `code` in an error body, not on the message,
 * so a body without one degrades to a generic failure in the reader's UI. The
 * codes and statuses here are the reference server's, and are checked against
 * it by pid1/kosync-conformance; these tests pin them locally so a regression
 * shows up without needing the external verifier.
 */

const env = { ALLOW_KOSYNC_REGISTER: "0" } as unknown as Env;

function router(): Router {
  const r = new Router();
  registerKosyncRoutes(r);
  return r;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`https://books.example.com${path}`);
  const request = new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const hit = router().match(method, url.pathname);
  if (!hit) throw new Error(`no route for ${method} ${path}`);
  const res = await hit.handler({ request, env, ctx: {} as ExecutionContext, url, params: hit.params });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("kosync error bodies", () => {
  it("gives an unauthenticated call 401 with code 2001", async () => {
    const res = await call("GET", "/users/auth");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(2001);
  });

  it("answers a closed registration with 402 and code 2005, as the reference does", async () => {
    const res = await call("POST", "/users/create", { username: "someone", password: "secret" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(2005);
  });
});
