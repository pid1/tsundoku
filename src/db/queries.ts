import type { Book, BookView, DeviceProgressRow, NavEntry, Page, ProgressRow, User } from "../types.js";
import { nowSeconds, sortAuthor, sortTitle, ulid } from "../util.js";

/* -------------------------------------------------------------------------- */
/* users                                                                       */
/* -------------------------------------------------------------------------- */

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
  return row?.c ?? 0;
}

export function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username).first<User>();
}

export function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE")
    .all<User>();
  return results;
}

export async function createUser(
  db: D1Database,
  args: {
    username: string;
    displayName: string | null;
    role: "admin" | "reader";
    opdsVerifier: string;
    kosyncVerifier: string;
  },
): Promise<string> {
  const id = ulid();
  const ts = nowSeconds();
  await db
    .prepare(
      `INSERT INTO users (id, username, display_name, role, opds_verifier, kosync_verifier,
                          disabled, created_at, password_set_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, args.username, args.displayName, args.role, args.opdsVerifier, args.kosyncVerifier, ts, ts)
    .run();
  return id;
}

export async function setUserPassword(
  db: D1Database,
  userId: string,
  opdsVerifier: string,
  kosyncVerifier: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET opds_verifier = ?, kosync_verifier = ?, password_set_at = ? WHERE id = ?")
    .bind(opdsVerifier, kosyncVerifier, nowSeconds(), userId)
    .run();
}

export async function updateUserFields(
  db: D1Database,
  userId: string,
  fields: { display_name?: string | null; role?: string; disabled?: number },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(userId);
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
}

export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

/* -------------------------------------------------------------------------- */
/* rate limiting                                                               */
/* -------------------------------------------------------------------------- */

const WINDOW_SECONDS = 300;

/** Returns true when the caller is over budget for this window. */
export async function recordAuthFailure(db: D1Database, bucket: string, limit: number): Promise<boolean> {
  const window = Math.floor(nowSeconds() / WINDOW_SECONDS) * WINDOW_SECONDS;
  await db
    .prepare(
      `INSERT INTO auth_failures (bucket, window_at, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_at) DO UPDATE SET count = count + 1`,
    )
    .bind(bucket, window)
    .run();
  const row = await db
    .prepare("SELECT count FROM auth_failures WHERE bucket = ? AND window_at = ?")
    .bind(bucket, window)
    .first<{ count: number }>();
  return (row?.count ?? 0) > limit;
}

export async function isRateLimited(db: D1Database, bucket: string, limit: number): Promise<boolean> {
  const window = Math.floor(nowSeconds() / WINDOW_SECONDS) * WINDOW_SECONDS;
  const row = await db
    .prepare("SELECT count FROM auth_failures WHERE bucket = ? AND window_at = ?")
    .bind(bucket, window)
    .first<{ count: number }>();
  return (row?.count ?? 0) > limit;
}

export async function pruneAuthFailures(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM auth_failures WHERE window_at < ?")
    .bind(nowSeconds() - WINDOW_SECONDS * 4)
    .run();
}

/** Every cover key still pointed at by a book. Used by the nightly orphan sweep. */
export async function referencedCoverKeys(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT cover_key FROM books WHERE cover_key IS NOT NULL")
    .all<{ cover_key: string }>();
  return new Set((results ?? []).map((r) => r.cover_key));
}

/* -------------------------------------------------------------------------- */
/* books                                                                       */
/* -------------------------------------------------------------------------- */

/** Attaches authors and tags to a page of books in two extra queries, not N. */
async function hydrate(db: D1Database, books: Book[]): Promise<BookView[]> {
  if (books.length === 0) return [];
  const ids = books.map((b) => b.id);
  const placeholders = ids.map(() => "?").join(",");

  const [authorRows, tagRows] = await db.batch<{ book_id: string; name: string }>([
    db
      .prepare(
        `SELECT ba.book_id AS book_id, a.name AS name
           FROM book_authors ba JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id IN (${placeholders})
          ORDER BY ba.ord`,
      )
      .bind(...ids),
    db
      .prepare(
        `SELECT bt.book_id AS book_id, t.name AS name
           FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
          WHERE bt.book_id IN (${placeholders})
          ORDER BY t.name`,
      )
      .bind(...ids),
  ]);

  const authors = new Map<string, string[]>();
  for (const r of authorRows.results) {
    const list = authors.get(r.book_id) ?? [];
    list.push(r.name);
    authors.set(r.book_id, list);
  }
  const tags = new Map<string, string[]>();
  for (const r of tagRows.results) {
    const list = tags.get(r.book_id) ?? [];
    list.push(r.name);
    tags.set(r.book_id, list);
  }

  return books.map((b) => ({
    ...b,
    authors: authors.get(b.id) ?? [],
    tags: tags.get(b.id) ?? [],
  }));
}

export type SortKey = "added" | "title" | "author" | "series";

const ORDER_BY: Record<SortKey, string> = {
  added: "b.added_at DESC",
  title: "b.sort_title ASC",
  author: "b.sort_title ASC",
  series: "b.series ASC, b.series_index ASC, b.sort_title ASC",
};

export async function listBooks(
  db: D1Database,
  opts: { page: number; pageSize: number; sort: SortKey },
): Promise<Page<BookView>> {
  const offset = (opts.page - 1) * opts.pageSize;
  const countRow = await db.prepare("SELECT COUNT(*) AS c FROM books").first<{ c: number }>();
  const { results } = await db
    .prepare(`SELECT b.* FROM books b ORDER BY ${ORDER_BY[opts.sort]} LIMIT ? OFFSET ?`)
    .bind(opts.pageSize, offset)
    .all<Book>();
  return {
    items: await hydrate(db, results),
    total: countRow?.c ?? 0,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

export async function listBooksByAuthor(
  db: D1Database,
  authorId: string,
  opts: { page: number; pageSize: number },
): Promise<Page<BookView>> {
  const offset = (opts.page - 1) * opts.pageSize;
  const countRow = await db
    .prepare("SELECT COUNT(*) AS c FROM book_authors WHERE author_id = ?")
    .bind(authorId)
    .first<{ c: number }>();
  const { results } = await db
    .prepare(
      `SELECT b.* FROM books b JOIN book_authors ba ON ba.book_id = b.id
        WHERE ba.author_id = ?
        ORDER BY b.series ASC, b.series_index ASC, b.sort_title ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(authorId, opts.pageSize, offset)
    .all<Book>();
  return { items: await hydrate(db, results), total: countRow?.c ?? 0, page: opts.page, pageSize: opts.pageSize };
}

export async function listBooksByTag(
  db: D1Database,
  tagId: string,
  opts: { page: number; pageSize: number },
): Promise<Page<BookView>> {
  const offset = (opts.page - 1) * opts.pageSize;
  const countRow = await db
    .prepare("SELECT COUNT(*) AS c FROM book_tags WHERE tag_id = ?")
    .bind(tagId)
    .first<{ c: number }>();
  const { results } = await db
    .prepare(
      `SELECT b.* FROM books b JOIN book_tags bt ON bt.book_id = b.id
        WHERE bt.tag_id = ? ORDER BY b.sort_title ASC LIMIT ? OFFSET ?`,
    )
    .bind(tagId, opts.pageSize, offset)
    .all<Book>();
  return { items: await hydrate(db, results), total: countRow?.c ?? 0, page: opts.page, pageSize: opts.pageSize };
}

export async function listBooksBySeries(
  db: D1Database,
  series: string,
  opts: { page: number; pageSize: number },
): Promise<Page<BookView>> {
  const offset = (opts.page - 1) * opts.pageSize;
  const countRow = await db
    .prepare("SELECT COUNT(*) AS c FROM books WHERE series = ?")
    .bind(series)
    .first<{ c: number }>();
  const { results } = await db
    .prepare(
      "SELECT * FROM books WHERE series = ? ORDER BY series_index ASC, sort_title ASC LIMIT ? OFFSET ?",
    )
    .bind(series, opts.pageSize, offset)
    .all<Book>();
  return { items: await hydrate(db, results), total: countRow?.c ?? 0, page: opts.page, pageSize: opts.pageSize };
}

export async function getBook(db: D1Database, id: string): Promise<BookView | null> {
  const book = await db.prepare("SELECT * FROM books WHERE id = ?").bind(id).first<Book>();
  if (!book) return null;
  const [view] = await hydrate(db, [book]);
  return view ?? null;
}

export function getBookByContentMd5(db: D1Database, md5: string): Promise<Book | null> {
  return db.prepare("SELECT * FROM books WHERE content_md5 = ?").bind(md5).first<Book>();
}

/** Best-effort match of a kosync document hash to a book we hold. */
export function getBookByPartialMd5(db: D1Database, hash: string): Promise<Book | null> {
  return db
    .prepare("SELECT * FROM books WHERE partial_md5 = ? OR partial_md5_alt = ? LIMIT 1")
    .bind(hash, hash)
    .first<Book>();
}

export async function insertBook(db: D1Database, book: Book): Promise<void> {
  await db
    .prepare(
      `INSERT INTO books (id, r2_key, format, mime, filename, byte_size, content_md5,
                          partial_md5, partial_md5_alt, title, sort_title, series, series_index,
                          language, publisher, published, isbn, description, cover_key, cover_mime,
                          indexed, index_error, added_at, added_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      book.id, book.r2_key, book.format, book.mime, book.filename, book.byte_size, book.content_md5,
      book.partial_md5, book.partial_md5_alt, book.title, book.sort_title, book.series, book.series_index,
      book.language, book.publisher, book.published, book.isbn, book.description, book.cover_key,
      book.cover_mime, book.indexed, book.index_error, book.added_at, book.added_by, book.updated_at,
    )
    .run();
}

const UPDATABLE = new Set([
  "title", "sort_title", "series", "series_index", "language", "publisher", "published",
  "isbn", "description", "cover_key", "cover_mime", "partial_md5", "partial_md5_alt",
  "indexed", "index_error", "content_md5",
]);

export async function updateBook(db: D1Database, id: string, fields: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATABLE.has(k) || v === undefined) continue;
    sets.push(`${k} = ?`);
    values.push(v as D1Type);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowSeconds(), id);
  await db.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
}

type D1Type = string | number | null;

export async function deleteBook(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM books_fts WHERE book_id = ?").bind(id),
    db.prepare("DELETE FROM books WHERE id = ?").bind(id),
  ]);
}

/* -------------------------------------------------------------------------- */
/* authors, series, tags                                                       */
/* -------------------------------------------------------------------------- */

export async function upsertAuthors(db: D1Database, bookId: string, names: string[]): Promise<void> {
  await db.prepare("DELETE FROM book_authors WHERE book_id = ?").bind(bookId).run();
  let ord = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const sort = sortAuthor(name);
    const existing = await db
      .prepare("SELECT id FROM authors WHERE sort_name = ?")
      .bind(sort)
      .first<{ id: string }>();
    const authorId = existing?.id ?? ulid();
    if (!existing) {
      await db.prepare("INSERT INTO authors (id, name, sort_name) VALUES (?, ?, ?)").bind(authorId, name, sort).run();
    }
    await db
      .prepare("INSERT OR REPLACE INTO book_authors (book_id, author_id, ord) VALUES (?, ?, ?)")
      .bind(bookId, authorId, ord++)
      .run();
  }
}

export async function upsertTags(db: D1Database, bookId: string, names: string[]): Promise<void> {
  await db.prepare("DELETE FROM book_tags WHERE book_id = ?").bind(bookId).run();
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const existing = await db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").bind(name).first<{ id: string }>();
    const tagId = existing?.id ?? ulid();
    if (!existing) {
      await db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").bind(tagId, name).run();
    }
    await db.prepare("INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)").bind(bookId, tagId).run();
  }
}

export async function listAuthors(db: D1Database): Promise<NavEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS id, a.name AS title, COUNT(ba.book_id) AS count
         FROM authors a JOIN book_authors ba ON ba.author_id = a.id
        GROUP BY a.id HAVING count > 0 ORDER BY a.sort_name`,
    )
    .all<NavEntry>();
  return results;
}

export async function listTags(db: D1Database): Promise<NavEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS id, t.name AS title, COUNT(bt.book_id) AS count
         FROM tags t JOIN book_tags bt ON bt.tag_id = t.id
        GROUP BY t.id HAVING count > 0 ORDER BY t.name COLLATE NOCASE`,
    )
    .all<NavEntry>();
  return results;
}

export async function listSeries(db: D1Database): Promise<NavEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT series AS id, series AS title, COUNT(*) AS count
         FROM books WHERE series IS NOT NULL AND series <> ''
        GROUP BY series ORDER BY series COLLATE NOCASE`,
    )
    .all<NavEntry>();
  return results;
}

