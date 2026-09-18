import type { BookView, NavEntry, Page } from "../types.js";
import { escapeXml, xmlSafe } from "../util.js";
import { CT } from "../http/responses.js";

export interface FeedContext {
  origin: string;
  catalogTitle: string;
}

export interface Link {
  rel: string;
  href: string;
  type: string;
  title?: string;
  /** Extra attributes, e.g. opds:facetGroup or thr:count. */
  attrs?: Record<string, string | number>;
}

const NS = [
  'xmlns="http://www.w3.org/2005/Atom"',
  'xmlns:dc="http://purl.org/dc/terms/"',
  'xmlns:opds="http://opds-spec.org/2010/catalog"',
  'xmlns:thr="http://purl.org/syndication/thread/1.0"',
].join("\n      ");

function e(s: string): string {
  return escapeXml(xmlSafe(s));
}

function renderLink(link: Link): string {
  const attrs = [`rel="${e(link.rel)}"`, `href="${e(link.href)}"`, `type="${e(link.type)}"`];
  if (link.title) attrs.push(`title="${e(link.title)}"`);
  for (const [k, v] of Object.entries(link.attrs ?? {})) attrs.push(`${k}="${e(String(v))}"`);
  return `  <link ${attrs.join(" ")}/>`;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function bookId(id: string): string {
  return `urn:tsundoku:book:${id}`;
}

/** Links every feed carries. */
function commonLinks(ctx: FeedContext, selfHref: string, selfType: string): Link[] {
  return [
    { rel: "self", href: selfHref, type: selfType },
    { rel: "start", href: `${ctx.origin}/opds/1.2`, type: CT.opdsNav, title: ctx.catalogTitle },
    { rel: "search", href: `${ctx.origin}/opds/1.2/opensearch.xml`, type: CT.openSearch, title: "Search" },
  ];
}

export function navigationFeed(
  ctx: FeedContext,
  opts: { id: string; title: string; selfHref: string; upHref?: string; entries: Array<{ title: string; href: string; type: string; summary?: string; count?: number }> },
): string {
  const links = commonLinks(ctx, opts.selfHref, CT.opdsNav);
  if (opts.upHref) links.push({ rel: "up", href: opts.upHref, type: CT.opdsNav });

  const entries = opts.entries
    .map(
      (entry) => `  <entry>
    <title>${e(entry.title)}</title>
    <id>${e(`${opts.id}:${entry.href}`)}</id>
    <updated>${iso(Math.floor(Date.now() / 1000))}</updated>
    ${entry.summary ? `<content type="text">${e(entry.summary)}</content>` : ""}
    <link rel="subsection" href="${e(entry.href)}" type="${e(entry.type)}"${
      entry.count !== undefined ? ` thr:count="${entry.count}"` : ""
    }/>
  </entry>`,
    )
    .join("\n");

  return `<feed ${NS}>
  <id>${e(opts.id)}</id>
  <title>${e(opts.title)}</title>
  <updated>${iso(Math.floor(Date.now() / 1000))}</updated>
  <author><name>${e(ctx.catalogTitle)}</name></author>
${links.map(renderLink).join("\n")}
${entries}
</feed>`;
}

export function acquisitionFeed(
  ctx: FeedContext,
  opts: {
    id: string;
    title: string;
    selfHref: string;
    upHref?: string;
    page: Page<BookView>;
    /** Builds the href for another page of this same feed. */
    pageHref: (page: number) => string;
    facets?: Link[];
  },
): string {
  const { page } = opts;
  const lastPage = Math.max(1, Math.ceil(page.total / page.pageSize));

  const links = commonLinks(ctx, opts.selfHref, CT.opdsAcq);
  if (opts.upHref) links.push({ rel: "up", href: opts.upHref, type: CT.opdsNav });
  if (page.page > 1) {
    links.push({ rel: "first", href: opts.pageHref(1), type: CT.opdsAcq });
    links.push({ rel: "previous", href: opts.pageHref(page.page - 1), type: CT.opdsAcq });
  }
  if (page.page < lastPage) {
    links.push({ rel: "next", href: opts.pageHref(page.page + 1), type: CT.opdsAcq });
    links.push({ rel: "last", href: opts.pageHref(lastPage), type: CT.opdsAcq });
  }
  for (const facet of opts.facets ?? []) links.push(facet);

  const updated = page.items.length > 0 ? Math.max(...page.items.map((b) => b.updated_at)) : Math.floor(Date.now() / 1000);

  return `<feed ${NS}>
  <id>${e(opts.id)}</id>
  <title>${e(opts.title)}</title>
  <updated>${iso(updated)}</updated>
  <author><name>${e(ctx.catalogTitle)}</name></author>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${page.total}</opensearch:totalResults>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${page.pageSize}</opensearch:itemsPerPage>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${(page.page - 1) * page.pageSize + 1}</opensearch:startIndex>
${links.map(renderLink).join("\n")}
${page.items.map((book) => entryXml(ctx, book)).join("\n")}
</feed>`;
}

export function entryXml(ctx: FeedContext, book: BookView): string {
  const parts: string[] = [];
  parts.push(`    <title>${e(book.title)}</title>`);
  parts.push(`    <id>${e(bookId(book.id))}</id>`);
  parts.push(`    <updated>${iso(book.updated_at)}</updated>`);
  parts.push(`    <published>${iso(book.added_at)}</published>`);

  for (const author of book.authors) {
    parts.push(`    <author><name>${e(author)}</name></author>`);
  }
  if (book.language) parts.push(`    <dc:language>${e(book.language)}</dc:language>`);
  if (book.publisher) parts.push(`    <dc:publisher>${e(book.publisher)}</dc:publisher>`);
  if (book.published) parts.push(`    <dc:issued>${e(book.published)}</dc:issued>`);
  if (book.isbn) parts.push(`    <dc:identifier>urn:isbn:${e(book.isbn)}</dc:identifier>`);
  if (book.series) {
    const position = book.series_index !== null ? ` (#${book.series_index})` : "";
    parts.push(`    <category scheme="urn:tsundoku:series" term="${e(book.series)}" label="${e(book.series + position)}"/>`);
  }
  for (const tag of book.tags) {
    parts.push(`    <category term="${e(tag)}" label="${e(tag)}"/>`);
  }
  if (book.description) {
    parts.push(`    <summary type="text">${e(book.description.slice(0, 2000))}</summary>`);
  }

  if (book.cover_key) {
    const href = `${ctx.origin}/covers/${encodeURIComponent(book.cover_key.replace(/^covers\//, ""))}`;
    const type = book.cover_mime ?? "image/jpeg";
    // The same image serves both rels. Resizing would need Cloudflare Images,
    // which is not on the free tier; readers scale client-side anyway.
    parts.push(`    <link rel="http://opds-spec.org/image" href="${e(href)}" type="${e(type)}"/>`);
    parts.push(`    <link rel="http://opds-spec.org/image/thumbnail" href="${e(href)}" type="${e(type)}"/>`);
  }

  const download = `${ctx.origin}/content/${book.id}/${encodeURIComponent(book.filename)}`;
  parts.push(
    `    <link rel="http://opds-spec.org/acquisition" href="${e(download)}" type="${e(book.mime)}" length="${book.byte_size}"/>`,
  );

  return `  <entry>\n${parts.filter(Boolean).join("\n")}\n  </entry>`;
}

/** A standalone OPDS Catalog Entry Document. */
export function entryDocument(ctx: FeedContext, book: BookView): string {
  const inner = entryXml(ctx, book).replace(/^ {2}<entry>\n/, "").replace(/\n {2}<\/entry>$/, "");
  return `<entry ${NS}>
${inner}
</entry>`;
}
