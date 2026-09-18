#!/usr/bin/env bash
# Rebuilds the FTS5 index from the base tables, after a restore.
#
# Kept as SQL rather than an API sweep so it does not need the Worker to be up.
set -euo pipefail

NAME="${TSUNDOKU_NAME:-tsundoku}"

npx --yes wrangler d1 execute "$NAME" --remote --command "
DELETE FROM books_fts;
INSERT INTO books_fts (book_id, title, authors, series, tags, description)
SELECT b.id,
       b.title,
       COALESCE((SELECT group_concat(a.name, ' ')
                   FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                  WHERE ba.book_id = b.id), ''),
       COALESCE(b.series, ''),
       COALESCE((SELECT group_concat(t.name, ' ')
                   FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
                  WHERE bt.book_id = b.id), ''),
       COALESCE(substr(b.description, 1, 4000), '')
  FROM books b;
"

echo "search index rebuilt"