export async function getAuthorName(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM authors WHERE id = ?").bind(id).first<{ name: string }>();
  return row?.name ?? null;
}

export async function getTagName(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM tags WHERE id = ?").bind(id).first<{ name: string }>();
  return row?.name ?? null;
}

/* -------------------------------------------------------------------------- */
/* search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turns user input into an FTS5 MATCH expression. Every term is quoted, so
 * FTS5 operators a user happens to type ("AND", "*", ":") are treated as text
 * rather than as syntax that could throw.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" AND ");
}

export async function searchBooks(
  db: D1Database,
  query: string,
  opts: { page: number; pageSize: number },
): Promise<Page<BookView>> {
  const match = toFtsQuery(query);
  if (!match) return { items: [], total: 0, page: opts.page, pageSize: opts.pageSize };
  const offset = (opts.page - 1) * opts.pageSize;

  const countRow = await db
    .prepare("SELECT COUNT(*) AS c FROM books_fts WHERE books_fts MATCH ?")
    .bind(match)
    .first<{ c: number }>();

  const { results } = await db
    .prepare(
      `SELECT b.* FROM books_fts f JOIN books b ON b.id = f.book_id
        WHERE books_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
    )
    .bind(match, opts.pageSize, offset)
    .all<Book>();

  return { items: await hydrate(db, results), total: countRow?.c ?? 0, page: opts.page, pageSize: opts.pageSize };
}

/** Rebuilds one book's search row. Called after any metadata change. */
export async function reindexBook(db: D1Database, bookId: string): Promise<void> {
  const view = await getBook(db, bookId);
  await db.prepare("DELETE FROM books_fts WHERE book_id = ?").bind(bookId).run();
  if (!view) return;
  await db
    .prepare(
      "INSERT INTO books_fts (book_id, title, authors, series, tags, description) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      view.id,
      view.title,
      view.authors.join(" "),
      view.series ?? "",
      view.tags.join(" "),
      (view.description ?? "").slice(0, 4000),
    )
    .run();
}

