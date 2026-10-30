import type { RouteContext } from "../router.js";
import { Router } from "../router.js";
import type { BookView, Page } from "../types.js";
import type { Principal } from "../auth/index.js";
import { authenticateBasic } from "../auth/index.js";
import { readSession } from "../auth/session.js";
import { CT, json, notFound, problem, redirect, tooMany } from "../http/responses.js";
import { authDocument, unauthorized } from "../opds/authdoc.js";
import { acquisitionFeedJson, navigationFeedJson, publicationJson } from "../opds/json.js";
import type { FeedContext } from "../opds/json.js";
import {
  getAuthorName,
  getBook,
  getTagName,
  listAuthors,
  listBooks,
  listBooksByAuthor,
  listBooksBySeries,
  listBooksByTag,
  listSeries,
  listTags,
  searchBooks,
} from "../db/queries.js";
import type { SortKey } from "../db/queries.js";
import { clampInt } from "../util.js";

const FEED_CACHE = "private, max-age=60";

function feedContext(c: RouteContext): FeedContext {
  return { origin: c.url.origin, catalogTitle: c.env.CATALOG_TITLE };
}

/**
 * Catalog routes accept HTTP Basic (what readers send) or the UI's session
 * cookie (so the browser can hit the same feeds without a second credential).
 */
async function authenticate(c: RouteContext): Promise<Principal | Response> {
  const session = await readSession(c.env, c.request);
  if (session) return session;

  const result = await authenticateBasic(c.env, c.request);
  if (result.ok) return result.principal;
  if (result.reason === "rate-limited") return tooMany("Too many failed sign-ins. Wait five minutes.");
  return unauthorized(c.url.origin, c.env.CATALOG_TITLE);
}

function pageParam(c: RouteContext): number {
  return clampInt(c.url.searchParams.get("page"), 1, 10_000, 1);
}

function pageSize(c: RouteContext): number {
  return clampInt(c.env.PAGE_SIZE, 1, 200, 50);
}

function sortParam(c: RouteContext): SortKey {
  const raw = c.url.searchParams.get("sort");
  return raw === "title" || raw === "series" || raw === "author" ? raw : "added";
}

