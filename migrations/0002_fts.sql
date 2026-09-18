-- Full-text search. D1 compiles FTS5 in.
--
-- This is a standalone (content-carrying) FTS5 table rather than an external
-- content table with triggers, because the indexed text spans four base tables
-- (books, authors, book_authors, tags) and six triggers would be harder to
-- reason about than one explicit reindex call in src/db/queries.ts.
--
-- Backup note: `wrangler d1 export` refuses a database containing virtual
-- tables. scripts/backup.sh dumps the base tables only; restore replays this
-- migration and then rebuilds the index. See PLAN.md section 11.

CREATE VIRTUAL TABLE books_fts USING fts5(
  book_id UNINDEXED,
  title,
  authors,
  series,
  tags,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);
