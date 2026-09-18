import type { Env } from "../types.js";
import { getBook, reindexBook, updateBook, upsertAuthors, upsertTags } from "../db/queries.js";
import { sortTitle, titleFromFilename, toHex } from "../util.js";
import { extractCbz } from "./cbz.js";
import type { ExtractedMetadata } from "./epub.js";
import { extractEpub } from "./epub.js";
import { partialMd5 } from "./partialmd5.js";
import { r2RangeReader } from "./zip.js";

const COVER_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export interface IndexResult {
  ok: boolean;
  error?: string;
  title: string;
}

/**
 * Reads what metadata the format allows and writes it back to the row.
 *
 * Never throws: a book that cannot be parsed is still a book, and degrading to
 * filename metadata beats failing the upload. The reason is recorded in
 * books.index_error so the UI can show it.
 */
export async function indexBook(env: Env, bookId: string): Promise<IndexResult> {
  const book = await getBook(env.DB, bookId);
  if (!book) return { ok: false, error: "no such book", title: "" };

  const reader = r2RangeReader(env.BOOKS, book.r2_key, book.byte_size);
  const fallbackTitle = titleFromFilename(book.filename);

  let meta: ExtractedMetadata = { authors: [], subjects: [] };
  let error: string | null = null;

  try {
    if (book.format === "epub") {
      meta = await extractEpub(reader);
    } else if (book.format === "cbz") {
      meta = await extractCbz(reader, book.filename);
    } else {
      // PDF, MOBI, AZW3, CBR: no parser. The edit form is the answer.
      error = `no metadata parser for .${book.format}; using the filename`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The document hash is computed regardless of format -- KOReader syncs PDFs too.
  let hashes: { primary: string; alt: string } | null = null;
  try {
    hashes = await partialMd5(reader);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    error = error ? `${error}; partial-md5 failed: ${detail}` : `partial-md5 failed: ${detail}`;
  }

  let coverKey: string | null = book.cover_key;
  let coverMime: string | null = book.cover_mime;
  if (meta.cover) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", meta.cover.bytes);
      const ext = COVER_EXT[meta.cover.mime] ?? "bin";
      const key = `covers/${toHex(digest).slice(0, 32)}.${ext}`;
      // Content-addressed, so re-uploading the same edition costs one HEAD.
      const existing = await env.BOOKS.head(key);
      if (existing === null) {
        await env.BOOKS.put(key, meta.cover.bytes, {
          httpMetadata: { contentType: meta.cover.mime, cacheControl: "public, max-age=31536000, immutable" },
        });
      }
      coverKey = key;
      coverMime = meta.cover.mime;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      error = error ? `${error}; cover failed: ${detail}` : `cover failed: ${detail}`;
    }
  }

  const title = (meta.title ?? "").trim() || fallbackTitle;

  await updateBook(env.DB, bookId, {
    title,
    sort_title: sortTitle(title),
    series: meta.series ?? null,
    series_index: meta.seriesIndex ?? null,
    language: meta.language ?? null,
    publisher: meta.publisher ?? null,
    published: meta.published ?? null,
    isbn: meta.isbn ?? null,
    description: meta.description ?? null,
    cover_key: coverKey,
    cover_mime: coverMime,
    partial_md5: hashes?.primary ?? null,
    partial_md5_alt: hashes?.alt ?? null,
    indexed: 1,
    index_error: error,
  });

  await upsertAuthors(env.DB, bookId, meta.authors);
  await upsertTags(env.DB, bookId, meta.subjects.slice(0, 25));
  await reindexBook(env.DB, bookId);

  return { ok: error === null, error: error ?? undefined, title };
}
