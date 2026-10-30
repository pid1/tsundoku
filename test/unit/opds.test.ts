import { describe, expect, it } from "vitest";
import { acquisitionFeedJson, publicationJson } from "../../src/opds/json.js";
import type { FeedContext } from "../../src/opds/json.js";
import { authDocument } from "../../src/opds/authdoc.js";
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
