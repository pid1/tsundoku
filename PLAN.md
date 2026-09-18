# tsundoku — project plan

> 積ん読 — acquiring books and letting them pile up unread.
> A single-Worker, free-tier OPDS 1.2 + 2.0 catalog with an authenticated upload
> UI and a KOReader-compatible progress sync server.

**Status: implemented, not yet deployed.** Phases 0-8 are built, typechecked and
unit-tested; nothing has touched a Cloudflare account. Where the implementation
diverged from this plan, the plan has been corrected rather than left to drift --
those points are marked **[changed in build]**.

---

## 1. What it is

One Cloudflare Worker, one R2 bucket, one D1 database, deployed with one
`wrangler deploy`, that does three jobs:

1. **Serves an authenticated OPDS catalog** — both 1.2 (Atom/XML, what every
   reader actually speaks) and 2.0 (JSON), so KOReader, Thorium, FBReader,
   Panels and friends can browse and download.
2. **Accepts uploads through a web UI** — drag an `.epub` in, get metadata and a
   cover extracted server-side, stored in R2, indexed in D1.
3. **Runs a kosync-compatible sync server** — so reading position follows you
   between a Kobo, a phone and a desktop.

It must stay inside the Cloudflare free tier at personal-library scale. Section 4
does that arithmetic.

### Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Name | `tsundoku` | Matches the `kunnandi` precedent on pid1.space — a foreign word with a story behind it. |
| Language | TypeScript, `noEmit`, `@cloudflare/workers-types` | Same shape as `yeet`: wrangler transpiles, no build step, zero runtime dependencies. The OPDS and kosync payloads are fiddly enough to want types. |
| Accounts | Admin-created, no self-signup | One admin seeded from a secret; the admin creates the handful of other users in the UI. kosync's `POST /users/create` is refused. |

### Non-goals

- No DRM, no lending, no LCP, no `borrow`/`buy` acquisition flows.
- No OPDS **publishing** (the PUT-a-book-to-a-catalog draft). Upload is our own
  authenticated API, not a standard one.
- No in-browser reader. The catalog hands you a file; your reader reads it.
- No transcoding, no format conversion, no server-side Calibre.
- No public/anonymous catalog. Every route except `/healthcheck` and the login
  page is authenticated.

---

## 2. Constraints that shape the design

All figures below were read from Cloudflare's own docs on 2026-09-18. They are
load-bearing — re-check them before trusting the budget in §4.

| Limit | Free plan value | Consequence for tsundoku |
|---|---|---|
| Worker requests | 100,000 / day | Generous, but cover thumbnails multiply feed requests. See §4. |
| Worker CPU per invocation | **10 ms** | **The single most design-shaping limit.** Rules out a memory-hard KDF on the hot path. See §5. |
| Worker memory | 128 MB | Never buffer a whole book. Stream, or range-read. |
| Request body size | 100 MB | Files above ~95 MB need R2 multipart. See §7. |
| Subrequests per request | 50 | Fine; we make a handful of R2/D1 calls. |
| Static asset requests | **Free and unlimited**, do not count toward the 100k | Put the entire UI shell in `public/` so browsing the UI is free. |
| R2 storage | 10 GB-month | **The real ceiling on library size** — roughly 2,000–5,000 EPUBs. |
| R2 Class A ops (writes, lists, multipart parts) | 1M / month | Uploads only. Nowhere near it. |
| R2 Class B ops (`GetObject`, `HeadObject`) | 10M / month | Downloads and covers. Nowhere near it. |
| R2 egress | Free | Why this is on R2 and not S3. |
| D1 storage | 5 GB total | Metadata only; irrelevant. |
| D1 rows read | 5M / day | A feed page reads a few hundred rows. Irrelevant. |
| D1 rows written | 100,000 / day | kosync writes a row per progress push. Irrelevant at household scale. |

Two capabilities worth naming because the design leans on them:

- `crypto.subtle.digest('MD5', …)` — a **non-standard Cloudflare extension**.
  kosync's protocol is MD5-based, so this saves vendoring an MD5 implementation.
- `DecompressionStream('deflate-raw')` — supported in workerd. This is what lets
  us read inside an EPUB (a ZIP) without a dependency.

---

## 3. Architecture

```
                        ┌───────────────────────────────────┐
   KOReader ────OPDS────▶│                                   │
   Thorium  ────OPDS────▶│      tsundoku Worker (TS)         │
   Panels   ────OPDS────▶│                                   │
   KOReader ──kosync────▶│  router ─┬─ /opds/1.2/*  (Atom)   │
                         │          ├─ /opds/2.0/*  (JSON)   │
   Browser ──UI/API─────▶│          ├─ /content/*   (stream) │
        │                │          ├─ /covers/*            │
        │                │          ├─ /api/*     (upload)   │
        │                │          └─ kosync routes         │
        ▼                └────┬──────────────────┬───────────┘
   public/ (static assets)    │                  │
   served WITHOUT invoking    │                  │
   the Worker — free          ▼                  ▼
                        ┌──────────┐      ┌─────────────┐
                        │ D1       │      │ R2          │
                        │ metadata │      │ books/      │
                        │ users    │      │ covers/     │
                        │ progress │      │             │
                        │ FTS5     │      │             │
                        └──────────┘      └─────────────┘
```

