import { describe, expect, it } from "vitest";
import { acquisitionFeed, entryDocument, navigationFeed } from "../../src/opds/atom.js";
import type { FeedContext } from "../../src/opds/atom.js";
import { acquisitionFeedJson, publicationJson } from "../../src/opds/json.js";
import { authDocument } from "../../src/opds/authdoc.js";
import { openSearchDescription } from "../../src/opds/opensearch.js";
import { CT } from "../../src/http/responses.js";
import type { BookView, Page } from "../../src/types.js";

const ctx: FeedContext = { origin: "https://books.example.com", catalogTitle: "tsundoku" };

function book(overrides: Partial<BookView> = {}): BookView {
  return {
    id: "01J000000000000000000BOOK",
    r2_key: "books/01J/x.epub",
    format: "epub",
    mime: "application/epub+zip",
    filename: "left hand.epub",
    byte_size: 412_000,
    content_md5: null,
    partial_md5: null,
    partial_md5_alt: null,
    title: "The Left Hand of Darkness",
    sort_title: "left hand of darkness",
    series: "Hainish Cycle",
    series_index: 4,
    language: "en",
    publisher: "Ace",
    published: "1969",
    isbn: "9780441478125",
    description: "Winter is a planet.",
    cover_key: "covers/abc123.jpg",
    cover_mime: "image/jpeg",
    indexed: 1,
    index_error: null,
    added_at: 1_700_000_000,
    added_by: "u1",
    updated_at: 1_700_000_500,
    authors: ["Ursula K. Le Guin"],
    tags: ["Science fiction"],
    ...overrides,
  };
}

function page(items: BookView[], overrides: Partial<Page<BookView>> = {}): Page<BookView> {
  return { items, total: items.length, page: 1, pageSize: 50, ...overrides };
}

describe("OPDS 1.2 Atom", () => {
  it("declares the acquisition-feed media type on paging links", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "All books",
      selfHref: `${ctx.origin}/opds/1.2/books?page=2`,
      page: page([book()], { page: 2, total: 200 }),
      pageHref: (p) => `${ctx.origin}/opds/1.2/books?page=${p}`,
    });

    expect(feed).toContain(`rel="next"`);
    expect(feed).toContain(`rel="previous"`);
    expect(feed).toContain(`rel="first"`);
    expect(feed).toContain(`rel="last"`);
    // Readers dispatch on the type; a paging link typed as navigation breaks them.
    const nextLink = /rel="next"[^>]*type="([^"]+)"/.exec(feed);
    expect(nextLink?.[1]).toBe(CT.opdsAcq);
  });

  it("omits previous and next at the ends of a single-page feed", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "All books",
      selfHref: "https://books.example.com/opds/1.2/books",
      page: page([book()]),
      pageHref: (p) => `?page=${p}`,
    });
    expect(feed).not.toContain(`rel="next"`);
    expect(feed).not.toContain(`rel="previous"`);
  });

  it("emits the acquisition, image and thumbnail rels with a length", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "t",
      selfHref: "https://books.example.com/opds/1.2/new",
      page: page([book()]),
      pageHref: (p) => `?page=${p}`,
    });

    expect(feed).toContain('rel="http://opds-spec.org/acquisition"');
    expect(feed).toContain('rel="http://opds-spec.org/image"');
    expect(feed).toContain('rel="http://opds-spec.org/image/thumbnail"');
    expect(feed).toContain('length="412000"');
    expect(feed).toContain("type=\"application/epub+zip\"");
  });

  it("percent-encodes a filename with a space in the acquisition href", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "t",
      selfHref: "https://books.example.com/opds/1.2/new",
      page: page([book()]),
      pageHref: (p) => `?page=${p}`,
    });
    expect(feed).toContain("/content/01J000000000000000000BOOK/left%20hand.epub");
    expect(feed).not.toContain("left hand.epub");
  });

  it("escapes markup in user-controlled metadata", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "t",
      selfHref: "https://books.example.com/opds/1.2/new",
      page: page([book({ title: 'Tom & Jerry <script>alert("x")</script>' })]),
      pageHref: (p) => `?page=${p}`,
    });
    expect(feed).toContain("Tom &amp; Jerry &lt;script&gt;");
    expect(feed).not.toContain("<script>");
  });

  it("carries OpenSearch totals so readers can page sensibly", () => {
    const feed = acquisitionFeed(ctx, {
      id: "urn:x",
      title: "t",
      selfHref: "https://books.example.com/opds/1.2/books?page=3",
      page: page([book()], { page: 3, total: 412 }),
      pageHref: (p) => `?page=${p}`,
    });
    expect(feed).toContain("<opensearch:totalResults");
    expect(feed).toContain(">412<");
    expect(feed).toContain(">101<"); // startIndex: (3-1)*50 + 1
  });

  it("renders a navigation feed with subsection links and counts", () => {
    const feed = navigationFeed(ctx, {
      id: "urn:nav",
      title: "Authors",
      selfHref: "https://books.example.com/opds/1.2/authors",
      entries: [{ title: "Le Guin", href: "https://books.example.com/opds/1.2/authors/a1", type: CT.opdsAcq, count: 7 }],
    });
    expect(feed).toContain('rel="subsection"');
    expect(feed).toContain('thr:count="7"');
    expect(feed).toContain('rel="search"');
  });

  it("renders a standalone entry document", () => {
    const doc = entryDocument(ctx, book());
    expect(doc.startsWith("<entry ")).toBe(true);
    expect(doc.trimEnd().endsWith("</entry>")).toBe(true);
    expect(doc).toContain("<title>The Left Hand of Darkness</title>");
  });

  it("survives a book with no authors, cover or series", () => {
    const bare = book({ authors: [], tags: [], cover_key: null, series: null, series_index: null, description: null });
    const doc = entryDocument(ctx, bare);
    expect(doc).not.toContain("opds-spec.org/image");
    expect(doc).toContain("opds-spec.org/acquisition");
  });
});

