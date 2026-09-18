#!/usr/bin/env bash
# One-time Cloudflare setup. Everything here needs credentials; `npm run deploy`
# afterwards does not.
#
# Safe to re-run: each step checks before it creates.
set -euo pipefail

NAME="${TSUNDOKU_NAME:-tsundoku}"
WRANGLER="npx --yes wrangler"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking you are logged in"
$WRANGLER whoami >/dev/null || { echo "Run: npx wrangler login"; exit 1; }

say "R2 bucket: $NAME"
if $WRANGLER r2 bucket list 2>/dev/null | grep -qE "(^|[[:space:]])${NAME}([[:space:]]|$)"; then
  echo "already exists"
else
  $WRANGLER r2 bucket create "$NAME"
fi

say "D1 database: $NAME"
if $WRANGLER d1 list --json 2>/dev/null | grep -q "\"name\": *\"${NAME}\""; then
  echo "already exists"
else
  $WRANGLER d1 create "$NAME"
fi

DB_ID="$($WRANGLER d1 list --json 2>/dev/null \
  | tr -d ' \n' \
  | grep -o "\"uuid\":\"[^\"]*\",\"name\":\"${NAME}\"" \
  | head -1 | cut -d'"' -f4 || true)"

if [ -z "$DB_ID" ]; then
  echo
  echo "Could not read the database id automatically."
  echo "Run: npx wrangler d1 list"
  echo "then put the uuid into wrangler.toml as database_id."
else
  say "Writing database_id into wrangler.toml"
  if grep -q 'database_id = "REPLACE_ME"' wrangler.toml; then
    # BSD and GNU sed disagree about -i; write through a temp file instead.
    sed "s/database_id = \"REPLACE_ME\"/database_id = \"${DB_ID}\"/" wrangler.toml > wrangler.toml.tmp
    mv wrangler.toml.tmp wrangler.toml
    echo "set to ${DB_ID}"
  else
    echo "already set; leaving it alone"
  fi
fi

say "Applying migrations"
$WRANGLER d1 migrations apply "$NAME" --remote

say "Secrets"
echo "PEPPER and SESSION_KEY are generated here and never printed."
echo "Rotating PEPPER invalidates every stored password."
echo "Rotating SESSION_KEY signs everyone out."
openssl rand -base64 32 | $WRANGLER secret put PEPPER
openssl rand -base64 32 | $WRANGLER secret put SESSION_KEY

ADMIN_USER="${TSUNDOKU_ADMIN:-admin}"
ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
printf '%s' "$ADMIN_USER" | $WRANGLER secret put ADMIN_USERNAME
printf '%s' "$ADMIN_PASS" | $WRANGLER secret put ADMIN_PASSWORD

say "Done"
cat <<SUMMARY
Deploy with:   npm run deploy

Then sign in at your Worker's URL as:

  username: ${ADMIN_USER}
  password: ${ADMIN_PASS}

Write that down now. The admin account is seeded on the first request after
deploy, only while the users table is empty. Changing ADMIN_PASSWORD later does
NOT change the password -- use the admin page.
SUMMARY
