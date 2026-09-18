import type { RouteContext, Router } from "../router.js";
import type { Principal } from "../auth/index.js";
import { authenticateBasic } from "../auth/index.js";
import { cacheClear } from "../auth/cache.js";
import { MIN_PASSWORD_LENGTH, passwordComplaint, verifiersFor } from "../auth/password.js";
import { clearSessionCookie, mintSession, readSession, sessionCookie } from "../auth/session.js";
import { badRequest, forbidden, json, notFound, problem, tooLarge, tooMany } from "../http/responses.js";
import { indexBook } from "../books/indexer.js";
import {
  createUpload,
  createUser,
  deleteBook,
  deleteUpload,
  deleteUser,
  getBook,
  getBookByContentMd5,
  getUpload,
  getUserById,
  getUserByUsername,
  insertBook,
  listBooks,
  listProgress,
  listUsers,
  reindexBook,
  searchBooks,
  setUploadParts,
  setUserPassword,
  stats,
  updateBook,
  updateUserFields,
  upsertAuthors,
  upsertTags,
} from "../db/queries.js";
import type { SortKey } from "../db/queries.js";
import type { Book } from "../types.js";
import { clampInt, detectFormat, generatePassword, nowSeconds, slugify, sortTitle, titleFromFilename, toHex, ulid } from "../util.js";

async function requireSession(c: RouteContext): Promise<Principal | Response> {
  const session = await readSession(c.env, c.request);
  if (session) return session;
  // Scripts and curl may use Basic against the API too.
  const basic = await authenticateBasic(c.env, c.request);
  if (basic.ok) return basic.principal;
  if (basic.reason === "rate-limited") return tooMany();
  return problem(401, "Sign in required");
}

async function requireAdmin(c: RouteContext): Promise<Principal | Response> {
  const who = await requireSession(c);
  if (who instanceof Response) return who;
  if (who.role !== "admin") return forbidden("Administrator only");
  return who;
}

function decodeFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  try {
    const decoded = decodeURIComponent(header).trim();
    // Reject path separators outright: the key is built from this.
    return decoded.replace(/[/\\]/g, "_").slice(0, 200) || fallback;
  } catch {
    return fallback;
  }
}

function bookKey(id: string, filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "bin";
  return `books/${id}/${slugify(filename.replace(/\.[^.]+$/, ""))}.${ext}`;
}

function newBookRow(args: {
  id: string;
  key: string;
  filename: string;
  size: number;
  contentMd5: string | null;
  userId: string;
}): Book {
  const { format, mime } = detectFormat(args.filename);
  const title = titleFromFilename(args.filename);
  const ts = nowSeconds();
  return {
    id: args.id,
    r2_key: args.key,
    format,
    mime,
    filename: args.filename,
    byte_size: args.size,
    content_md5: args.contentMd5,
    partial_md5: null,
    partial_md5_alt: null,
    title,
    sort_title: sortTitle(title),
    series: null,
    series_index: null,
    language: null,
    publisher: null,
    published: null,
    isbn: null,
    description: null,
    cover_key: null,
    cover_mime: null,
    indexed: 0,
    index_error: null,
    added_at: ts,
    added_by: args.userId,
    updated_at: ts,
  };
}