export function registerOpdsRoutes(router: Router): void {
  // The auth document must be reachable without authentication.
  router.get("/opds/auth", (c) =>
    json(authDocument(c.url.origin, c.env.CATALOG_TITLE), { headers: { "content-type": CT.opdsAuth } }),
  );

  // OPDS 2.0 is the only catalog. /opds is the short address to give a reader.
  router.get("/opds", (c) => redirect(`${c.url.origin}/opds/2.0`, 302));

  // OPDS 1.2 (Atom) was removed. A reader still pointed at it gets a reason
  // and the new address, not a bare 404 that looks like a broken server.
  router.get("/opds/1.2", (c) => problem(410, "OPDS 1.2 is no longer served. Use the OPDS 2.0 catalog.", { catalog: `${c.url.origin}/opds/2.0` }));
  router.get("/opds/1.2/*", (c) => problem(410, "OPDS 1.2 is no longer served. Use the OPDS 2.0 catalog.", { catalog: `${c.url.origin}/opds/2.0` }));

  /* ------------------------------ 2.0 -- JSON ---------------------------- */

  const jsonFeed = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": CT.opdsJson, "cache-control": FEED_CACHE },
    });

  router.get("/opds/2.0", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const ctx = feedContext(c);
    return jsonFeed(
      navigationFeedJson(ctx, {
        title: ctx.catalogTitle,
        selfHref: `${ctx.origin}/opds/2.0`,
        entries: [
          { title: "New additions", href: `${ctx.origin}/opds/2.0/new` },
          { title: "All books", href: `${ctx.origin}/opds/2.0/books` },
          { title: "Authors", href: `${ctx.origin}/opds/2.0/authors` },
          { title: "Series", href: `${ctx.origin}/opds/2.0/series` },
          { title: "Subjects", href: `${ctx.origin}/opds/2.0/tags` },
        ],
      }),
    );
  });

  const jsonAcquisition = (
    c: RouteContext,
    opts: { title: string; path: string; page: Page<BookView> },
  ): Response => {
    const ctx = feedContext(c);
    const params = new URLSearchParams(c.url.search);
    const pageHref = (page: number): string => {
      const p = new URLSearchParams(params);
      p.set("page", String(page));
      return `${ctx.origin}${opts.path}?${p.toString()}`;
    };
    return jsonFeed(
      acquisitionFeedJson(ctx, {
        title: opts.title,
        selfHref: pageHref(opts.page.page),
        page: opts.page,
        pageHref,
      }),
    );
  };

  router.get("/opds/2.0/new", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const page = await listBooks(c.env.DB, { page: pageParam(c), pageSize: pageSize(c), sort: "added" });
    return jsonAcquisition(c, { title: "New additions", path: "/opds/2.0/new", page });
  });

  router.get("/opds/2.0/books", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const page = await listBooks(c.env.DB, { page: pageParam(c), pageSize: pageSize(c), sort: sortParam(c) });
    return jsonAcquisition(c, { title: "All books", path: "/opds/2.0/books", page });
  });

  router.get("/opds/2.0/authors", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const authors = await listAuthors(c.env.DB);
    const ctx = feedContext(c);
    return jsonFeed(
      navigationFeedJson(ctx, {
        title: "Authors",
        selfHref: `${ctx.origin}/opds/2.0/authors`,
        entries: authors.map((a) => ({
          title: a.title,
          href: `${ctx.origin}/opds/2.0/authors/${encodeURIComponent(a.id)}`,
          count: a.count,
        })),
      }),
    );
  });

  router.get("/opds/2.0/authors/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const name = await getAuthorName(c.env.DB, c.params.id);
    if (!name) return notFound("No such author");
    const page = await listBooksByAuthor(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    return jsonAcquisition(c, { title: name, path: `/opds/2.0/authors/${encodeURIComponent(c.params.id)}`, page });
  });

  router.get("/opds/2.0/series", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const series = await listSeries(c.env.DB);
    const ctx = feedContext(c);
    return jsonFeed(
      navigationFeedJson(ctx, {
        title: "Series",
        selfHref: `${ctx.origin}/opds/2.0/series`,
        entries: series.map((s) => ({
          title: s.title,
          href: `${ctx.origin}/opds/2.0/series/${encodeURIComponent(s.id)}`,
          count: s.count,
        })),
      }),
    );
  });

  router.get("/opds/2.0/series/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const page = await listBooksBySeries(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    if (page.total === 0) return notFound("No such series");
    return jsonAcquisition(c, { title: c.params.id, path: `/opds/2.0/series/${encodeURIComponent(c.params.id)}`, page });
  });

  router.get("/opds/2.0/tags", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const tags = await listTags(c.env.DB);
    const ctx = feedContext(c);
    return jsonFeed(
      navigationFeedJson(ctx, {
        title: "Subjects",
        selfHref: `${ctx.origin}/opds/2.0/tags`,
        entries: tags.map((t) => ({
          title: t.title,
          href: `${ctx.origin}/opds/2.0/tags/${encodeURIComponent(t.id)}`,
          count: t.count,
        })),
      }),
    );
  });

  router.get("/opds/2.0/tags/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const name = await getTagName(c.env.DB, c.params.id);
    if (!name) return notFound("No such subject");
    const page = await listBooksByTag(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    return jsonAcquisition(c, { title: name, path: `/opds/2.0/tags/${encodeURIComponent(c.params.id)}`, page });
  });

  router.get("/opds/2.0/search", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const query = c.url.searchParams.get("query") ?? c.url.searchParams.get("q") ?? "";
    const page = await searchBooks(c.env.DB, query, { page: pageParam(c), pageSize: pageSize(c) });
    return jsonAcquisition(c, { title: query ? `Search: ${query}` : "Search", path: "/opds/2.0/search", page });
  });

  router.get("/opds/2.0/publication/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const book = await getBook(c.env.DB, c.params.id);
    if (!book) return notFound("No such book");
    return new Response(JSON.stringify(publicationJson(feedContext(c), book)), {
      headers: { "content-type": CT.opdsPublication, "cache-control": FEED_CACHE },
    });
  });
}

export { authenticate as authenticateCatalog };
