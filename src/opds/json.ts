import type { BookView, Page } from "../types.js";
import { CT } from "../http/responses.js";
import type { FeedContext } from "./atom.js";

export interface JsonLink {
  rel?: string | string[];
  href: string;
  type?: string;
  title?: string;
  templated?: boolean;
  properties?: Record<string, unknown>;
}

export interface JsonPublication {
  metadata: Record<string, unknown>;
  links: JsonLink[];
  images?: JsonLink[];
}

export interface JsonFeed {
  metadata: Record<string, unknown>;
  links: JsonLink[];
  navigation?: JsonLink[];
  publications?: JsonPublication[];
  groups?: Array<{ metadata: Record<string, unknown>; links?: JsonLink[]; navigation?: JsonLink[]; publications?: JsonPublication[] }>;
  facets?: Array<{ metadata: Record<string, unknown>; links: JsonLink[] }>;
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function commonLinks(ctx: FeedContext, selfHref: string): JsonLink[] {
  return [
    { rel: "self", href: selfHref, type: CT.opdsJson },
    { rel: "start", href: `${ctx.origin}/opds/2.0`, type: CT.opdsJson, title: ctx.catalogTitle },
    {
      rel: "search",
      href: `${ctx.origin}/opds/2.0/search{?query,page}`,
      type: CT.opdsJson,
      templated: true,
      title: "Search",
    },
  ];
}

export function navigationFeedJson(
  ctx: FeedContext,
  opts: { title: string; selfHref: string; entries: Array<{ title: string; href: string; type?: string; count?: number }> },
): JsonFeed {
  return {
    metadata: { title: opts.title },
    links: commonLinks(ctx, opts.selfHref),
    navigation: opts.entries.map((entry) => ({
      href: entry.href,
      title: entry.count === undefined ? entry.title : `${entry.title} (${entry.count})`,
      type: entry.type ?? CT.opdsJson,
    })),
  };
}

export function acquisitionFeedJson(
  ctx: FeedContext,
  opts: { title: string; selfHref: string; page: Page<BookView>; pageHref: (page: number) => string },
): JsonFeed {
  const { page } = opts;
  const lastPage = Math.max(1, Math.ceil(page.total / page.pageSize));
  const links = commonLinks(ctx, opts.selfHref);

  if (page.page > 1) {
    links.push({ rel: "first", href: opts.pageHref(1), type: CT.opdsJson });
    links.push({ rel: "previous", href: opts.pageHref(page.page - 1), type: CT.opdsJson });
  }
  if (page.page < lastPage) {
    links.push({ rel: "next", href: opts.pageHref(page.page + 1), type: CT.opdsJson });
    links.push({ rel: "last", href: opts.pageHref(lastPage), type: CT.opdsJson });
  }

  return {
    metadata: {
      title: opts.title,
      numberOfItems: page.total,
      itemsPerPage: page.pageSize,
      currentPage: page.page,
    },
    links,
    publications: page.items.map((book) => publicationJson(ctx, book)),
  };
}

export function publicationJson(ctx: FeedContext, book: BookView): JsonPublication {
  const metadata: Record<string, unknown> = {
    "@type": book.format === "cbz" ? "http://schema.org/ComicIssue" : "http://schema.org/Book",
    title: book.title,
    sortAs: book.sort_title,
    identifier: book.isbn ? `urn:isbn:${book.isbn}` : `urn:tsundoku:book:${book.id}`,
    modified: isoFromSeconds(book.updated_at),
  };

  if (book.authors.length > 0) {
    metadata.author = book.authors.map((name) => ({ name }));
  }
  if (book.language) metadata.language = book.language;
  if (book.publisher) metadata.publisher = { name: book.publisher };
  if (book.published) metadata.published = book.published;
  if (book.description) metadata.description = book.description;
  if (book.tags.length > 0) metadata.subject = book.tags;
  if (book.series) {
    metadata.belongsTo = {
      series: book.series_index === null ? { name: book.series } : { name: book.series, position: book.series_index },
    };
  }

  const publication: JsonPublication = {
    metadata,
    links: [
      {
        rel: "http://opds-spec.org/acquisition",
        href: `${ctx.origin}/content/${book.id}/${encodeURIComponent(book.filename)}`,
        type: book.mime,
        properties: { numberOfBytes: book.byte_size },
      },
      {
        rel: "self",
        href: `${ctx.origin}/opds/2.0/publication/${book.id}`,
        type: CT.opdsPublication,
      },
    ],
  };

  if (book.cover_key) {
    const href = `${ctx.origin}/covers/${encodeURIComponent(book.cover_key.replace(/^covers\//, ""))}`;
    publication.images = [{ href, type: book.cover_mime ?? "image/jpeg" }];
  }

  return publication;
}
