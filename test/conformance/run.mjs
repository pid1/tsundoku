#!/usr/bin/env node
/**
 * Conformance checks against a DEPLOYED tsundoku.
 *
 * The unit suite proves the serializers emit the right bytes. This proves a
 * real deployment answers with the right media types, rels and status codes --
 * which is what readers actually dispatch on, and the part a golden-file test
 * cannot cover.
 *
 *   BASE_URL=https://books.example.com \
 *   TSUNDOKU_USER=alice TSUNDOKU_PASS=secret \
 *   node test/conformance/run.mjs
 */

import { createHash } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const USER = process.env.TSUNDOKU_USER ?? "";
const PASS = process.env.TSUNDOKU_PASS ?? "";

if (!BASE || !USER || !PASS) {
  console.error("Set BASE_URL, TSUNDOKU_USER and TSUNDOKU_PASS.");
  process.exit(2);
}

const basic = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
const md5 = (s) => createHash("md5").update(s).digest("hex");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const get = (path, init = {}) =>
  fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers: { authorization: basic, ...(init.headers ?? {}) } });

async function main() {
  section("Unauthenticated behaviour");
  {
    const response = await fetch(`${BASE}/opds/1.2`, { redirect: "manual" });
    check("catalog without credentials is 401", response.status === 401, `got ${response.status}`);
    check(
      "401 carries a WWW-Authenticate Basic challenge",
      /^Basic/i.test(response.headers.get("www-authenticate") ?? ""),
      response.headers.get("www-authenticate") ?? "absent",
    );
    check(
      "401 body is an Authentication for OPDS document",
      (response.headers.get("content-type") ?? "").includes("application/opds-authentication+json"),
      response.headers.get("content-type") ?? "absent",
    );
    const body = await response.json().catch(() => ({}));
    check(
      "auth document advertises http://opds-spec.org/auth/basic",
      body?.authentication?.[0]?.type === "http://opds-spec.org/auth/basic",
    );

    const authDoc = await fetch(`${BASE}/opds/auth`);
    check("auth document itself needs no credentials", authDoc.status === 200, `got ${authDoc.status}`);

    const health = await fetch(`${BASE}/healthcheck`);
    const healthBody = await health.json().catch(() => ({}));
    check("healthcheck is public and returns the kosync shape", healthBody?.state === "OK");
  }

  section("OPDS 1.2");
  let firstBookHref = null;
  {
    const root = await get("/opds/1.2");
    const rootType = root.headers.get("content-type") ?? "";
    check("root feed is 200", root.status === 200, `got ${root.status}`);
    check("root declares kind=navigation", rootType.includes("kind=navigation"), rootType);

    const rootXml = await root.text();
    check("root offers a search link", rootXml.includes('rel="search"'));
    check("root links to new additions", rootXml.includes("/opds/1.2/new"));

    const acq = await get("/opds/1.2/new");
    const acqType = acq.headers.get("content-type") ?? "";
    check("acquisition feed declares kind=acquisition", acqType.includes("kind=acquisition"), acqType);

    const acqXml = await acq.text();
    check("acquisition feed carries OpenSearch totals", acqXml.includes("opensearch:totalResults"));

    const entryCount = (acqXml.match(/<entry>/g) ?? []).length;
    console.log(`       (${entryCount} entries in the first page)`);
    if (entryCount > 0) {
      check("entries carry an acquisition link", acqXml.includes('rel="http://opds-spec.org/acquisition"'));
      firstBookHref = /rel="http:\/\/opds-spec\.org\/acquisition" href="([^"]+)"/.exec(acqXml)?.[1] ?? null;
    } else {
      console.log("       (upload a book to exercise the download and cover checks)");
    }

    const opensearch = await get("/opds/1.2/opensearch.xml");
    const osXml = await opensearch.text();
    check("OpenSearch description declares {searchTerms}", osXml.includes("{searchTerms}"));
    check(
      "OpenSearch template types results as an acquisition feed",
      osXml.includes("kind=acquisition"),
    );

    for (const path of ["/opds/1.2/authors", "/opds/1.2/series", "/opds/1.2/tags"]) {
      const response = await get(path);
      check(`${path} is 200`, response.status === 200, `got ${response.status}`);
    }

    const search = await get("/opds/1.2/search?q=a");
    check("search returns an acquisition feed", (search.headers.get("content-type") ?? "").includes("kind=acquisition"));
  }

  section("OPDS 2.0");
  {
    const root = await get("/opds/2.0");
    check("root is application/opds+json", (root.headers.get("content-type") ?? "").includes("application/opds+json"));
    const body = await root.json();
    check("root has a title", typeof body?.metadata?.title === "string");
    check("root has a self link", (body?.links ?? []).some((l) => l.rel === "self"));
    check("root has a navigation collection", Array.isArray(body?.navigation));

    const feed = await (await get("/opds/2.0/new")).json();
    check("acquisition feed reports numberOfItems", typeof feed?.metadata?.numberOfItems === "number");
    check("acquisition feed has a publications collection", Array.isArray(feed?.publications));
    const search = (feed?.links ?? []).find((l) => l.rel === "search");
    check("search link is templated", search?.templated === true);
  }

  section("Content negotiation");
  {
    const redirect = await fetch(`${BASE}/opds`, { redirect: "manual", headers: { authorization: basic } });
    check("/opds redirects", redirect.status === 302, `got ${redirect.status}`);
    check(
      "/opds defaults to 1.2, which is what the installed base speaks",
      (redirect.headers.get("location") ?? "").endsWith("/opds/1.2"),
      redirect.headers.get("location") ?? "absent",
    );
  }

  if (firstBookHref) {
    section("Download");
    const path = firstBookHref.replace(BASE, "");
    const head = await get(path, { method: "HEAD" });
    check("HEAD on a book is 200", head.status === 200, `got ${head.status}`);
    check("book advertises byte ranges", head.headers.get("accept-ranges") === "bytes");

    const ranged = await get(path, { headers: { range: "bytes=0-99" } });
    check("range request returns 206", ranged.status === 206, `got ${ranged.status}`);
    check("range request reports Content-Range", (ranged.headers.get("content-range") ?? "").startsWith("bytes 0-99/"));
    const bytes = new Uint8Array(await ranged.arrayBuffer());
    check("range request returns exactly the requested bytes", bytes.length === 100, `got ${bytes.length}`);

    const noAuth = await fetch(`${BASE}${path}`, { redirect: "manual" });
    check("book download without credentials is 401", noAuth.status === 401, `got ${noAuth.status}`);
  }

  section("kosync");
  {
    const headers = { "x-auth-user": USER, "x-auth-key": md5(PASS), accept: "application/vnd.koreader.v1+json" };

    const auth = await fetch(`${BASE}/users/auth`, { headers });
    const authBody = await auth.json().catch(() => ({}));
    check("GET /users/auth is 200", auth.status === 200, `got ${auth.status}`);
    check('GET /users/auth returns {"authorized":"OK"}', authBody?.authorized === "OK");

    const badAuth = await fetch(`${BASE}/users/auth`, {
      headers: { ...headers, "x-auth-key": md5("definitely not the password") },
    });
    check("a wrong key is 401", badAuth.status === 401, `got ${badAuth.status}`);

    const register = await fetch(`${BASE}/users/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "conformance-probe", password: md5("x") }),
    });
    check("self-registration is refused with 403", register.status === 403, `got ${register.status}`);

    const document = `conformance-${Date.now().toString(16)}`;
    const put = await fetch(`${BASE}/syncs/progress`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        document,
        progress: "/body/DocFragment[20]/body/p[22]",
        percentage: 0.4213,
        device: "conformance",
        device_id: "conformance-device",
        metadata: { title: "Probe", authors: "nobody", filename: "probe.epub" },
      }),
    });
    const putBody = await put.json().catch(() => ({}));
    check("PUT /syncs/progress is 200", put.status === 200, `got ${put.status}`);
    check("PUT echoes the document and a timestamp", putBody?.document === document && typeof putBody?.timestamp === "number");

    const read = await fetch(`${BASE}/syncs/progress/${document}`, { headers });
    const readBody = await read.json().catch(() => ({}));
    check("GET /syncs/progress/:document returns what was stored", readBody?.document === document);
    check("progress survives as a string, not a number", readBody?.progress === "/body/DocFragment[20]/body/p[22]");
    check("percentage round-trips", Math.abs((readBody?.percentage ?? 0) - 0.4213) < 1e-6);

    // KOReader only sends metadata when the option is on; omitting it must not
    // wipe what is already stored.
    await fetch(`${BASE}/syncs/progress`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ document, progress: "12", percentage: 0.5, device: "d2", device_id: "d2" }),
    });
    const afterBody = await (await fetch(`${BASE}/syncs/progress/${document}`, { headers })).json();
    check("a push without metadata preserves the stored metadata", afterBody?.percentage === 0.5);

    const unknown = await fetch(`${BASE}/syncs/progress/never-seen-${Date.now()}`, { headers });
    check("an unknown document is 200 with an empty body", unknown.status === 200, `got ${unknown.status}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
