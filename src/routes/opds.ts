import type { RouteContext } from "../router.js";
import { Router } from "../router.js";
import type { BookView, Page } from "../types.js";
import type { Principal } from "../auth/index.js";
import { authenticateBasic } from "../auth/index.js";
import { readSession } from "../auth/session.js";
import { CT, notFound, redirect, tooMany, xml, json } from "../http/responses.js";
import { feedEtag, ifNoneMatch, notModified } from "../http/etag.js";
import { authDocument, unauthorized } from "../opds/authdoc.js";
import { openSearchDescription } from "../opds/opensearch.js";
import { acquisitionFeed, entryDocument, navigationFeed } from "../opds/atom.js";
import type { FeedContext, Link } from "../opds/atom.js";
import { acquisitionFeedJson, navigationFeedJson, publicationJson } from "../opds/json.js";
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

/** Serialize only after the ETag says the client needs it. */
function conditionalFeed(c: RouteContext, etagParts: Array<string | number | null | undefined>, render: () => Response): Response {
  const etag = feedEtag(etagParts);
  if (ifNoneMatch(c.request, etag)) return notModified(etag, FEED_CACHE);
  const response = render();
  response.headers.set("etag", etag);
  response.headers.set("cache-control", FEED_CACHE);
  return response;
}

function pageStamp(page: Page<BookView>): string {
  const newest = page.items.reduce((acc, b) => Math.max(acc, b.updated_at), 0);
  return `${page.total}:${page.page}:${page.pageSize}:${newest}`;
}

/* -------------------------------------------------------------------------- */
/* OPDS 1.2 -- Atom                                                            */
/* -------------------------------------------------------------------------- */

function atomAcquisition(
  c: RouteContext,
  opts: { id: string; title: string; path: string; page: Page<BookView>; facets?: Link[]; upHref?: string },
): Response {
  const ctx = feedContext(c);
  const params = new URLSearchParams(c.url.search);
  const pageHref = (page: number): string => {
    const p = new URLSearchParams(params);
    p.set("page", String(page));
    return `${ctx.origin}${opts.path}?${p.toString()}`;
  };
  const body = acquisitionFeed(ctx, {
    id: opts.id,
    title: opts.title,
    selfHref: pageHref(opts.page.page),
    upHref: opts.upHref,
    page: opts.page,
    pageHref,
    facets: opts.facets,
  });
  return xml(body, CT.opdsAcq);
}

function sortFacets(c: RouteContext, path: string, active: SortKey): Link[] {
  const options: Array<{ key: SortKey; label: string }> = [
    { key: "added", label: "Recently added" },
    { key: "title", label: "Title" },
    { key: "series", label: "Series" },
  ];
  return options.map((option) => ({
    rel: "http://opds-spec.org/facet",
    href: `${c.url.origin}${path}?sort=${option.key}`,
    type: CT.opdsAcq,
    title: option.label,
    attrs: {
      "opds:facetGroup": "Sort",
      ...(option.key === active ? { "opds:activeFacet": "true" } : {}),
    },
  }));
}