**The architectural rule:** the Worker owns all classification and shaping. An
OPDS 1.2 feed, an OPDS 2.0 feed and the UI's JSON are three *renderings of one
query result*. A `books` row carries everything a feed needs — title, authors,
series, size, mime, cover key — so a renderer never re-derives a category from a
filename. If a renderer needs to compute something, the column is missing; add it
to the row, not to the template.

### Repo layout

```
tsundoku/
  wrangler.toml
  package.json
  tsconfig.json
  README.md               usage: deploy, add a catalog, point KOReader at it
  PLAN.md                 this file
  migrations/
    0001_init.sql         users, books, authors, tags, progress
    0002_fts.sql          FTS5 virtual table + triggers
  public/                 static assets — free to serve
    index.html            login
    library.html          browse / upload UI shell
    app.js  app.css
  src/
    index.ts              fetch handler + router only
    env.d.ts              Env bindings
    auth/
      password.ts         verifier derivation, constant-time compare
      basic.ts            HTTP Basic for OPDS + content
      session.ts          signed cookie for the UI
      kosync.ts           x-auth-user / x-auth-key
      cache.ts            per-isolate verified-credential cache
    opds/
      atom.ts             OPDS 1.2 serializer
      json.ts             OPDS 2.0 serializer
      opensearch.ts       OpenSearch description + query parsing
      authdoc.ts          application/opds-authentication+json
      feeds.ts            shared feed *queries* (both versions render these)
    books/
      upload.ts           single-shot + multipart
      zip.ts              ZIP central-directory reader over R2 ranges
      epub.ts             OPF metadata + cover extraction
      cbz.ts              filename metadata + first-image cover
      xml.ts              minimal tolerant XML scanner (no DOMParser in Workers)
      partialmd5.ts       KOReader-compatible document hash
    sync/
      kosync.ts           the five kosync routes
    db/
      schema.ts           typed row shapes
      queries.ts          every SQL statement lives here
    http/
      responses.ts  ranges.ts  etag.ts
  test/
    unit/                 vitest + @cloudflare/vitest-pool-workers
    conformance/          scripts run against a deployed instance
```

---

## 4. Free-tier budget

The binding constraints are **R2 storage (10 GB)** and **Worker requests
(100k/day)**. Nothing else comes close.

**Storage.** Average EPUB ≈ 2–5 MB; average CBZ ≈ 60–150 MB. So 10 GB is roughly
2,000–5,000 EPUBs, or ~80 comics. Covers add ~50–150 KB each. *If comics are in
scope, R2 storage is the first thing you will outgrow* — at $0.015/GB-month
beyond the free tier, a 100 GB library is about $1.35/month, which is worth
knowing up front rather than discovering.

**Requests.** The trap is cover art: an acquisition feed page of 50 books is
1 feed request + up to 50 thumbnail requests = 51 Worker invocations. Three
mitigations, all of which we implement:

1. **The UI shell is static assets**, so browsing the web UI costs zero Worker
   requests — only its JSON/API calls count.
2. **Covers are content-addressed and immutable**: `/covers/{sha256-prefix}` with
   `Cache-Control: public, max-age=31536000, immutable` and a strong `ETag`.
   After first fetch, clients and the Cloudflare edge answer themselves.
3. **OPDS feeds send `ETag` + honour `If-None-Match`**, so a reader re-opening an
   unchanged catalog gets a 304 (still one invocation, but ~1 ms of CPU).

Steady state for a household is order 10²–10³ requests/day. The 100k ceiling is
not a real risk; it is documented here so the first person to add a public link
knows what they are spending.

---

## 5. Authentication

Three client populations, three mechanisms, **one credential**.

| Surface | Mechanism | Why not something better |
|---|---|---|
| OPDS feeds, `/content/*`, `/covers/*` | HTTP **Basic** over TLS | KOReader's OPDS client supports Basic only — it has no digest support, because luasocket has none. Basic is the lowest common denominator across every OPDS reader, and it is what the spec's own Basic auth flow describes. |
| Web UI | Signed, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie | Browsers shouldn't hold Basic credentials; a cookie gives us logout and expiry. |
| kosync | `x-auth-user` + `x-auth-key` headers | Dictated by the KOReader client. `x-auth-key` is `md5(password)`, lowercase hex. Not negotiable — it is the protocol. |

### The 10 ms problem

