#!/usr/bin/env bash
# Dumps the D1 base tables.
#
# `wrangler d1 export` refuses a database that contains virtual tables, and
# migration 0002 creates the books_fts FTS5 table. So this exports the base
# tables by name; restore replays the migrations and then rebuilds the index by
# calling POST /api/books/:id/index, or by re-running the reindex query.
set -euo pipefail

NAME="${TSUNDOKU_NAME:-tsundoku}"
OUT="${1:-backups/tsundoku-$(date -u +%Y%m%dT%H%M%SZ).sql}"
TABLES="users books authors book_authors tags book_tags progress uploads"

mkdir -p "$(dirname "$OUT")"

ARGS=""
for table in $TABLES; do
  ARGS="$ARGS --table $table"
done

# shellcheck disable=SC2086
npx --yes wrangler d1 export "$NAME" --remote --output "$OUT" $ARGS

echo "wrote $OUT"
echo
echo "The books themselves live in R2 and are not in this dump."
echo "To restore: wrangler d1 migrations apply $NAME --remote"
echo "            wrangler d1 execute $NAME --remote --file $OUT"
echo "            then rebuild search with scripts/reindex.sh"
