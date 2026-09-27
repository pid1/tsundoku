import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { kosyncVerifier, md5Hex } from "../../src/auth/password.js";
import { Router } from "../../src/router.js";
import { registerKosyncRoutes } from "../../src/routes/kosync.js";
import { ulid } from "../../src/util.js";

/**
 * The resolution half of the optional identifier list, over a real D1 schema:
 * which record a push lands on, and what the alias table keeps afterwards.
 *
 * The case the weak flag exists for is two different works a library has tagged
 * alike. They share one identifier and nothing else, and it is the identifier
 * that can name a different book -- so it seeds the second reader with where the
 * first got to, and stops there. Everything else here is what that must not
 * disturb: a strong match still adopts, and the weak value keeps resolving on a
 * read.
 */

const USERNAME = "reader";
const KEY = await md5Hex("hunter2");

let userId: string;

const router = new Router();
registerKosyncRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`https://books.example.com${path}`);
  const request = new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-auth-user": USERNAME, "x-auth-key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const hit = router.match(method, url.pathname);
  if (!hit) throw new Error(`no route for ${method} ${path}`);
  const res = await hit.handler({ request, env, ctx: {} as ExecutionContext, url, params: hit.params });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const put = (document: string, identifiers: unknown[], progress: string, percentage: number) =>
  call("PUT", "/syncs/progress", {
    document,
    identifiers,
    progress,
    percentage,
    device: "kpw",
    device_id: "kpw-1",
  });

const get = (document: string, ids: string) =>
  call("GET", `/syncs/progress/${document}?ids=${encodeURIComponent(ids)}`);

const strong = (type: string, value: string) => ({ type, value });
const weak = (type: string, value: string) => ({ type, value, weak: true });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
  userId = ulid();
  await env.DB.prepare(
    `INSERT INTO users (id, username, role, opds_verifier, kosync_verifier, created_at, password_set_at)
     VALUES (?, ?, 'reader', '', ?, 0, 0)`,
  )
    .bind(userId, USERNAME, await kosyncVerifier(env.PEPPER, USERNAME, KEY))
    .run();
});

const aliasesOf = async () => {
  const { results } = await env.DB.prepare(
    "SELECT alias, document FROM document_aliases WHERE user_id = ? ORDER BY alias",
  )
    .bind(userId)
    .all<{ alias: string; document: string }>();
  return Object.fromEntries((results ?? []).map((r) => [r.alias, r.document]));
};

describe("a push that resolves only through a weak identifier", () => {
  // Two books, one shared tag. b1 is pushed first and is the one at risk.
  const b1 = "b1content";
  const b2 = "b2content";
  const tag = "sharedtag";

  it("leaves the record it matched alone and writes under its own document", async () => {
    const first = await put(b1, [strong("content", b1), weak("metadata", tag)], "/body/DocFragment[20]/p[2]", 0.8);
    expect(first.body).toMatchObject({ document: b1, match: "content" });

    const second = await put(b2, [strong("content", b2), weak("metadata", tag)], "/body/p[1]", 0.01);
    expect(second.status).toBe(200);
    // Its own digest, and the type of the entry that names it: a non-adopting
    // write answers exactly as a create does.
    expect(second.body).toMatchObject({ document: b2, match: "content" });

    const original = await get(b1, `content:${b1}`);
    expect(original.body).toMatchObject({ document: b1, progress: "/body/DocFragment[20]/p[2]", percentage: 0.8 });

    const own = await get(b2, `content:${b2}`);
    expect(own.body).toMatchObject({ document: b2, progress: "/body/p[1]", percentage: 0.01 });
  });

  it("keeps the weak value pointed where it first resolved, and indexes the rest", async () => {
    // The tag still seeds: a third copy reading under it is shown b1's
    // position, which is the whole reason a weak identifier is offered.
    expect(await aliasesOf()).toEqual({ [tag]: b1 });

    const seeded = await get(b2, `content:${b2},metadata:${tag}`);
    expect(seeded.body).toMatchObject({ document: b2, match: "content" });
  });

  it("registers every identifier it offered, because the record is its own", async () => {
    const b3 = "b3content";
    const b3spine = "b3structure";
    await put(b3, [strong("content", b3), strong("structure", b3spine), weak("metadata", tag)], "/body/p[9]", 0.3);

    expect(await aliasesOf()).toMatchObject({ [b3spine]: b3, [tag]: b1 });

    // A recompressed copy of b3 shares the spine and finds it, which is what
    // registering from a non-adopting write buys.
    const repack = await get("b3repack", `content:b3repack,structure:${b3spine}`);
    expect(repack.body).toMatchObject({ document: b3, match: "structure", progress: "/body/p[9]" });
  });
});

describe("a push that resolves through a strong identifier", () => {
  it("adopts the record, weak entries in the list notwithstanding", async () => {
    const source = "s1content";
    const spine = "s1structure";
    await put(source, [strong("content", source), strong("structure", spine), weak("metadata", "s1meta")], "/body/p[4]", 0.4);

    const repack = "s2content";
    const adopted = await put(
      repack,
      [strong("content", repack), strong("structure", spine), weak("metadata", "s1meta")],
      "/body/p[7]",
      0.55,
    );
    expect(adopted.body).toMatchObject({ document: source, match: "structure" });

    const read = await get(source, `content:${source}`);
    expect(read.body).toMatchObject({ progress: "/body/p[7]", percentage: 0.55 });
  });
});

describe("the weak flag itself", () => {
  it("is accepted on a create, and false means strong", async () => {
    const created = await put("f1content", [{ type: "content", value: "f1content", weak: false }], "/body/p[1]", 0.1);
    expect(created.body).toMatchObject({ document: "f1content", match: "content" });
  });

  it("is rejected when it is not a boolean", async () => {
    const bad = await put("f2content", [{ type: "content", value: "f2content", weak: "yes" }], "/body/p[1]", 0.1);
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe(2003);
  });

  it("has no place in the read's grammar", async () => {
    const read = await get("f1content", "content:f1content,metadata:f1meta:true");
    expect(read.status).toBe(403);
    expect(read.body.code).toBe(2003);
  });
});
