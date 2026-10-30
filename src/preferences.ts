/**
 * Per-user preferences for the web UI.
 *
 * Every value is drawn from a fixed set, and anything outside it is refused
 * rather than stored: the reader turns these straight into CSS, so an unknown
 * value has nothing sensible to become.
 */

/** `publisher` leaves the book's own fonts alone. The rest are served from /fonts. */
export const READER_FONTS = ["publisher", "atkinson-hyperlegible-next"] as const;
export type ReaderFont = (typeof READER_FONTS)[number];

export interface Preferences {
  reader_font: ReaderFont;
}

export const DEFAULT_PREFERENCES: Preferences = { reader_font: "publisher" };

/**
 * Validates a partial update. Keys that are absent keep their current value;
 * a key that is present must carry a legal value.
 */
export function parsePreferences(body: unknown, current: Preferences): Preferences | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object" };
  const input = body as Record<string, unknown>;
  const next = { ...current };

  if ("reader_font" in input) {
    const font = input.reader_font;
    if (typeof font !== "string" || !(READER_FONTS as readonly string[]).includes(font)) {
      return { error: `reader_font must be one of: ${READER_FONTS.join(", ")}` };
    }
    next.reader_font = font as ReaderFont;
  }
  return next;
}
