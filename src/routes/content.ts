import type { Router } from "../router.js";
import { notFound } from "../http/responses.js";
import { streamObject } from "../http/ranges.js";
import { getBook } from "../db/queries.js";
import { authenticateCatalog } from "./opds.js";

export function registerContentRoutes(router: Router): void {
  /**
   * The download itself. Range is honoured so a large CBZ stays resumable, and
   * HEAD is answered without touching R2's body.
   */
  router.get("/content/:id/:filename", async (c) => {
    const who = await authenticateCatalog(c);
    if (who instanceof Response) return who;

    const book = await getBook(c.env.DB, c.params.id);
    if (!book) return notFound("No such book");

    return streamObject(c.env.BOOKS, book.r2_key, book.byte_size, c.request, {
      contentType: book.mime,
      filename: book.filename,
      attachment: true,
      cacheControl: "private, max-age=86400",
      etag: `"${book.id}-${book.byte_size}"`,
    });
  });

  /**
   * Covers are content-addressed, so the bytes behind a key never change and a
   * one-year immutable cache is safe. That is what keeps a 50-book feed page
   * from costing 50 Worker invocations every time it is opened.
   */
  router.get("/covers/:key", async (c) => {
    const who = await authenticateCatalog(c);
    if (who instanceof Response) return who;

    const key = `covers/${c.params.key}`;
    const head = await c.env.BOOKS.head(key);
    if (head === null) return notFound("No such cover");

    return streamObject(c.env.BOOKS, key, head.size, c.request, {
      contentType: head.httpMetadata?.contentType ?? "application/octet-stream",
      cacheControl: "private, max-age=31536000, immutable",
      etag: `"${c.params.key}"`,
    });
  });
}