describe("OPDS 2.0 JSON", () => {
  it("carries the required metadata, self link and pagination", () => {
    const feed = acquisitionFeedJson(ctx, {
      title: "New additions",
      selfHref: `${ctx.origin}/opds/2.0/new?page=1`,
      page: page([book()], { total: 120 }),
      pageHref: (p) => `${ctx.origin}/opds/2.0/new?page=${p}`,
    });

    expect(feed.metadata.title).toBe("New additions");
    expect(feed.metadata.numberOfItems).toBe(120);
    expect(feed.metadata.itemsPerPage).toBe(50);
    expect(feed.metadata.currentPage).toBe(1);
    expect(feed.links.some((l) => l.rel === "self")).toBe(true);
    expect(feed.links.some((l) => l.rel === "next")).toBe(true);
    expect(feed.publications).toHaveLength(1);
  });

  it("offers a templated search link", () => {
    const feed = acquisitionFeedJson(ctx, {
      title: "t",
      selfHref: "x",
      page: page([]),
      pageHref: () => "x",
    });
    const search = feed.links.find((l) => l.rel === "search");
    expect(search?.templated).toBe(true);
    expect(search?.href).toContain("{?query,page}");
  });

  it("maps a publication onto the Readium manifest shape", () => {
    const pub = publicationJson(ctx, book());
    expect(pub.metadata["@type"]).toBe("http://schema.org/Book");
    expect(pub.metadata.title).toBe("The Left Hand of Darkness");
    expect(pub.metadata.author).toEqual([{ name: "Ursula K. Le Guin" }]);
    expect(pub.metadata.belongsTo).toEqual({ series: { name: "Hainish Cycle", position: 4 } });
    expect(pub.metadata.identifier).toBe("urn:isbn:9780441478125");
    expect(pub.images?.[0]?.href).toContain("/covers/abc123.jpg");
    expect(pub.links[0].rel).toBe("http://opds-spec.org/acquisition");
    expect(pub.links[0].type).toBe("application/epub+zip");
  });

  it("types a comic as a ComicIssue", () => {
    expect(publicationJson(ctx, book({ format: "cbz" })).metadata["@type"]).toBe("http://schema.org/ComicIssue");
  });
});

describe("Authentication for OPDS 1.0", () => {
  it("advertises Basic, which is the only scheme KOReader speaks", () => {
    const doc = authDocument(ctx.origin, ctx.catalogTitle) as {
      id: string;
      title: string;
      authentication: Array<{ type: string; labels: Record<string, string> }>;
    };
    expect(doc.id).toBe("https://books.example.com/opds/auth");
    expect(doc.title).toBe("tsundoku");
    expect(doc.authentication[0].type).toBe("http://opds-spec.org/auth/basic");
    expect(doc.authentication[0].labels).toEqual({ login: "Username", password: "Password" });
  });
});

describe("OpenSearch description", () => {
  it("declares the acquisition media type on the 1.2 template", () => {
    const xml = openSearchDescription(ctx.origin, ctx.catalogTitle);
    expect(xml).toContain("{searchTerms}");
    expect(xml).toContain(CT.opdsAcq.replace(/&/g, "&amp;"));
    // An & inside a template must be escaped or the document will not parse.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});