Basic auth sends credentials on **every request**. A memory-hard or
high-iteration KDF on that path will exceed the free plan's 10 ms CPU limit and
the request will be killed. PBKDF2-SHA256 at 100,000 iterations is tens of
milliseconds of native work; it does not fit.

**Design:**

- Store a **peppered keyed verifier**, not a slow hash:
  `opds_verifier = HMAC-SHA256(PEPPER, "opds:" + username + ":" + password)`
  `kosync_verifier = HMAC-SHA256(PEPPER, "kosync:" + username + ":" + md5hex(password))`
  where `PEPPER` is a Worker **secret**, never stored in D1.
- Compare with `crypto.subtle.timingSafeEqual`.
- A **per-isolate LRU cache** maps `SHA-256(Authorization header)` → `{userId,
  expiresAt}` with a short TTL, so a burst of feed + cover requests costs one
  HMAC, not fifty.

**The honest tradeoff:** HMAC is fast, which is the point and also the weakness —
a stolen D1 snapshot *plus* a stolen `PEPPER` would permit fast offline guessing.
Compensating controls, all of which are in scope:

- The pepper lives in Workers Secrets, a different blast radius from the
  database. A D1 leak alone yields nothing crackable.
- No self-signup and a closed user set (§1) means a small, known population.
- **The admin UI generates passwords rather than accepting them** — a
  high-entropy generated passphrase makes offline guessing moot. Typed passwords
  are accepted but length-gated.
- Failed-auth rate limiting (§10).

**Phase 1 gate, not an assumption:** benchmark PBKDF2-SHA256 in a deployed
Worker and find the highest iteration count that fits 10 ms with margin. If a
defensible count fits, use it *for the UI login path only* (cold, once per
session) and keep HMAC for Basic and kosync. Record the measured number in the
README next to the command that produced it. Do not carry a guessed figure
forward.

### Unauthenticated responses

A 401 from any OPDS route returns **both**:

- `WWW-Authenticate: Basic realm="tsundoku"` — so dumb clients prompt; and
- an **Authentication for OPDS 1.0** document as the body, with
  `Content-Type: application/opds-authentication+json`:

```json
{
  "id": "https://tsundoku.example.com/opds/1.2",
  "title": "tsundoku",
  "description": "Sign in with the account you were given.",
  "authentication": [
    { "type": "http://opds-spec.org/auth/basic",
      "labels": { "login": "Username", "password": "Password" } }
  ],
  "links": [
    { "rel": "logo", "href": "https://tsundoku.example.com/logo.png",
      "type": "image/png", "width": 512, "height": 512 },
    { "rel": "help", "href": "https://tsundoku.example.com/help" }
  ]
}
```

The auth document itself must be reachable without authentication.

---

## 6. Data model

### R2

```
books/<book_id>/<slug>.<ext>      the file, exactly as uploaded
covers/<cover_hash>.<ext>         content-addressed, immutable, dedupes reprints
```

`book_id` is a ULID (sortable, no collisions, no coordination). Deleting a book
deletes its `books/` prefix; covers are swept separately since they are shared.

### D1

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'reader',   -- 'admin' | 'reader'
  opds_verifier  BLOB NOT NULL,      -- HMAC(PEPPER, "opds:"+user+":"+pass)
  kosync_verifier BLOB NOT NULL,     -- HMAC(PEPPER, "kosync:"+user+":"+md5(pass))
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  password_set_at INTEGER NOT NULL
);

CREATE TABLE books (
  id           TEXT PRIMARY KEY,           -- ULID
  r2_key       TEXT NOT NULL,
  format       TEXT NOT NULL,              -- 'epub' | 'cbz' | 'pdf' | 'mobi' | ...
  mime         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  content_md5     TEXT,                    -- upload dedupe; see below
  partial_md5     TEXT,                    -- KOReader document hash, primary variant (§9)
  partial_md5_alt TEXT,                    -- ... and the ambiguous variant (§9)
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  series       TEXT,
  series_index REAL,
  language     TEXT,
  publisher    TEXT,
  published    TEXT,                       -- ISO-8601 or year
  isbn         TEXT,
  description  TEXT,
  cover_key    TEXT,                       -- R2 key, NULL if none
  cover_mime   TEXT,
  added_at     INTEGER NOT NULL,
  added_by     TEXT NOT NULL REFERENCES users(id),
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX books_md5 ON books(content_md5) WHERE content_md5 IS NOT NULL;
CREATE INDEX books_added   ON books(added_at DESC);
CREATE INDEX books_sort    ON books(sort_title);
CREATE INDEX books_series  ON books(series, series_index);
CREATE INDEX books_pmd5    ON books(partial_md5);

CREATE TABLE authors (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL);
CREATE UNIQUE INDEX authors_sort ON authors(sort_name);
CREATE TABLE book_authors (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors(id),
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, author_id)
);

CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (book_id, tag_id)
);

