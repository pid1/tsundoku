import { Router } from "./router.js";
import type { Env } from "./types.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerKosyncRoutes } from "./routes/kosync.js";
import { registerOpdsRoutes } from "./routes/opds.js";
import { securityHeaders } from "./http/responses.js";
import {
  countUsers,
  createUser,
  deleteUpload,
  listStaleUploads,
  pruneAuthFailures,
  referencedCoverKeys,
  stats,
} from "./db/queries.js";
import { verifiersFor } from "./auth/password.js";

const router = new Router();
registerKosyncRoutes(router);
registerOpdsRoutes(router);
registerContentRoutes(router);
registerApiRoutes(router);

/**
 * Seeds the first administrator from ADMIN_USERNAME / ADMIN_PASSWORD, and only
 * while the users table is empty. Rotating those secrets afterwards does NOT
 * change the password -- use the admin UI. This reads as a bug often enough
 * that it is called out in the README.
 */
let seedChecked = false;

async function seedAdmin(env: Env): Promise<void> {
  if (seedChecked) return;
  seedChecked = true;
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return;
  try {
    if ((await countUsers(env.DB)) > 0) return;
    const verifiers = await verifiersFor(env.PEPPER, env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
    await createUser(env.DB, {
      username: env.ADMIN_USERNAME,
      displayName: null,
      role: "admin",
      opdsVerifier: verifiers.opds,
      kosyncVerifier: verifiers.kosync,
    });
    console.log(`seeded administrator ${env.ADMIN_USERNAME}`);
  } catch (e) {
    // A racing isolate may have seeded first; that is not an error worth failing on.
    seedChecked = false;
    console.warn("admin seed skipped:", e instanceof Error ? e.message : String(e));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!env.PEPPER || !env.SESSION_KEY) {
      return new Response(
        "tsundoku is not configured: set the PEPPER and SESSION_KEY secrets.\n" +
          "  openssl rand -base64 32 | npx wrangler secret put PEPPER\n" +
          "  openssl rand -base64 32 | npx wrangler secret put SESSION_KEY\n",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    await seedAdmin(env);

    const matched = router.match(request.method, url.pathname);
    if (matched) {
      try {
        const response = await matched.handler({ request, env, ctx, url, params: matched.params });
        return securityHeaders(response);
      } catch (e) {
        console.error("unhandled error", url.pathname, e);
        return securityHeaders(
          new Response(JSON.stringify({ error: "Internal error" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }

    // Anything the router does not claim is a static asset (the UI shell).
    // Those requests are free and do not count against the 100k/day budget.
    return env.ASSETS.fetch(request);
  },

  /** Nightly housekeeping. See PLAN.md section 11. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(housekeeping(env));
  },
};

async function housekeeping(env: Env): Promise<void> {
  // 1. Abort multipart uploads nobody finished.
  const stale = await listStaleUploads(env.DB, 24 * 60 * 60);
  for (const upload of stale) {
    try {
      await env.BOOKS.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id).abort();
    } catch (e) {
      console.warn("abort failed", upload.id, e instanceof Error ? e.message : String(e));
    }
    await deleteUpload(env.DB, upload.id);
  }

  // 2. Sweep orphaned covers.
  const sweptCovers = await sweepOrphanCovers(env);

  // 3. Drop expired rate-limit counters.
  await pruneAuthFailures(env.DB);

  // 4. Report storage against the free tier, so the ceiling is never a surprise.
  const s = await stats(env.DB);
  const gib = s.bytes / (1024 * 1024 * 1024);
  console.log(
    `housekeeping: ${s.books} books, ${gib.toFixed(2)} GiB of the 10 GiB R2 free tier ` +
      `(${((gib / 10) * 100).toFixed(1)}%), ${s.unindexed} unindexed, ${stale.length} stale uploads aborted, ` +
      `${sweptCovers} orphaned covers swept`,
  );
}

/**
 * Covers are content-addressed, so two editions of the same book share one
 * object and `DELETE /api/books/:id` cannot know whether it was the last
 * referent. It leaves them here instead. Without this, every deleted book
 * leaks its cover into R2 forever -- and storage is the first ceiling (PLAN.md
 * section 4).
 *
 * Only objects older than the grace period are considered, so a cover written
 * moments ago by an upload still finishing is never mistaken for an orphan.
 */
const COVER_SWEEP_GRACE_SECONDS = 24 * 60 * 60;

export async function sweepOrphanCovers(env: Env): Promise<number> {
  const referenced = await referencedCoverKeys(env.DB);
  const cutoff = Date.now() - COVER_SWEEP_GRACE_SECONDS * 1000;
  let swept = 0;
  let cursor: string | undefined;

  do {
    const page = await env.BOOKS.list({ prefix: "covers/", cursor, limit: 1000 });
    const doomed = page.objects
      .filter((o) => !referenced.has(o.key) && o.uploaded.getTime() < cutoff)
      .map((o) => o.key);

    // R2 deletes up to 1000 keys per call, and a page is at most 1000.
    if (doomed.length > 0) {
      try {
        await env.BOOKS.delete(doomed);
        swept += doomed.length;
      } catch (e) {
        console.warn("cover sweep failed", e instanceof Error ? e.message : String(e));
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return swept;
}