/* -------------------------------------------------------------------------- */
/* progress (kosync)                                                           */
/* -------------------------------------------------------------------------- */

export function getProgress(db: D1Database, userId: string, document: string): Promise<ProgressRow | null> {
  return db
    .prepare("SELECT * FROM progress WHERE user_id = ? AND document = ?")
    .bind(userId, document)
    .first<ProgressRow>();
}

export async function putProgress(
  db: D1Database,
  row: Omit<ProgressRow, "updated_at"> & { updated_at?: number },
): Promise<number> {
  const ts = row.updated_at ?? nowSeconds();
  // COALESCE on metadata: KOReader only sends it when "Send document metadata"
  // is enabled, and a push without it must not wipe what we already hold.
  await db
    .prepare(
      `INSERT INTO progress (user_id, document, percentage, progress, device, device_id, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         percentage = excluded.percentage,
         progress   = excluded.progress,
         device     = excluded.device,
         device_id  = excluded.device_id,
         metadata   = COALESCE(excluded.metadata, progress.metadata),
         updated_at = excluded.updated_at`,
    )
    .bind(row.user_id, row.document, row.percentage, row.progress, row.device, row.device_id, row.metadata, ts)
    .run();

  // Same position, kept per device instead of last-writer-wins, so the Sync
  // page can say which devices agree. Deliberately a second write rather than a
  // change to `progress`: kosync reads that table and its semantics are the
  // protocol's, not ours.
  await db
    .prepare(
      `INSERT INTO progress_devices (user_id, document, device_id, device, percentage, progress, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document, device_id) DO UPDATE SET
         device     = excluded.device,
         percentage = excluded.percentage,
         progress   = excluded.progress,
         updated_at = excluded.updated_at`,
    )
    .bind(row.user_id, row.document, row.device_id, row.device, row.percentage, row.progress, ts)
    .run();

  return ts;
}