-- kosync. `document` is KOReader's hash, NOT our book id — a user may sync a
-- book we have never seen. Linking to books.partial_md5 is best-effort.
CREATE TABLE progress (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document    TEXT NOT NULL,
  percentage  REAL NOT NULL,
  progress    TEXT NOT NULL,     -- XPointer-ish, e.g. "/body/DocFragment[20]/body/p[22]"
  device      TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  metadata    TEXT,              -- JSON: {title, authors, filename} when sent
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);

-- multipart upload staging (§7)
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL, filename TEXT NOT NULL,
  created_at INTEGER NOT NULL, parts TEXT NOT NULL DEFAULT '[]'
);
```

FTS5 (D1 compiles it in) over title, authors, series, tags and description, kept
current with `AFTER INSERT/UPDATE/DELETE` triggers. Note: **D1 export does not
support databases containing virtual tables** — so the backup story in §11 dumps
base tables and rebuilds the index, rather than exporting wholesale.

---

## 7. Upload pipeline

### Path A — files under ~95 MB (all EPUBs, most PDFs)

```
POST /api/books
  Cookie: session=…
  Content-Type: application/epub+zip
  X-Filename: <percent-encoded original name>
  <body = the file>
```

The Worker streams the body straight into `env.BOOKS.put(key, request.body)` —
never buffering it — using `crypto.DigestStream` to compute SHA-256 in flight for
dedupe. This avoids R2 presigned URLs entirely, and therefore avoids issuing an
S3 API token and implementing SigV4. (`yeet` uses presigned URLs because it
accepts 10 GB files; books do not need that.)

### Path B — files over ~95 MB (large CBZ)

R2 multipart through the binding, so there are still no extra credentials:

```
POST   /api/uploads                  -> { uploadId }        createMultipartUpload
PUT    /api/uploads/:id/:partNumber  -> { etag }            uploadPart  (client slices at 50 MB)
POST   /api/uploads/:id/complete     -> { bookId }          completeMultipartUpload
DELETE /api/uploads/:id                                      abortMultipartUpload
```

Parts must be uniform size except the last. `uploads` rows older than 24h are
aborted by a scheduled handler (§11).

### Metadata extraction — the interesting part

Runs **after** the bytes land, as a separate `POST /api/books/:id/index` call
from the UI (so failures are visible and retryable) with `ctx.waitUntil` as a
fallback. It never downloads the whole file. An EPUB is a ZIP, and ZIP is
readable from the tail:

1. **R2 range-read the last 64 KiB** → scan backwards for the End of Central
   Directory signature `PK\x05\x06`; read the central-directory offset and size.
   (Handle ZIP64 and a non-empty archive comment.)
2. **Range-read the central directory** → build `filename → {localOffset,
   compressedSize, uncompressedSize, method}`.
3. **Range-read just `META-INF/container.xml`**, skipping its local file header
   (whose variable-length name/extra fields must be re-read to find the data
   start). Inflate with `DecompressionStream('deflate-raw')` for method 8; take
   raw bytes for method 0.
4. Parse `container.xml` → `<rootfile full-path="…">` → range-read and inflate
   **the OPF** the same way.
5. Parse the OPF `<metadata>`:
   - `dc:title`, `dc:creator` (with `opf:file-as` for sort order and `opf:role`
     to drop illustrators/editors), `dc:language`, `dc:publisher`, `dc:date`,
     `dc:description`, `dc:identifier` (pick the ISBN scheme), `dc:subject` → tags.
   - Series: EPUB2 Calibre style `<meta name="calibre:series" content="…">` +
     `calibre:series_index`; EPUB3 style `<meta property="belongs-to-collection">`
     with a `collection-type` of `series` and `group-position`.
6. **Cover**: `<meta name="cover" content="ID">` → manifest item `href`; or the
   manifest item carrying `properties="cover-image"`. Range-read, inflate, write
   to `covers/<sha256-prefix>.<ext>`.
7. Compute the **KOReader partial MD5** (§9) with targeted range reads.

**XML parsing:** Workers has no `DOMParser`. The OPF is a small, well-known,
namespaced document, so we hand-roll a ~150-line tolerant tag scanner in
`src/books/xml.ts` — handling namespace prefixes, self-closing tags, CDATA,
attribute quoting and the five XML entities plus numeric character references —
rather than taking a dependency. This is the riskiest hand-written component;
it gets the densest unit tests, fed by real-world OPFs from several producers
(Calibre, InDesign, Sigil, Standard Ebooks, Project Gutenberg).

**CBZ:** same ZIP walk; no metadata to read, so title comes from the filename
(with a `Series - 012 - Title` pattern parser) and the cover is the
alphabetically-first image entry.

**PDF/MOBI/AZW3:** indexed by filename only, no cover. Parsing them properly is
out of scope; the fallback is an editable metadata form in the UI, which every
format shares anyway.

**CPU budget check:** everything above is a handful of range reads and small
inflates. The largest single decompression is the cover image, which is
`DecompressionStream` — native, streaming, and written straight to R2 without
being buffered. Should sit well inside 10 ms, but §12 lists it as a thing to
measure rather than assume.

---

## 8. The OPDS surface

Both versions render **the same query results** through different serializers.
Adding a shelf means adding one query, not two endpoints.

### Shared feed structure

```
root
├── New additions        (acquisition, sorted by added_at desc)
├── All books            (acquisition, sorted by sort_title, paged)
├── Authors              (navigation → per-author acquisition)
├── Series               (navigation → per-series acquisition, ordered by index)
├── Tags / subjects      (navigation → per-tag acquisition)
└── Search               (OpenSearch 1.2 / templated link 2.0)
```

### OPDS 1.2 (`/opds/1.2/…`)

Atom/XML. Media types matter more than anything else here — readers dispatch on
them:

| Thing | `type` |
|---|---|
| Navigation feed | `application/atom+xml;profile=opds-catalog;kind=navigation` |
| Acquisition feed | `application/atom+xml;profile=opds-catalog;kind=acquisition` |
| Single entry document | `application/atom+xml;type=entry;profile=opds-catalog` |
| OpenSearch description | `application/opensearchdescription+xml` |

Every entry carries `atom:id`, `atom:title`, `atom:updated`, and at least one
acquisition link. Link rels used:

- `http://opds-spec.org/acquisition` — the download (this is a private catalog,
  so plain acquisition rather than `/open-access`)
