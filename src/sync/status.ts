import type { DeviceProgressRow } from "../types.js";

/**
 * Two devices are "in sync" when their positions differ by less than this.
 * KOReader pushes a float percentage, and a device that has merely re-rendered
 * the same page can report a value a hair different from the one it received.
 * Half a percent is below anything a reader would call a disagreement.
 */
export const IN_SYNC_EPSILON = 0.005;

export type SyncStatus = "single" | "in-sync" | "diverged";

export interface SyncDevice {
  deviceId: string;
  device: string;
  percentage: number;
  percentLabel: string;
  progress: string;
  updatedAt: number;
  /** Holds the furthest position of any device for this book. */
  isFurthest: boolean;
  /** Pushed most recently of any device for this book. */
  isLatest: boolean;
  /** How far behind the furthest device, in percentage points. 0 when furthest. */
  behindBy: number;
}

export interface SyncBook {
  /** Stable identity for a (user, document) pair. */
  key: string;
  userId: string;
  username: string;
  userLabel: string;
  document: string;
  bookId: string | null;
  title: string;
  /** True when the position could not be matched to a book in the library. */
  unmatched: boolean;
  format: string | null;
  devices: SyncDevice[];
  deviceCount: number;
  furthestPercentage: number;
  furthestLabel: string;
  latestUpdatedAt: number;
  status: SyncStatus;
  /** Gap between the furthest and least-far device, in percentage points. */
  spread: number;
}

const percentLabel = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * KOReader sends `{filename,title,authors}` only when "Send document metadata"
 * is on, so this is a best-effort embellishment, never a requirement.
 */
function titleFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { title?: unknown; filename?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
    if (typeof parsed.filename === "string" && parsed.filename.trim()) return parsed.filename.trim();
  } catch {
    // A malformed blob is not worth failing a page render over.
  }
  return null;
}

/**
 * Fold per-device rows into one entry per book, deciding there and only there
 * whether the devices agree. The page renders this; it derives nothing.
 */
export function groupSyncRows(rows: DeviceProgressRow[]): SyncBook[] {
  const byKey = new Map<string, SyncBook>();

  for (const row of rows) {
    const key = `${row.user_id}:${row.document}`;
    let book = byKey.get(key);

    if (!book) {
      const matchedTitle = row.book_title ?? titleFromMetadata(row.metadata);
      book = {
        key,
        userId: row.user_id,
        username: row.username,
        userLabel: row.display_name || row.username,
        document: row.document,
        bookId: row.book_id,
        title: matchedTitle ?? `Unknown book (${row.document.slice(0, 12)}…)`,
        unmatched: row.book_id === null,
        format: row.book_format,
        devices: [],
        deviceCount: row.device_count,
        furthestPercentage: row.furthest_percentage,
        furthestLabel: percentLabel(row.furthest_percentage),
        latestUpdatedAt: row.latest_updated_at,
        status: "single",
        spread: 0,
      };
      byKey.set(key, book);
    }

    book.devices.push({
      deviceId: row.device_id,
      device: row.device || "Unnamed device",
      percentage: row.percentage,
      percentLabel: percentLabel(row.percentage),
      progress: row.progress,
      updatedAt: row.updated_at,
      isFurthest: row.percentage >= row.furthest_percentage - Number.EPSILON,
      isLatest: row.updated_at === row.latest_updated_at,
      behindBy: Math.max(0, row.furthest_percentage - row.percentage),
    });
  }

  for (const book of byKey.values()) {
    book.devices.sort((a, b) => b.percentage - a.percentage || b.updatedAt - a.updatedAt);
    const values = book.devices.map((d) => d.percentage);
    book.spread = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    book.status =
      book.devices.length < 2 ? "single" : book.spread < IN_SYNC_EPSILON ? "in-sync" : "diverged";
  }

  // Most recently touched book first: that is what you look at a sync page for.
  return [...byKey.values()].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
}

/** The distinct users present in a result set, for the filter control. */
export function usersInRows(rows: DeviceProgressRow[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) seen.set(row.user_id, row.display_name || row.username);
  return [...seen.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