/** Users who have at least one device position, for the Sync page's filter. */
export async function listSyncUsers(db: D1Database): Promise<{ id: string; label: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id AS id, COALESCE(NULLIF(u.display_name, ''), u.username) AS label
         FROM progress_devices pd JOIN users u ON u.id = pd.user_id
        ORDER BY label COLLATE NOCASE`,
    )
    .all<{ id: string; label: string }>();
  return results ?? [];
}

/**
 * Every device position, with the book and user it belongs to already attached
 * and the per-book aggregates computed in SQL.
 *
 * The join to `books` matches either partial-MD5 column: which one KOReader
 * produces is settled (offset 0) but both are stored, and a device that
 * computed the other one still has to find its book. A row with no book is
 * kept, not dropped -- a position for something not in the library is exactly
 * what the page should show, and the kosync metadata carries a usable title.
 */
export async function listDeviceProgress(
  db: D1Database,
  opts: { userId?: string; limit?: number } = {},
): Promise<DeviceProgressRow[]> {
  const limit = opts.limit ?? 500;
  const where = opts.userId ? "WHERE pd.user_id = ?" : "";
  const binds: unknown[] = opts.userId ? [opts.userId, limit] : [limit];

  const { results } = await db
    .prepare(
      `SELECT pd.user_id, pd.document, pd.device_id, pd.device, pd.percentage, pd.progress, pd.updated_at,
              u.username, u.display_name,
              b.id AS book_id, b.title AS book_title, b.format AS book_format,
              p.metadata AS metadata,
              MAX(pd.percentage) OVER w AS furthest_percentage,
              MAX(pd.updated_at) OVER w AS latest_updated_at,
              COUNT(*)      OVER w AS device_count
         FROM progress_devices pd
         JOIN users u ON u.id = pd.user_id
         LEFT JOIN books b ON b.partial_md5 = pd.document OR b.partial_md5_alt = pd.document
         LEFT JOIN progress p ON p.user_id = pd.user_id AND p.document = pd.document
         ${where}
       WINDOW w AS (PARTITION BY pd.user_id, pd.document)
        ORDER BY pd.updated_at DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<DeviceProgressRow>();
  return results ?? [];
}