export function registerOpdsRoutes(router: Router): void {
  // The auth document must be reachable without authentication.
  router.get("/opds/auth", (c) =>
    json(authDocument(c.url.origin, c.env.CATALOG_TITLE), { headers: { "content-type": CT.opdsAuth } }),
  );

  router.get("/opds", (c) => {
    const accept = c.request.headers.get("accept") ?? "";
    // Default to 1.2: it is what the installed base actually speaks.
    const wantsJson = accept.includes("opds+json") && !accept.includes("atom+xml");
    return redirect(`${c.url.origin}/opds/${wantsJson ? "2.0" : "1.2"}`, 302);
  });

  /* ---------------------------- 1.2 navigation --------------------------- */

  router.get("/opds/1.2", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const ctx = feedContext(c);
    const body = navigationFeed(ctx, {
      id: `${ctx.origin}/opds/1.2`,
      title: ctx.catalogTitle,
      selfHref: `${ctx.origin}/opds/1.2`,
      entries: [
        { title: "New additions", href: `${ctx.origin}/opds/1.2/new`, type: CT.opdsAcq, summary: "Recently added books" },
        { title: "All books", href: `${ctx.origin}/opds/1.2/books`, type: CT.opdsAcq, summary: "Everything, by title" },
        { title: "Authors", href: `${ctx.origin}/opds/1.2/authors`, type: CT.opdsNav, summary: "Browse by author" },
        { title: "Series", href: `${ctx.origin}/opds/1.2/series`, type: CT.opdsNav, summary: "Browse by series" },
        { title: "Subjects", href: `${ctx.origin}/opds/1.2/tags`, type: CT.opdsNav, summary: "Browse by subject" },
      ],
    });
    return xml(body, CT.opdsNav, { headers: { "cache-control": FEED_CACHE } });
  });

  router.get("/opds/1.2/opensearch.xml", (c) =>
    xml(openSearchDescription(c.url.origin, c.env.CATALOG_TITLE), CT.openSearch, {
      headers: { "cache-control": "public, max-age=3600" },
    }),
  );

  router.get("/opds/1.2/new", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const page = await listBooks(c.env.DB, { page: pageParam(c), pageSize: pageSize(c), sort: "added" });
    return conditionalFeed(c, ["new", pageStamp(page)], () =>
      atomAcquisition(c, {
        id: `${c.url.origin}/opds/1.2/new`,
        title: "New additions",
        path: "/opds/1.2/new",
        page,
        upHref: `${c.url.origin}/opds/1.2`,
      }),
    );
  });

  router.get("/opds/1.2/books", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const sort = sortParam(c);
    const page = await listBooks(c.env.DB, { page: pageParam(c), pageSize: pageSize(c), sort });
    return conditionalFeed(c, ["books", sort, pageStamp(page)], () =>
      atomAcquisition(c, {
        id: `${c.url.origin}/opds/1.2/books`,
        title: "All books",
        path: "/opds/1.2/books",
        page,
        facets: sortFacets(c, "/opds/1.2/books", sort),
        upHref: `${c.url.origin}/opds/1.2`,
      }),
    );
  });

  router.get("/opds/1.2/authors", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const authors = await listAuthors(c.env.DB);
    const ctx = feedContext(c);
    return conditionalFeed(c, ["authors", authors.length, authors.map((a) => a.id).join(",")], () =>
      xml(
        navigationFeed(ctx, {
          id: `${ctx.origin}/opds/1.2/authors`,
          title: "Authors",
          selfHref: `${ctx.origin}/opds/1.2/authors`,
          upHref: `${ctx.origin}/opds/1.2`,
          entries: authors.map((a) => ({
            title: a.title,
            href: `${ctx.origin}/opds/1.2/authors/${encodeURIComponent(a.id)}`,
            type: CT.opdsAcq,
            count: a.count,
          })),
        }),
        CT.opdsNav,
      ),
    );
  });

  router.get("/opds/1.2/authors/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const name = await getAuthorName(c.env.DB, c.params.id);
    if (!name) return notFound("No such author");
    const page = await listBooksByAuthor(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    return conditionalFeed(c, ["author", c.params.id, pageStamp(page)], () =>
      atomAcquisition(c, {
        id: `${c.url.origin}/opds/1.2/authors/${c.params.id}`,
        title: name,
        path: `/opds/1.2/authors/${encodeURIComponent(c.params.id)}`,
        page,
        upHref: `${c.url.origin}/opds/1.2/authors`,
      }),
    );
  });

  router.get("/opds/1.2/series", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const series = await listSeries(c.env.DB);
    const ctx = feedContext(c);
    return conditionalFeed(c, ["series", series.length, series.map((s) => s.id).join(",")], () =>
      xml(
        navigationFeed(ctx, {
          id: `${ctx.origin}/opds/1.2/series`,
          title: "Series",
          selfHref: `${ctx.origin}/opds/1.2/series`,
          upHref: `${ctx.origin}/opds/1.2`,
          entries: series.map((s) => ({
            title: s.title,
            href: `${ctx.origin}/opds/1.2/series/${encodeURIComponent(s.id)}`,
            type: CT.opdsAcq,
            count: s.count,
          })),
        }),
        CT.opdsNav,
      ),
    );
  });

  router.get("/opds/1.2/series/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const page = await listBooksBySeries(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    if (page.total === 0) return notFound("No such series");
    return conditionalFeed(c, ["series", c.params.id, pageStamp(page)], () =>
      atomAcquisition(c, {
        id: `${c.url.origin}/opds/1.2/series/${c.params.id}`,
        title: c.params.id,
        path: `/opds/1.2/series/${encodeURIComponent(c.params.id)}`,
        page,
        upHref: `${c.url.origin}/opds/1.2/series`,
      }),
    );
  });

  router.get("/opds/1.2/tags", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const tags = await listTags(c.env.DB);
    const ctx = feedContext(c);
    return conditionalFeed(c, ["tags", tags.length, tags.map((t) => t.id).join(",")], () =>
      xml(
        navigationFeed(ctx, {
          id: `${ctx.origin}/opds/1.2/tags`,
          title: "Subjects",
          selfHref: `${ctx.origin}/opds/1.2/tags`,
          upHref: `${ctx.origin}/opds/1.2`,
          entries: tags.map((t) => ({
            title: t.title,
            href: `${ctx.origin}/opds/1.2/tags/${encodeURIComponent(t.id)}`,
            type: CT.opdsAcq,
            count: t.count,
          })),
        }),
        CT.opdsNav,
      ),
    );
  });

  router.get("/opds/1.2/tags/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const name = await getTagName(c.env.DB, c.params.id);
    if (!name) return notFound("No such subject");
    const page = await listBooksByTag(c.env.DB, c.params.id, { page: pageParam(c), pageSize: pageSize(c) });
    return conditionalFeed(c, ["tag", c.params.id, pageStamp(page)], () =>
      atomAcquisition(c, {
        id: `${c.url.origin}/opds/1.2/tags/${c.params.id}`,
        title: name,
        path: `/opds/1.2/tags/${encodeURIComponent(c.params.id)}`,
        page,
        upHref: `${c.url.origin}/opds/1.2/tags`,
      }),
    );
  });

  router.get("/opds/1.2/search", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const query = c.url.searchParams.get("q") ?? c.url.searchParams.get("query") ?? "";
    const page = await searchBooks(c.env.DB, query, { page: pageParam(c), pageSize: pageSize(c) });
    return atomAcquisition(c, {
      id: `${c.url.origin}/opds/1.2/search?q=${encodeURIComponent(query)}`,
      title: query ? `Search: ${query}` : "Search",
      path: "/opds/1.2/search",
      page,
      upHref: `${c.url.origin}/opds/1.2`,
    });
  });

  router.get("/opds/1.2/entry/:id", async (c) => {
    const who = await authenticate(c);
    if (who instanceof Response) return who;
    const book = await getBook(c.env.DB, c.params.id);
    if (!book) return notFound("No such book");
    return xml(entryDocument(feedContext(c), book), CT.opdsEntry);
  });

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
