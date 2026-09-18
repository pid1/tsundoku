# tsundoku

> 積ん読 — acquiring books and letting them pile up unread.

An OPDS 1.2 **and** 2.0 catalog, an authenticated upload UI, and a
KOReader-compatible progress sync server. One Cloudflare Worker, one R2 bucket,
one D1 database, inside the free tier.

- **Browse and download** from KOReader, Thorium, FBReader, Panels, or anything
  else that speaks OPDS.
- **Upload through a web UI.** EPUB and CBZ have their metadata and cover art
  read out of the file server-side, without downloading it.
- **Sync reading position** between devices, using KOReader's own kosync
  protocol.

No DRM, no lending, no in-browser reader, no public catalog. Every route except
`/healthcheck` and the login page needs credentials.

[`PLAN.md`](PLAN.md) has the design reasoning, the free-tier arithmetic and the
open questions. This file is how to run it.

## Free tier

| Limit | Free plan | What it means here |
|---|---|---|
| R2 storage | 10 GB-month | **The first ceiling.** Roughly 2,000–5,000 EPUBs, or ~80 comics. Comics are in scope, so this is what you outgrow first. |
| Worker requests | 100,000 / day | Enormous for a household. The UI shell is static assets, which are free and unmetered. |
| Worker CPU | 10 ms / invocation | Shapes the credential design. See [Security](#security). |
| Request body | 100 MB | Files over 95 MB upload via R2 multipart automatically. |
| R2 egress | Free | Why this is on R2 and not S3. |
| D1 | 5 GB, 5M row reads/day, 100k row writes/day | Nowhere near it. |

Figures read from Cloudflare's docs on 2026-09-18. Re-check before relying on
them.

## Setup

Needs Node 22+ and a Cloudflare account.

```bash
git clone https://github.com/pid1/tsundoku && cd tsundoku
npm install
npx wrangler login

./scripts/setup.sh      # bucket, database, migrations, secrets, admin password
npm run deploy
```

`setup.sh` is idempotent and prints the generated admin password at the end.
**Write it down** — see [the admin account](#the-admin-account).

<details>
<summary>Doing it by hand instead</summary>

```bash
npx wrangler r2 bucket create tsundoku
npx wrangler d1 create tsundoku          # put the uuid in wrangler.toml as database_id
npx wrangler d1 migrations apply tsundoku --remote

openssl rand -base64 32 | npx wrangler secret put PEPPER
openssl rand -base64 32 | npx wrangler secret put SESSION_KEY
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD

npm run deploy
```

</details>

A **custom domain is strongly recommended** (uncomment the `[[routes]]` block in
`wrangler.toml`). Some OPDS clients dislike `workers.dev` subdomains, and TLS is
non-negotiable because authentication is HTTP Basic.

### Routine work

```bash
npm run deploy           # wrangler deploy
npm run db:migrate       # apply new migrations
npm run dev              # local dev server
npm run typecheck        # tsc --noEmit
npm test                 # vitest, inside workerd
./scripts/backup.sh      # dump the D1 base tables
```

## Connecting a reader

Replace `books.example.com` with your own address. There is also a `/help.html`
page on the running server with the same instructions.

### KOReader — catalog

**Search** → **OPDS catalog** → **+**

| Field | Value |
|---|---|
| Title | `tsundoku` |
| URL | `https://books.example.com/opds/1.2` |
| Username / Password | your account |

Long-press a book to download it.

### KOReader — progress sync

**Tools** → **More tools** → **Progress sync**

- **Custom sync server**: `https://books.example.com` — the base address, no path.
- Choose **Login**, not Register. Self-registration is disabled and answers 403.
- Set **Document matching method** the same on every device. `binary` is the
  default and the right choice; `filename` breaks the moment you rename a file.
- Enable **Send document metadata** if you want titles shown beside positions.

### Thorium Reader

**Catalogs** → **Add catalog** → `https://books.example.com/opds/2.0`. Thorium
speaks OPDS 2.0, so give it the JSON feed.

### Anything else

FBReader, Moon+ Reader, PocketBook, Panels and Aldiko all speak OPDS 1.2:
`https://books.example.com/opds/1.2`.

### By hand

```bash
curl -i https://books.example.com/opds/1.2                    # 401 + auth document
curl -u you:secret https://books.example.com/opds/1.2
curl -u you:secret -H 'Accept: application/opds+json' \
     https://books.example.com/opds/2.0/new | jq .
curl https://books.example.com/healthcheck
```

## Things that read as bugs but are not

**The admin password does not change when you rotate `ADMIN_PASSWORD`.** That
secret seeds the first administrator on the first request after deploy, and only
while the users table is empty. Afterwards it is ignored forever. Change
passwords on the **Admin** page.

**KOReader's Register button returns 403.** Accounts are created by an
administrator. Set `ALLOW_KOSYNC_REGISTER = "1"` in `wrangler.toml` if you want
the endpoint open, but note that it would create sync-only accounts with no
catalog access.

**Covers and thumbnails are the same image.** Resizing would need Cloudflare
Images, which is not on the free tier. Readers scale client-side.

**A book can appear with its filename as the title.** PDF, MOBI and AZW3 have no
metadata parser here; the edit form is the answer. Any parse failure degrades to
the filename rather than failing the upload, and the reason is shown on the card.

**Uploading the same file twice returns 409, not an error.** Deduplication uses
R2's own MD5 checksum. Multipart uploads carry no whole-object checksum, so files
over 95 MB skip the dedupe check.

## Security

Three client populations, three mechanisms, one credential:

| Surface | Mechanism |
|---|---|
| OPDS feeds, downloads, covers | HTTP **Basic** — the only scheme KOReader's OPDS client speaks |
| Web UI | signed `HttpOnly; Secure; SameSite=Lax` session cookie |
| kosync | `x-auth-user` + `x-auth-key` (md5 of the password), as the protocol dictates |

**Passwords are stored as a peppered keyed hash (HMAC-SHA256), not a slow KDF.**
Basic auth sends credentials on every request, and the free plan's 10 ms CPU cap
does not fit a high-iteration KDF there. The pepper lives in Workers Secrets, not
in D1, so a database leak alone yields nothing crackable. Compensating controls:
no self-signup, a closed user set, generated high-entropy passwords, per-IP and
per-username rate limiting on failed sign-ins, and constant-time comparison.

**This trade is documented, not hidden** — [`PLAN.md` §5](PLAN.md) states it in
full. If you are exposing this to more than a handful of people, read that
section first.

### The PBKDF2 benchmark, measured

Measured 2026-09-18 on a deployed Worker with the harness in
[`test/bench/`](test/bench/), reading `cpuTime` off `wrangler tail` (`Date.now()`
does not advance during compute in Workers, so it cannot measure this):

| PBKDF2-SHA256 iterations | CPU time |
|---|---|
| 1,000 | 0 ms |
| 10,000 | 3 ms |
| 50,000 | 10 ms |
| 100,000 | 22–27 ms |
| 200,000 | **throws** — `Pbkdf2 failed: iteration counts above 100000 are not supported` |
| HMAC-SHA256 × 50 (what we do now) | 0 ms |

Three things fall out, and together they say **keep HMAC**:

1. **workerd caps PBKDF2 at 100,000 iterations.** Above that it throws, so the
   cap is a hard ceiling, not a budget. OWASP currently advises 600,000 for
   PBKDF2-SHA256 — **six times more than a Worker will run at all.** No
   defensible modern KDF count is reachable here on any plan.
2. **Against the free plan's 10 ms, the most that fits with margin is about
   30,000 iterations** (50,000 lands exactly on the cap with none). That is a
   weak KDF, not a good one.
3. **It would buy nothing anyway.** The same password has to stay verifiable by
   a fast keyed hash for Basic and kosync, which send credentials on every
   request. An attacker with the database and the pepper attacks the fast
   verifier and ignores the slow one — the weakest verifier governs. PBKDF2 on
   the sign-in path only would add cost and a schema column for no gain, unless
   Basic and kosync were dropped, which would mean dropping KOReader.

So the design stands, but one premise behind it has changed: see
[`PLAN.md` §5](PLAN.md). The 10 ms cap is **not** what rules PBKDF2 out —
workerd's 100,000 ceiling and the shared-credential argument are.

## Layout

```
src/
  index.ts          fetch + scheduled handlers, admin seeding
  router.ts         path matching
  auth/             password verifiers, Basic, session cookies, isolate cache
  books/            zip reader, XML scanner, EPUB/CBZ metadata, KOReader hash
  db/queries.ts     every SQL statement
  http/             responses, ETags, byte ranges
  opds/             Atom (1.2) and JSON (2.0) serializers, OpenSearch, auth doc
  routes/           opds, content, api, kosync
public/             the UI shell, served as static assets (free, unmetered)
migrations/         D1 schema
scripts/            setup, backup, reindex
test/unit/          vitest, running inside workerd
test/conformance/   checks against a deployed instance
```

The rule: **the pipeline owns the shaping, renderers only display.** An OPDS 1.2
feed, an OPDS 2.0 feed and the UI's JSON are three renderings of one query
result. If a renderer needs to derive something, the column is missing — add it
to the row, not to the template.

## Testing

```bash
npm test                                    # unit, inside workerd
BASE_URL=https://books.example.com \
  TSUNDOKU_USER=you TSUNDOKU_PASS=secret \
  npm run conformance                       # against a deployment
```

Unit tests run in workerd rather than Node, because the ZIP reader depends on
`DecompressionStream` and the kosync hash depends on Cloudflare's non-standard
`crypto.subtle.digest("MD5")`. Testing those against Node polyfills would prove
nothing.

## Known unknowns

1. **The KOReader document hash ambiguity is settled — against LuaJIT, not yet
   against a device.** `bit.lshift(1024, -2)` returns `0` in real LuaJIT (the
   shift count is masked to five bits), so the first sample offset is 0 and
   `partial_md5` is the column KOReader computes. KOReader's loop was
   transcribed into LuaJIT and matched both stored columns byte-for-byte on
   files up to 3.6 MB, and that golden pair is now pinned in
   `test/unit/partialmd5.test.ts`. What is still unconfirmed is what a specific
   KOReader build writes to its sidecar.
   [`test/conformance/partial-md5.md`](test/conformance/partial-md5.md) has both
   the evidence and the remaining device procedure.
2. ~~The PBKDF2-versus-10 ms benchmark has not been run.~~ **Run 2026-09-18** —
   see [Security](#the-pbkdf2-benchmark-measured). The answer is to keep HMAC,
   for a different reason than the plan assumed.
3. **Reader quirks, not specs, are the real compatibility risk.** KOReader has an
   open history of OPDS credential bugs across versions. Test against devices.
4. **OPDS 2.0 client support is thin in practice.** It is built and correct; 1.2
   is what will actually get used.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