export async function listProgress(db: D1Database, userId: string, limit = 200): Promise<ProgressRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(userId, limit)
    .all<ProgressRow>();
  return results;
}

/* -------------------------------------------------------------------------- */
/* uploads                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadRow {
  id: string;
  user_id: string;
  r2_key: string;
  r2_upload_id: string;
  filename: string;
  parts: string;
  created_at: number;
}

export async function createUpload(db: D1Database, row: Omit<UploadRow, "created_at">): Promise<void> {
  await db
    .prepare(
      "INSERT INTO uploads (id, user_id, r2_key, r2_upload_id, filename, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, row.user_id, row.r2_key, row.r2_upload_id, row.filename, row.parts, nowSeconds())
    .run();
}

export function getUpload(db: D1Database, id: string): Promise<UploadRow | null> {
  return db.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
}

export async function setUploadParts(db: D1Database, id: string, parts: string): Promise<void> {
  await db.prepare("UPDATE uploads SET parts = ? WHERE id = ?").bind(parts, id).run();
}

export async function deleteUpload(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
}

export async function listStaleUploads(db: D1Database, olderThanSeconds: number): Promise<UploadRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM uploads WHERE created_at < ?")
    .bind(nowSeconds() - olderThanSeconds)
    .all<UploadRow>();
  return results;
}

/* -------------------------------------------------------------------------- */
/* stats                                                                       */
/* -------------------------------------------------------------------------- */

export async function stats(db: D1Database): Promise<{
  books: number;
  bytes: number;
  authors: number;
  series: number;
  tags: number;
  users: number;
  unindexed: number;
}> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM books) AS books,
         (SELECT COALESCE(SUM(byte_size), 0) FROM books) AS bytes,
         (SELECT COUNT(*) FROM authors) AS authors,
         (SELECT COUNT(DISTINCT series) FROM books WHERE series IS NOT NULL AND series <> '') AS series,
         (SELECT COUNT(*) FROM tags) AS tags,
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM books WHERE indexed = 0) AS unindexed`,
    )
    .first<{ books: number; bytes: number; authors: number; series: number; tags: number; users: number; unindexed: number }>();
  return row ?? { books: 0, bytes: 0, authors: 0, series: 0, tags: 0, users: 0, unindexed: 0 };
}

export { sortTitle };
