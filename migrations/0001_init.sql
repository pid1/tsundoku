-- tsundoku: core schema.
--
-- Credential storage note: opds_verifier and kosync_verifier are keyed hashes
-- (HMAC-SHA256 under a PEPPER held in Workers Secrets, never in this database),
-- not slow KDF outputs. HTTP Basic sends credentials on every OPDS request and
-- the Workers free plan caps CPU at 10ms per invocation, which rules out a
-- high-iteration KDF on that path. See PLAN.md section 5 for the tradeoff and
-- the compensating controls.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name     TEXT,
  role             TEXT NOT NULL DEFAULT 'reader',   -- 'admin' | 'reader'
  opds_verifier    TEXT NOT NULL,   -- hex HMAC(PEPPER, "opds:"   || user || ":" || password)
  kosync_verifier  TEXT NOT NULL,   -- hex HMAC(PEPPER, "kosync:" || user || ":" || md5hex(password))
  disabled         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  password_set_at  INTEGER NOT NULL
);

CREATE TABLE books (
  id              TEXT PRIMARY KEY,          -- ULID, lexicographically sortable
  r2_key          TEXT NOT NULL,
  format          TEXT NOT NULL,             -- 'epub' | 'cbz' | 'pdf' | 'mobi' | 'azw3' | 'fb2' | 'txt'
  mime            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  content_md5     TEXT,                      -- R2's own checksum; NULL for multipart uploads
  partial_md5     TEXT,                      -- KOReader document hash, primary variant
  partial_md5_alt TEXT,                      -- ... and the ambiguous variant. See PLAN.md section 9.
  title           TEXT NOT NULL,
  sort_title      TEXT NOT NULL,
  series          TEXT,
  series_index    REAL,
  language        TEXT,
  publisher       TEXT,
  published       TEXT,
  isbn            TEXT,
  description     TEXT,
  cover_key       TEXT,
  cover_mime      TEXT,
  indexed         INTEGER NOT NULL DEFAULT 0,  -- 0 = metadata not yet extracted
  index_error     TEXT,
  added_at        INTEGER NOT NULL,
  added_by        TEXT NOT NULL REFERENCES users(id),
  updated_at      INTEGER NOT NULL
);

CREATE INDEX books_added       ON books(added_at DESC);
CREATE INDEX books_sort        ON books(sort_title);
CREATE INDEX books_series      ON books(series, series_index);
CREATE INDEX books_pmd5        ON books(partial_md5);
CREATE INDEX books_pmd5_alt    ON books(partial_md5_alt);
CREATE UNIQUE INDEX books_md5  ON books(content_md5) WHERE content_md5 IS NOT NULL;

CREATE TABLE authors (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  sort_name TEXT NOT NULL
);
CREATE UNIQUE INDEX authors_sort ON authors(sort_name);

CREATE TABLE book_authors (
  book_id   TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, author_id)
);
CREATE INDEX book_authors_author ON book_authors(author_id);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);
CREATE INDEX book_tags_tag ON book_tags(tag_id);

-- kosync progress. `document` is KOReader's own hash, not our book id: a user
-- may sync a book this server has never seen, and that must still work. Any
-- link to books.partial_md5 is best-effort decoration.
CREATE TABLE progress (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document   TEXT NOT NULL,
  percentage REAL NOT NULL,
  progress   TEXT NOT NULL,   -- an XPointer for EPUB, a page number for PDF; always a string
  device     TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  metadata   TEXT,            -- JSON {filename,title,authors}; preserved when a push omits it
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);
CREATE INDEX progress_updated ON progress(user_id, updated_at DESC);

-- Staging for R2 multipart uploads (files above the 100MB request body limit).
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  filename     TEXT NOT NULL,
  parts        TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL
);
CREATE INDEX uploads_created ON uploads(created_at);

-- Sliding-window counters for failed-authentication rate limiting.
CREATE TABLE auth_failures (
  bucket     TEXT NOT NULL,     -- "ip:1.2.3.4" or "user:alice"
  window_at  INTEGER NOT NULL,  -- unix seconds, floored to the window size
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_at)
);
