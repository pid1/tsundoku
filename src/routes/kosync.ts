import type { Router } from "../router.js";
import type { RouteContext } from "../router.js";
import { authenticateKosync } from "../auth/index.js";
import { kosyncJson } from "../http/responses.js";
import { getBookByPartialMd5, getProgress, putProgress } from "../db/queries.js";

/**
 * KOReader progress sync.
 *
 * The shapes here are dictated by KOReader's own client -- see
 * plugins/kosync.koplugin/api.json and KOSyncClient.lua. Every authenticated
 * call carries `x-auth-user` and `x-auth-key` (md5 of the password) and expects
 * `application/vnd.koreader.v1+json` back.
 *
 * KOReader's update timeouts are 2s/5s, so the PUT path does exactly one D1
 * upsert and no enrichment.
 */

interface ProgressPayload {
  document?: unknown;
  progress?: unknown;
  percentage?: unknown;
  device?: unknown;
  device_id?: unknown;
  metadata?: unknown;
}

/**
 * kosync error codes. KOReader's client switches on the numeric `code`, not on
 * the message, so an error body without one degrades to a generic failure in
 * the UI. The numbers and their statuses come from the reference server's
 * config/errors.lua; see SPEC.md section 6.1 in pid1/kosync-conformance.
 */
const ERR = {
  unauthorized: { code: 2001, status: 401 },
  invalidFields: { code: 2003, status: 403 },
  documentMissing: { code: 2004, status: 403 },
  registrationDisabled: { code: 2005, status: 402 },
} as const;

function kosyncError(err: { code: number; status: number }, message: string): Response {
  return kosyncJson({ code: err.code, message }, err.status);
}

function unauthorized(): Response {
  return kosyncError(ERR.unauthorized, "Unauthorized");
}

async function requireUser(c: RouteContext): Promise<{ userId: string } | Response> {
  const result = await authenticateKosync(c.env, c.request);
  if (result.ok) return { userId: result.principal.userId };
  if (result.reason === "rate-limited") return kosyncJson({ message: "Too many requests" }, 429);
  return unauthorized();
}

export function registerKosyncRoutes(router: Router): void {
  router.get("/healthcheck", () => kosyncJson({ state: "OK" }));

  /**
   * Self-registration. Closed by default: accounts are created by an admin in
   * the web UI, so KOReader's Register button answers 403 rather than silently
   * doing nothing. Set ALLOW_KOSYNC_REGISTER=1 to open it, which creates a
   * sync-only account with no catalog access.
   */
  router.post("/users/create", (c) => {
    if (c.env.ALLOW_KOSYNC_REGISTER !== "1") {
      return kosyncError(
        ERR.registrationDisabled,
        "Registration is disabled. Ask the library administrator for an account.",
      );
    }
    return kosyncJson({ message: "Registration is not implemented; ask the administrator." }, 403);
  });

  router.get("/users/auth", async (c) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    return kosyncJson({ authorized: "OK" });
  });

  router.put("/syncs/progress", async (c) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;

    let payload: ProgressPayload;
    try {
      payload = (await c.request.json()) as ProgressPayload;
    } catch {
      return kosyncJson({ message: "Malformed JSON" }, 400);
    }

    const document = typeof payload.document === "string" ? payload.document.trim() : "";
    if (!document) return kosyncError(ERR.documentMissing, "Field 'document' is required");

    // The reference server stores a position only when percentage, progress and
    // device are all present (`if percentage and progress and device then`) and
    // answers 2003 otherwise. Accepting a partial push stored a position no
    // client had actually reported. Presence is what is tested, not truthiness:
    // a percentage of 0 and a progress of "0" are both legal values, and the
    // reference accepts them because only nil is falsy in Lua.
    const present = (v: unknown) => v !== undefined && v !== null;
    const percentageRaw = Number(payload.percentage);
    if (!present(payload.percentage) || !Number.isFinite(percentageRaw) || !present(payload.progress) || !present(payload.device)) {
      return kosyncError(ERR.invalidFields, "Fields 'percentage', 'progress' and 'device' are required");
    }

    // `progress` is a string even when it looks numeric: an XPointer for EPUB,
    // a page number for PDF. Coercing it to a number loses EPUB positions.
    const progress = String(payload.progress);
    const percentage = Math.min(1, Math.max(0, percentageRaw));

    const metadata =
      payload.metadata && typeof payload.metadata === "object"
        ? JSON.stringify(payload.metadata).slice(0, 4000)
        : null;

    const timestamp = await putProgress(c.env.DB, {
      user_id: who.userId,
      document,
      percentage,
      progress,
      device: typeof payload.device === "string" ? payload.device.slice(0, 200) : "",
      device_id: typeof payload.device_id === "string" ? payload.device_id.slice(0, 200) : "",
      metadata,
    });

    return kosyncJson({ document, timestamp });
  });

  router.get("/syncs/progress/:document", async (c) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;

    const row = await getProgress(c.env.DB, who.userId, c.params.document);
    // KOReader treats an empty 200 as "nothing stored yet", which is the honest
    // answer for a book this device has read but never pushed.
    if (!row) return kosyncJson({});

    return kosyncJson({
      document: row.document,
      progress: row.progress,
      percentage: row.percentage,
      device: row.device,
      device_id: row.device_id,
      timestamp: row.updated_at,
    });
  });

  /**
   * Not part of the kosync protocol: lets the web UI show reading position
   * beside a book. Best-effort, because the document hash match depends on the
   * partial-MD5 question in src/books/partialmd5.ts.
   */
  router.get("/api/progress/:document", async (c) => {
    const who = await requireUser(c);
    if (who instanceof Response) return who;
    const row = await getProgress(c.env.DB, who.userId, c.params.document);
    const book = await getBookByPartialMd5(c.env.DB, c.params.document);
    return kosyncJson({ progress: row, book: book ? { id: book.id, title: book.title } : null });
  });
}
