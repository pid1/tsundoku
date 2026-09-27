/**
 * Parsing and comparison of the optional identifier list.
 *
 * Tracks koreader/koreader-sync-server#55, which is open and unmerged, and
 * mirrors its lib/identifiers.lua. A `type` is an opaque label chosen by the
 * client: it is stored and echoed without being interpreted, so a new kind of
 * identifier needs no server change. Pure -- no database, no request.
 */

export interface Identifier {
  type: string;
  value: string;
  /**
   * The client does not consider this identifier enough to claim a record that
   * already exists, so a push that resolves through it alone writes under its
   * own `document` instead. Carried only in a PUT body: adoption is a property
   * of a write, so the read's flattened form has no equivalent.
   */
  weak?: boolean;
}

export const MAX_IDENTIFIERS = 8;
const MAX_TYPE_LENGTH = 32;
const MAX_VALUE_LENGTH = 128;

// Neither may contain the separators used by the stored list or the query
// string. Values become document keys, so they carry a document's restrictions.
const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;
const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/;

function validType(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_TYPE_LENGTH && TYPE_PATTERN.test(v);
}

function validValue(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_VALUE_LENGTH && VALUE_PATTERN.test(v);
}

/** The list, or null when it was malformed. `undefined` in means none offered. */
export function parseList(raw: unknown): Identifier[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDENTIFIERS) return null;

  const list: Identifier[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { type, value, weak } = entry as { type?: unknown; value?: unknown; weak?: unknown };
    if (!validType(type) || !validValue(value)) return null;
    // A `weak` the server cannot read is rejected rather than taken as absent:
    // silently treating a weak identifier as strong is what the flag exists to
    // stop, and it would be invisible to the client that sent it.
    if (weak !== undefined && typeof weak !== "boolean") return null;
    if (seen.has(type)) return null;
    seen.add(type);
    list.push(weak === true ? { type, value, weak: true } : { type, value });
  }
  return list;
}

/**
 * The same list flattened to "type:digest,type:digest". A GET has no body and
 * repeated query parameters are not reliably ordered, so the order lives in one.
 */
export function parseQuery(raw: string): Identifier[] | null {
  if (raw.length === 0) return null;

  const entries = raw.split(",");
  if (entries.length > MAX_IDENTIFIERS) return null;

  const list: Identifier[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const pair = entry.split(":");
    if (pair.length !== 2) return null;
    const [type, value] = pair;
    if (!validType(type) || !validValue(value)) return null;
    if (seen.has(type)) return null;
    seen.add(type);
    list.push({ type, value });
  }
  return list;
}

export function encodeList(list: Identifier[]): string {
  return list.map((i) => `${i.type}:${i.value}`).join(",");
}

export function decodeList(raw: string | null | undefined): Identifier[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return parseQuery(raw);
}

/**
 * How the stored position relates to the copy asking for it: the first
 * identifier the reader offered that the writer also held, in the reader's own
 * order of preference, reported with the reader's own label.
 *
 * Deliberately not the same question as how the document was found. A reader
 * can match a record on its own content digest and still be reading a different
 * edition from the one that wrote the position.
 */
export function common(reader: Identifier[], writer: Identifier[]): string | null {
  const byValue = new Map(writer.map((i) => [i.value, i.type]));
  for (const identifier of reader) {
    if (byValue.has(identifier.value)) return identifier.type;
  }
  return null;
}