- `http://opds-spec.org/image` and `http://opds-spec.org/image/thumbnail`
- `http://opds-spec.org/facet` with `opds:facetGroup`, `opds:activeFacet` and
  `thr:count`
- `search`, `self`, `start`, `up`, and RFC 5005 `next`/`previous`/`first`/`last`

Routes:

```
GET /opds/1.2                      root navigation feed
GET /opds/1.2/new
GET /opds/1.2/books                ?page=&sort=
GET /opds/1.2/authors              navigation
GET /opds/1.2/authors/:id
GET /opds/1.2/series               navigation
GET /opds/1.2/series/:id
GET /opds/1.2/tags                 navigation
GET /opds/1.2/tags/:id
GET /opds/1.2/entry/:bookId        entry document
GET /opds/1.2/search?q=            acquisition feed
GET /opds/1.2/opensearch.xml       description document, {searchTerms} template
```

### OPDS 2.0 (`/opds/2.0/…`)

JSON, same route shapes. `Content-Type: application/opds+json` for feeds,
`application/opds-publication+json` for a single publication.

```json
{
  "metadata": { "title": "New additions", "numberOfItems": 412,
                "itemsPerPage": 50, "currentPage": 1 },
  "links": [
    { "rel": "self", "href": "/opds/2.0/new?page=1", "type": "application/opds+json" },
    { "rel": "next", "href": "/opds/2.0/new?page=2", "type": "application/opds+json" },
    { "rel": "search", "href": "/opds/2.0/search{?query}", "type": "application/opds+json", "templated": true }
  ],
  "publications": [
    {
      "metadata": {
        "@type": "http://schema.org/Book",
        "title": "…", "author": [{ "name": "…", "sortAs": "…" }],
        "identifier": "urn:isbn:…", "language": "en",
        "modified": "2026-09-18T12:00:00Z",
        "belongsTo": { "series": { "name": "…", "position": 3 } }
      },
      "links":  [{ "rel": "http://opds-spec.org/acquisition",
                   "href": "/content/01J…/book.epub",
                   "type": "application/epub+zip" }],
      "images": [{ "href": "/covers/ab12….jpg", "type": "image/jpeg",
                   "width": 1400, "height": 2100 }]
    }
  ]
}
```

`/opds` (no version) content-negotiates on `Accept` and 302s to the right one,
defaulting to 1.2 — because that is what the installed base actually speaks.

### Content and covers

```
GET /content/:bookId/:filename     streams from R2; supports Range; strong ETag
GET /covers/:coverKey              immutable, max-age=31536000
```

Range support matters: some readers fetch partially, and it keeps large CBZ
downloads resumable. `R2ObjectBody` supports range reads directly, so this is a
pass-through, not a buffer.

---

## 9. kosync server

Mirrors the protocol as KOReader's own client implements it, taken from
`plugins/kosync.koplugin/api.json` and `KOSyncClient.lua`.

Every authenticated request carries:

```
accept: application/vnd.koreader.v1+json
x-auth-user: <username>
x-auth-key:  <md5(password), lowercase hex>
```

