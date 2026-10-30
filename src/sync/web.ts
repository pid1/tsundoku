import type { Book, ProgressRow } from "../types.js";

/**
 * Reading position for the browser reader, on top of kosync's own table.
 *
 * The web reader is just another device. It writes the same `progress` and
 * `progress_devices` rows KOReader does, under the same document hash, so the
 * position it saves is the one KOReader pulls and the Sync page lists it beside
 * the e-readers. What differs is how it is addressed: the browser holds a book
 * id and a session cookie, not a partial MD5 and an x-auth-key, so these
 * helpers translate.
 */

/** The hashes a device might have filed this book under, primary first. */
export function documentHashes(book: Pick<Book, "partial_md5" | "partial_md5_alt">): string[] {
  const hashes = [book.partial_md5, book.partial_md5_alt].filter((h): h is string => !!h);
  return [...new Set(hashes)];
}

/**
 * The position to resume from: the most recent across both hashes. Both are
 * read because a device that computed the alternative hash files its position
 * there (see src/books/partialmd5.ts), and the latest one is where you are.
 */
export function latestPosition(rows: (ProgressRow | null)[]): ProgressRow | null {
  let best: ProgressRow | null = null;
  for (const row of rows) if (row && (!best || row.updated_at > best.updated_at)) best = row;
  return best;
}

/**
 * Which hash to write under. Whichever one already holds this user's position
 * is the one their other devices read, so keep writing there; with nothing
 * stored yet, the primary, which is what KOReader computes.
 */
export function documentToWrite(hashes: string[], rows: (ProgressRow | null)[]): string | null {
  return latestPosition(rows)?.document ?? hashes[0] ?? null;
}

export interface WebProgress {
  percentage: number;
  progress: string;
  device: string;
  device_id: string;
}

/**
 * Validates a push from the reader. Same rules as kosync's PUT: a percentage,
 * a progress string and a device are all required, and percentage is clamped
 * to [0, 1].
 */
export function parseWebProgress(body: unknown): WebProgress | { error: string } {
  if (!body || typeof body !== "object") return { error: "Expected a JSON object" };
  const input = body as Record<string, unknown>;
  const percentage = Number(input.percentage);
  if (input.percentage === undefined || input.percentage === null || !Number.isFinite(percentage)) {
    return { error: "percentage is required" };
  }
  if (typeof input.progress !== "string" || !input.progress) return { error: "progress is required" };
  if (typeof input.device_id !== "string" || !input.device_id) return { error: "device_id is required" };
  return {
    percentage: Math.min(1, Math.max(0, percentage)),
    progress: input.progress.slice(0, 2000),
    device: typeof input.device === "string" && input.device ? input.device.slice(0, 200) : "Web reader",
    device_id: input.device_id.slice(0, 200),
  };
}