export function registerApiRoutes(router: Router): void {
  /* ------------------------------- session ------------------------------- */

  router.post("/api/session", async (c) => {
    let body: { username?: string; password?: string };
    try {
      body = (await c.request.json()) as { username?: string; password?: string };
    } catch {
      return badRequest("Malformed JSON");
    }
    if (!body.username || !body.password) return badRequest("Username and password are required");

    // Reuse the Basic path so both surfaces share one rate limiter and cache.
    const credential = btoa(
      String.fromCharCode(...new TextEncoder().encode(`${body.username}:${body.password}`)),
    );
    const probe = new Request(c.request.url, {
      headers: { authorization: `Basic ${credential}`, "cf-connecting-ip": c.request.headers.get("cf-connecting-ip") ?? "" },
    });
    const result = await authenticateBasic(c.env, probe);

    if (!result.ok) {
      if (result.reason === "rate-limited") return tooMany("Too many failed sign-ins. Wait five minutes.");
      if (result.reason === "disabled") return forbidden("This account is disabled");
      return problem(401, "Wrong username or password");
    }

    const token = await mintSession(c.env, result.principal);
    return json(
      { user: result.principal },
      { headers: { "set-cookie": sessionCookie(token), "cache-control": "no-store" } },
    );
  });

  router.delete("/api/session", () =>
    json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } }),
  );

  router.get("/api/me", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    return json({ user: who }, { headers: { "cache-control": "no-store" } });
  });

  /* -------------------------------- books -------------------------------- */

  router.get("/api/books", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    const page = clampInt(c.url.searchParams.get("page"), 1, 10_000, 1);
    const pageSize = clampInt(c.url.searchParams.get("pageSize"), 1, 200, clampInt(c.env.PAGE_SIZE, 1, 200, 50));
    const query = c.url.searchParams.get("q");
    const sortRaw = c.url.searchParams.get("sort");
    const sort: SortKey = sortRaw === "title" || sortRaw === "series" || sortRaw === "author" ? sortRaw : "added";

    const result = query ? await searchBooks(c.env.DB, query, { page, pageSize }) : await listBooks(c.env.DB, { page, pageSize, sort });
    return json(result);
  });

  router.get("/api/books/:id", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    const book = await getBook(c.env.DB, c.params.id);
    return book ? json(book) : notFound("No such book");
  });

  router.patch("/api/books/:id", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    const book = await getBook(c.env.DB, c.params.id);
    if (!book) return notFound("No such book");

    let body: Record<string, unknown>;
    try {
      body = (await c.request.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Malformed JSON");
    }

    const fields: Record<string, unknown> = {};
    const text = (key: string, max = 2000): void => {
      if (!(key in body)) return;
      const value = body[key];
      fields[key] = value === null || value === "" ? null : String(value).slice(0, max);
    };
    text("title", 500);
    text("series", 300);
    text("language", 16);
    text("publisher", 300);
    text("published", 40);
    text("isbn", 20);
    text("description", 8000);

    if (typeof fields.title === "string") fields.sort_title = sortTitle(fields.title);
    if ("series_index" in body) {
      const n = Number(body.series_index);
      fields.series_index = Number.isFinite(n) ? n : null;
    }

    await updateBook(c.env.DB, book.id, fields);
    if (Array.isArray(body.authors)) await upsertAuthors(c.env.DB, book.id, (body.authors as unknown[]).map(String));
    if (Array.isArray(body.tags)) await upsertTags(c.env.DB, book.id, (body.tags as unknown[]).map(String));
    await reindexBook(c.env.DB, book.id);

    return json(await getBook(c.env.DB, book.id));
  });

  router.delete("/api/books/:id", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    const book = await getBook(c.env.DB, c.params.id);
    if (!book) return notFound("No such book");

    // The cover is content-addressed and may be shared with another edition, so
    // it is left to the nightly orphan sweep rather than deleted here.
    await c.env.BOOKS.delete(book.r2_key);
    await deleteBook(c.env.DB, book.id);
    return json({ ok: true });
  });

  router.post("/api/books/:id/index", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    const result = await indexBook(c.env, c.params.id);
    if (!result.ok && result.error === "no such book") return notFound("No such book");
    return json(result);
  });

  /* ------------------------- upload: single shot ------------------------- */

  /**
   * Streams the request body straight into R2 -- the bytes are never buffered
   * in the Worker, which matters with 128MB of memory and a 100MB body limit.
   *
   * Dedupe uses R2's own MD5 checksum rather than a SHA-256 we compute: hashing
   * 95MB in-Worker would blow the 10ms CPU budget, and R2 gives us a checksum
   * for free on non-multipart puts.
   */
  router.post("/api/books", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    if (!c.request.body) return badRequest("Empty body");

    const maxBytes = clampInt(c.env.MAX_UPLOAD_MB, 1, 500, 95) * 1024 * 1024;
    const declared = Number(c.request.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      return tooLarge(`Over ${c.env.MAX_UPLOAD_MB}MB. Use the multipart endpoints at /api/uploads.`);
    }

    const filename = decodeFilename(c.request.headers.get("x-filename"), "upload.bin");
    const id = ulid();
    const key = bookKey(id, filename);

    const object = await c.env.BOOKS.put(key, c.request.body, {
      httpMetadata: { contentType: detectFormat(filename).mime },
    });
    if (!object) return problem(500, "Upload failed");

    const md5 = object.checksums?.md5 ? toHex(object.checksums.md5) : null;
    if (md5) {
      const existing = await getBookByContentMd5(c.env.DB, md5);
      if (existing) {
        await c.env.BOOKS.delete(key);
        return json({ duplicate: true, id: existing.id, title: existing.title }, { status: 409 });
      }
    }

    const row = newBookRow({ id, key, filename, size: object.size, contentMd5: md5, userId: who.userId });
    await insertBook(c.env.DB, row);
    await reindexBook(c.env.DB, id);

    // Index inline so the UI can show the result, but never fail the upload for it.
    let indexResult: Awaited<ReturnType<typeof indexBook>> | null = null;
    try {
      indexResult = await indexBook(c.env, id);
    } catch (e) {
      await updateBook(c.env.DB, id, { indexed: 1, index_error: e instanceof Error ? e.message : String(e) });
    }

    return json({ id, filename, size: object.size, index: indexResult }, { status: 201 });
  });

  /* -------------------------- upload: multipart -------------------------- */

  router.post("/api/uploads", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    let body: { filename?: string };
    try {
      body = (await c.request.json()) as { filename?: string };
    } catch {
      return badRequest("Malformed JSON");
    }
    const filename = decodeFilename(body.filename ?? null, "upload.bin");
    const bookId = ulid();
    const key = bookKey(bookId, filename);

    const multipart = await c.env.BOOKS.createMultipartUpload(key, {
      httpMetadata: { contentType: detectFormat(filename).mime },
    });

    await createUpload(c.env.DB, {
      id: bookId,
      user_id: who.userId,
      r2_key: key,
      r2_upload_id: multipart.uploadId,
      filename,
      parts: "[]",
    });

    return json({ uploadId: bookId, key, partSizeBytes: 50 * 1024 * 1024 }, { status: 201 });
  });

  router.put("/api/uploads/:id/:part", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    const upload = await getUpload(c.env.DB, c.params.id);
    if (!upload) return notFound("No such upload");
    if (upload.user_id !== who.userId && who.role !== "admin") return forbidden();
    if (!c.request.body) return badRequest("Empty part");

    const partNumber = clampInt(c.params.part, 1, 10_000, 0);
    if (partNumber === 0) return badRequest("Part number must be 1 or greater");

    const multipart = c.env.BOOKS.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
    const uploaded = await multipart.uploadPart(partNumber, c.request.body);

    const parts = JSON.parse(upload.parts) as Array<{ partNumber: number; etag: string }>;
    const next = parts.filter((p) => p.partNumber !== partNumber);
    next.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    next.sort((a, b) => a.partNumber - b.partNumber);
    await setUploadParts(c.env.DB, upload.id, JSON.stringify(next));

    return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
  });

  router.post("/api/uploads/:id/complete", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;

    const upload = await getUpload(c.env.DB, c.params.id);
    if (!upload) return notFound("No such upload");
    if (upload.user_id !== who.userId && who.role !== "admin") return forbidden();

    const parts = JSON.parse(upload.parts) as Array<{ partNumber: number; etag: string }>;
    if (parts.length === 0) return badRequest("No parts were uploaded");

    const multipart = c.env.BOOKS.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
    const object = await multipart.complete(parts);
    await deleteUpload(c.env.DB, upload.id);

    // Multipart puts carry no whole-object MD5, so these skip content dedupe.
    const row = newBookRow({
      id: upload.id,
      key: upload.r2_key,
      filename: upload.filename,
      size: object.size,
      contentMd5: null,
      userId: upload.user_id,
    });
    await insertBook(c.env.DB, row);
    await reindexBook(c.env.DB, upload.id);

    let indexResult: Awaited<ReturnType<typeof indexBook>> | null = null;
    try {
      indexResult = await indexBook(c.env, upload.id);
    } catch (e) {
      await updateBook(c.env.DB, upload.id, { indexed: 1, index_error: e instanceof Error ? e.message : String(e) });
    }

    return json({ id: upload.id, size: object.size, index: indexResult }, { status: 201 });
  });

  router.delete("/api/uploads/:id", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    const upload = await getUpload(c.env.DB, c.params.id);
    if (!upload) return notFound("No such upload");
    if (upload.user_id !== who.userId && who.role !== "admin") return forbidden();

    await c.env.BOOKS.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id).abort();
    await deleteUpload(c.env.DB, upload.id);
    return json({ ok: true });
  });

  /* -------------------------------- users -------------------------------- */

  router.get("/api/users", async (c) => {
    const who = await requireAdmin(c);
    if (who instanceof Response) return who;
    const users = await listUsers(c.env.DB);
    return json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        role: u.role,
        disabled: u.disabled,
        created_at: u.created_at,
        password_set_at: u.password_set_at,
      })),
    });
  });

  router.post("/api/users", async (c) => {
    const who = await requireAdmin(c);
    if (who instanceof Response) return who;

    let body: { username?: string; displayName?: string; role?: string; password?: string };
    try {
      body = (await c.request.json()) as typeof body;
    } catch {
      return badRequest("Malformed JSON");
    }

    const username = (body.username ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
      return badRequest("Username must be 2-64 characters of letters, digits, dot, dash or underscore");
    }
    if (await getUserByUsername(c.env.DB, username)) return problem(409, "That username is taken");

    // Generated by default: the verifier is a fast keyed hash, so entropy is
    // what carries the security argument. See PLAN.md section 5.
    const generated = !body.password;
    const password = body.password ?? generatePassword();
    const complaint = passwordComplaint(password);
    if (complaint) return badRequest(complaint);

    const verifiers = await verifiersFor(c.env.PEPPER, username, password);
    const id = await createUser(c.env.DB, {
      username,
      displayName: body.displayName?.slice(0, 200) ?? null,
      role: body.role === "admin" ? "admin" : "reader",
      opdsVerifier: verifiers.opds,
      kosyncVerifier: verifiers.kosync,
    });

    // The only time the plaintext is ever returned. It is not stored.
    return json({ id, username, password: generated ? password : undefined }, { status: 201 });
  });

  router.patch("/api/users/:id", async (c) => {
    const who = await requireAdmin(c);
    if (who instanceof Response) return who;

    const user = await getUserById(c.env.DB, c.params.id);
    if (!user) return notFound("No such user");

    let body: { displayName?: string | null; role?: string; disabled?: boolean; password?: string; generatePassword?: boolean };
    try {
      body = (await c.request.json()) as typeof body;
    } catch {
      return badRequest("Malformed JSON");
    }

    if (user.role === "admin" && body.role === "reader") {
      const admins = (await listUsers(c.env.DB)).filter((u) => u.role === "admin" && !u.disabled);
      if (admins.length <= 1) return badRequest("Cannot demote the last administrator");
    }

    await updateUserFields(c.env.DB, user.id, {
      display_name: body.displayName === undefined ? undefined : body.displayName,
      role: body.role === "admin" || body.role === "reader" ? body.role : undefined,
      disabled: body.disabled === undefined ? undefined : body.disabled ? 1 : 0,
    });

    let issued: string | undefined;
    if (body.password || body.generatePassword) {
      const password = body.password ?? generatePassword();
      const complaint = passwordComplaint(password);
      if (complaint) return badRequest(complaint);
      const verifiers = await verifiersFor(c.env.PEPPER, user.username, password);
      await setUserPassword(c.env.DB, user.id, verifiers.opds, verifiers.kosync);
      if (!body.password) issued = password;
    }

    // Credentials are cached per isolate; a change must not keep working.
    cacheClear();
    return json({ ok: true, password: issued });
  });

  router.delete("/api/users/:id", async (c) => {
    const who = await requireAdmin(c);
    if (who instanceof Response) return who;
    if (who.userId === c.params.id) return badRequest("You cannot delete your own account");

    const user = await getUserById(c.env.DB, c.params.id);
    if (!user) return notFound("No such user");
    await deleteUser(c.env.DB, user.id);
    cacheClear();
    return json({ ok: true });
  });

  /* -------------------------------- misc --------------------------------- */

  router.get("/api/stats", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    const s = await stats(c.env.DB);
    const freeTierBytes = 10 * 1024 * 1024 * 1024;
    return json({
      ...s,
      r2FreeTierBytes: freeTierBytes,
      r2UsedFraction: Number((s.bytes / freeTierBytes).toFixed(4)),
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  });

  router.get("/api/progress", async (c) => {
    const who = await requireSession(c);
    if (who instanceof Response) return who;
    return json({ progress: await listProgress(c.env.DB, who.userId) });
  });
}