| Method | Path | Body | Success | Our behaviour |
|---|---|---|---|---|
| `GET` | `/healthcheck` | — | `200 {"state":"OK"}` | Unauthenticated. |
| `POST` | `/users/create` | `{username, password}` (already MD5'd) | `201` / `402` taken | **`403`** — no self-signup. Documented so it is not read as a bug. |
| `GET` | `/users/auth` | — | `200 {"authorized":"OK"}` / `401` | Verify against `kosync_verifier`. |
| `PUT` | `/syncs/progress` | `{document, progress, percentage, device, device_id, metadata?}` | `200 {document, timestamp}` | Upsert on `(user_id, document)`. |
| `GET` | `/syncs/progress/:document` | — | `200 {document, progress, percentage, device, device_id, timestamp}` | `200` with an empty body if unknown. |

Notes that will bite if ignored:

- `progress` arrives as a **string** (`tostring(progress)` client-side) even when
  it looks numeric — it is an XPointer for EPUB and a page number for PDF.
  Store and return it as a string.
- `percentage` is a float 0–1.
- `metadata` (filename, title, authors) is only sent when "Send document
  metadata" is enabled. **Preserve previously stored metadata when it is
  omitted** — do not null it out on every push.
- KOReader's update timeouts are tight (2 s / 5 s). Keep the PUT path to one D1
  upsert; do no metadata enrichment inline.

### The document hash — a verification gate, not an assumption

`document` is KOReader's *partial* MD5: 1024-byte samples taken at
exponentially-spaced offsets, concatenated and hashed. From `frontend/util.lua`:

```lua
local step, size = 1024, 1024
local update = md5()
for i = -1, 10 do
    file:seek("set", lshift(step, 2*i))
    local sample = file:read(size)
    if sample then update(sample) else break end
end
```

Offsets are `1024 * 4^i`, i.e. 1024, 4096, 16384, 65536, 262144, 1 Mi, 4 Mi,
16 Mi, 64 Mi, 256 Mi, 1 Gi — **plus an `i = -1` term whose value is ambiguous**:
read arithmetically it is 256, but LuaJIT's `bit.lshift` masks the shift count to
5 bits, so `lshift(1024, -2)` becomes `1024 << 30`, which overflows 32 bits to
**0**. These give different hashes and I have not resolved which one runs.

**[changed in build] Both candidates are computed and stored**, in
`partial_md5` (offset 0) and `partial_md5_alt` (offset 256), and lookups match on
either column. This turns the ambiguity from a blocking question into one extra
`TEXT` column: nothing waits on the answer, and whichever reading KOReader
actually produces, the match works.

**Still verify it empirically.** Take a real EPUB, open it in KOReader, read
`partial_md5_checksum` out of the sidecar `<book>.sdr/metadata.epub.lua`, and see
which column it matches. The procedure is written up in
`test/conformance/partial-md5.md`, which also holds the table to record the
answer in.

Getting this right buys a genuinely nice feature — the web UI can show "you're
64% through this" next to a book, and the OPDS 2.0 feed can carry position — but
it is a bonus. **Sync works without it**, because kosync only ever needs the hash
to match *between the user's own devices*; the server just stores whatever string
it is given. Keep that decoupling in the code, so a wrong hash degrades the UI
rather than breaking sync.

---

## 10. Web UI

Static shell in `public/` (free to serve), talking to a small JSON API.

| Page | Contents |
|---|---|
| `/` | Login. Posts to `/api/session`, receives the cookie. |
| `/library` | Grid or list, cover art, search box, filters by author/series/tag, per-book download and edit. |
| `/upload` | Drag-and-drop, multi-file queue, per-file progress, auto-chunking above 95 MB, post-upload metadata review before commit. |
| `/admin` | Users (create, disable, reset password, generated passphrases), storage used vs the 10 GB free tier, orphaned-object sweep. |

No framework, no bundler — plain ES modules and CSS, in the spirit of `yeet`'s
inline UI but split into real files since this one is larger. `twobraincells`
is the obvious candidate for the stylesheet.

API surface:

```
POST   /api/session            login          DELETE /api/session   logout
GET    /api/books              list/search    GET    /api/books/:id
PATCH  /api/books/:id          edit metadata  DELETE /api/books/:id
POST   /api/books              upload (§7)    POST   /api/books/:id/index
POST   /api/books/:id/cover    replace cover
GET    /api/users              admin only     POST   /api/users
PATCH  /api/users/:id          admin only     DELETE /api/users/:id
GET    /api/stats              storage, counts, free-tier headroom
```

**Rate limiting.** Failed authentications on `/api/session`, `/users/auth` and
Basic-auth routes are counted per-IP and per-username. First choice is
Cloudflare's Workers rate-limiting binding — *verify its free-plan availability
during Phase 1*; fall back to a D1 counter table with a sliding window, which
costs one row write per failure and is well inside the 100k/day budget.

---

## 11. Operations

- **Scheduled handler** (Cron Trigger, free): nightly — abort `uploads` rows
  older than 24 h, sweep R2 objects with no `books` row and `books` rows with no
  R2 object, rebuild FTS if a drift check fails, and log storage used.
- **Backups**: `wrangler d1 export` on the base tables (**not** the FTS virtual
  table — D1 export refuses databases containing virtual tables, so the dump
  script must exclude it and the restore script must recreate it from
  `0002_fts.sql`). R2 is the durable copy of the books themselves.
- **Observability**: `[observability] enabled = true` in `wrangler.toml` for
  Workers Logs. A `/healthcheck` that returns kosync's `{"state":"OK"}` doubles
  as an uptime-monitor target.

---

## 12. Build phases

Each phase ends in something deployable and testable. Phases 4–6 are independent
of each other and can be reordered.

| Phase | Deliverable | Done when |
|---|---|---|
| **0 — Scaffold** | `wrangler.toml`, `tsconfig.json`, router, `Env` types, migrations 0001+0002, `/healthcheck` | `wrangler deploy` succeeds; `/healthcheck` returns `{"state":"OK"}`. |
| **1 — Auth** | All three surfaces, admin seeding from secrets, isolate cache, rate limiting | **PBKDF2-vs-10 ms benchmark run and its result written into the README.** Basic auth rejected/accepted correctly; timing-safe compare verified. |
| **2 — Storage + UI shell** | Single-shot and multipart upload, `/content/*` with Range, login + library pages | A 4 MB EPUB and a 400 MB CBZ both upload and download intact (byte-compare SHA-256). |
| **3 — Metadata** | ZIP reader, OPF parser, cover extraction, CBZ fallback, edit form | A corpus of ≥20 EPUBs from varied producers extracts title/author/series/cover correctly; failures degrade to filename, never 500. |
| **4 — OPDS 1.2** | Atom serializer, all feeds, facets, paging, OpenSearch | KOReader **and** Thorium both browse, search and download. Validated against an OPDS validator. |
| **5 — OPDS 2.0** | JSON serializer, same feeds, templated search | Feeds parse as valid OPDS 2.0; Thorium (or another 2.0 client) browses them. |
| **6 — kosync** | Five routes, `progress` table, partial-MD5 | Two real KOReader devices sync position through it. **Partial-MD5 gate (§9) passes.** |
| **7 — Search & polish** | FTS5 + triggers, facets, sort options, admin page, stats | Search returns sane results for title, author and series across the corpus. |
| **8 — Hardening** | Cron sweeps, backup/restore scripts, README, conformance suite | Restore from backup into a fresh D1 reproduces the catalog. |

### Testing

- **Unit** (`vitest` + `@cloudflare/vitest-pool-workers`, which runs tests inside
  workerd so `DecompressionStream`, `crypto.subtle.digest('MD5')` and the D1/R2
  bindings are the real ones; note that 0.22 replaced `defineWorkersConfig` with
  a `cloudflareTest` Vite plugin, and its bundled workerd sets a ceiling on
  `compatibility_date`): XML scanner, ZIP reader, OPF field extraction,
  partial-MD5 vectors, OPDS serializers against golden files, kosync
  request/response shapes.
- **Integration**: full upload → index → appears in feed → downloads byte-identical.
- **Conformance** (`test/conformance/`, run against a deployed instance): a
  scripted OPDS crawl asserting media types and rels; a scripted kosync session
  replaying exactly what `KOSyncClient.lua` sends.
- **Manual matrix**, because client quirks are the actual risk: KOReader
  (OPDS + sync), Thorium, FBReader, Panels, and `curl`.

---

## 13. Deploy

### One-time setup

```bash
git clone … tsundoku && cd tsundoku
npm install
npx wrangler login

# Storage. These cannot be created by `wrangler deploy`, so setup is two steps,
# not one — the "single deploy" promise applies to every deploy after this.
npx wrangler r2 bucket create tsundoku
npx wrangler d1 create tsundoku         # copy the returned database_id into wrangler.toml

# Schema
npx wrangler d1 migrations apply tsundoku --remote

# Secrets
openssl rand -base64 32 | npx wrangler secret put PEPPER
openssl rand -base64 32 | npx wrangler secret put SESSION_KEY
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD     # or use the generated-passphrase flow

npm run deploy
```

On first request after deploy, the Worker seeds the admin user from
`ADMIN_USERNAME`/`ADMIN_PASSWORD` if the `users` table is empty, then ignores
those secrets forever after. (Explicitly: rotating `ADMIN_PASSWORD` does **not**
change the password; use the admin UI. This will be in the README, because it is
exactly the kind of thing that reads as a bug.)

### `wrangler.toml`

```toml
name = "tsundoku"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "404-page"

[[r2_buckets]]
binding = "BOOKS"
bucket_name = "tsundoku"

[[d1_databases]]
binding = "DB"
database_name = "tsundoku"
database_id = "<from wrangler d1 create>"

[triggers]
crons = ["17 4 * * *"]

[observability]
enabled = true

[vars]
CATALOG_TITLE = "tsundoku"
PAGE_SIZE = "50"
MAX_UPLOAD_MB = "95"

# Custom domain — strongly recommended. Some OPDS clients are unhappy with
# workers.dev subdomains, and TLS is non-negotiable because auth is Basic.
# [[routes]]
# pattern = "books.example.com"
# custom_domain = true
```

### Routine deploys

```bash
npm run deploy            # wrangler deploy
npm run db:migrate        # wrangler d1 migrations apply tsundoku --remote
npm run dev               # wrangler dev --remote
```

---

## 14. Usage

### KOReader — catalog

`Search` → `OPDS catalog` → `+` →

- **Title**: tsundoku
- **URL**: `https://books.example.com/opds/1.2`
- **Username** / **Password**: your account

Long-press a book to download; it lands in your configured download directory.

### KOReader — progress sync

`Tools` → `More tools` → `Progress sync` →

- **Custom sync server**: `https://books.example.com`  ← base URL, no path
- **Login** with your existing account. **Do not tap Register** — self-signup is
  disabled and it will return 403.
- Set `Document matching method` identically on every device (`binary` is the
  default and the right choice; `filename` breaks if you rename files).
- Enable `Send document metadata` if you want the web UI to show titles next to
  positions.

### Thorium Reader

`Catalogs` → `Add catalog` → the same URL. Thorium speaks OPDS 2.0, so
`https://books.example.com/opds/2.0` is the better one to give it.

### Uploading

Browse to `https://books.example.com/`, log in, drag files onto `/upload`.
Metadata is extracted automatically; review and correct it before committing.

### Checking it by hand

```bash
# Auth document (unauthenticated)
curl -i https://books.example.com/opds/1.2

# Root feed
curl -u user:pass https://books.example.com/opds/1.2

# OPDS 2.0
curl -u user:pass -H 'Accept: application/opds+json' \
     https://books.example.com/opds/2.0/new | jq .

# kosync
curl https://books.example.com/healthcheck
curl -H "x-auth-user: user" -H "x-auth-key: $(printf %s 'pass' | md5)" \
     https://books.example.com/users/auth
```

---

## 15. Risks and open questions

**Verify before relying on it.** In rough order of how much they would hurt:

1. **The partial-MD5 `i = -1` ambiguity (§9).** Unresolved. Gate on an empirical
   test against a KOReader-generated sidecar before shipping Phase 6. Sync itself
   does not depend on it; the UI nicety does.
2. **PBKDF2 within 10 ms CPU (§5).** Unmeasured. The design does not *depend* on
   PBKDF2 fitting — HMAC + pepper is the plan — but the benchmark decides whether
   the login path can do better, and the measured number belongs in the README
   next to the command that produced it.
3. **Hand-written XML parsing.** The highest-defect-density component. Mitigated
   by a real-world OPF corpus in the test suite and a hard rule that a parse
   failure degrades to filename metadata rather than a 500.
4. **Reader quirks are the real compatibility risk**, not the specs. KOReader has
   an open history of OPDS credential bugs across versions. Budget time in Phase
   4 for testing against actual devices, not just validators.
5. **Workers rate-limiting binding on the free plan** — availability unverified.
   D1 fallback is designed in, so this is a preference, not a blocker.
6. **R2's 10 GB is the first ceiling you will hit** if comics are in scope (§4).
   Decide now whether CBZ is in or out; it changes the storage story completely.
7. **OPDS 2.0 client support is thin in practice.** Building it is cheap once the
   queries exist, but do not expect it to be the surface that gets used — 1.2 is
   what the installed base speaks. Build 1.2 first (Phase 4 before Phase 5).
8. **`crypto.subtle.digest('MD5')` is a non-standard Cloudflare extension.** It
   works today; if it were ever withdrawn, kosync breaks. A vendored ~40-line MD5
   is the escape hatch and is cheap to add pre-emptively.
9. **Free-tier figures are dated 2026-09-18.** Cloudflare changes them. Re-read
   the limits pages before treating §4 as current.

---

## 16. Sources

- [awesome-opds](https://github.com/opds-community/awesome-opds) — client and server landscape
- [OPDS 1.2 specification](https://specs.opds.io/opds-1.2)
- [OPDS 2.0 specification](https://specs.opds.io/opds-2.0.html)
- [Authentication for OPDS 1.0](https://drafts.opds.io/authentication-for-opds-1.0.html)
- [koreader/koreader-sync-server](https://github.com/koreader/koreader-sync-server) — reference kosync implementation
- [KOReader `kosync.koplugin/api.json`](https://github.com/koreader/koreader/blob/master/plugins/kosync.koplugin/api.json) — authoritative endpoint list
- [KOReader `frontend/util.lua`](https://github.com/koreader/koreader/blob/master/frontend/util.lua) — `partialMD5`
- [KOReader OPDS authentication issue #4076](https://github.com/koreader/koreader/issues/4076) — Basic only, no digest
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Workers web standards (Compression Streams)](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
