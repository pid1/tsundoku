import { attr, deepText, findAll, findFirst, parseXml } from "./xml.js";
import type { XmlNode } from "./xml.js";
import { findEntry, readCentralDirectory, readEntry, readEntryText } from "./zip.js";
import type { RangeReader, ZipEntry } from "./zip.js";

export interface CoverImage {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export interface ExtractedMetadata {
  title?: string;
  authors: string[];
  language?: string;
  publisher?: string;
  published?: string;
  isbn?: string;
  description?: string;
  subjects: string[];
  series?: string;
  seriesIndex?: number;
  cover?: CoverImage;
}

const MAX_COVER_BYTES = 6 * 1024 * 1024;

/** Resolves an OPF-relative href against the OPF's own directory. */
export function resolvePath(base: string, href: string): string {
  const cleaned = href.split("#")[0].split("?")[0];
  if (cleaned.startsWith("/")) return cleaned.slice(1);
  const baseDir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  const parts = (baseDir ? baseDir.split("/") : []).concat(cleaned.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export async function extractEpub(reader: RangeReader): Promise<ExtractedMetadata> {
  const entries = await readCentralDirectory(reader);

  const containerEntry = findEntry(entries, "META-INF/container.xml");
  if (!containerEntry) throw new Error("epub: no META-INF/container.xml");
  const container = parseXml(await readEntryText(reader, containerEntry));

  const rootfile = findAll(container, "rootfile").find((r) => attr(r, "full-path"));
  const opfPath = attr(rootfile ?? null, "full-path");
  if (!opfPath) throw new Error("epub: container.xml names no rootfile");

  const opfEntry = findEntry(entries, opfPath);
  if (!opfEntry) throw new Error(`epub: rootfile ${opfPath} is not in the archive`);
  const opf = parseXml(await readEntryText(reader, opfEntry));

  const meta = readOpfMetadata(opf);
  const cover = await readCover(reader, entries, opf, opfPath);
  if (cover) meta.cover = cover;
  return meta;
}

/**
 * Element text for `dc:*` fields, tolerating documents with no prefix.
 *
 * Searches the whole metadata subtree rather than direct children: a malformed
 * OPF that leaves an element unclosed nests the rest inside it, and losing every
 * field after the first mistake is a worse failure than a stray match.
 */
function dcValues(metadata: XmlNode, name: string): XmlNode[] {
  return findAll(metadata, name).filter((c) => c.prefix === "dc" || c.prefix === "");
}

export function readOpfMetadata(opf: XmlNode): ExtractedMetadata {
  const metadata = findFirst(opf, "metadata");
  const result: ExtractedMetadata = { authors: [], subjects: [] };
  if (!metadata) return result;

  const metaTags = findAll(metadata, "meta");

  // EPUB3 refinements: <meta refines="#id" property="role">aut</meta>
  const refines = new Map<string, Map<string, string>>();
  for (const m of metaTags) {
    const target = attr(m, "refines");
    const property = attr(m, "property");
    if (!target || !property) continue;
    const id = target.replace(/^#/, "");
    const map = refines.get(id) ?? new Map<string, string>();
    map.set(property.toLowerCase(), deepText(m));
    refines.set(id, map);
  }

  const title = dcValues(metadata, "title")[0];
  if (title) result.title = deepText(title) || undefined;

  for (const creator of dcValues(metadata, "creator")) {
    const id = attr(creator, "id");
    const roleAttr = attr(creator, "role");
    const roleRefined = id ? refines.get(id)?.get("role") : undefined;
    const role = (roleAttr ?? roleRefined ?? "aut").toLowerCase();
    // Keep authors; drop illustrators, editors, translators and the rest.
    if (role !== "aut") continue;
    const name = deepText(creator);
    if (name) result.authors.push(name);
  }
  // A book with only non-author creators still needs a byline.
  if (result.authors.length === 0) {
    for (const creator of dcValues(metadata, "creator")) {
      const name = deepText(creator);
      if (name) result.authors.push(name);
    }
  }

  const language = dcValues(metadata, "language")[0];
  if (language) result.language = deepText(language).slice(0, 16) || undefined;

  const publisher = dcValues(metadata, "publisher")[0];
  if (publisher) result.publisher = deepText(publisher) || undefined;

  const date = dcValues(metadata, "date")[0];
  if (date) result.published = deepText(date) || undefined;

  const description = dcValues(metadata, "description")[0];
  if (description) result.description = stripHtml(deepText(description)).slice(0, 8000) || undefined;

  for (const subject of dcValues(metadata, "subject")) {
    const value = deepText(subject);
    // Calibre writes comma-joined subject lists into a single element.
    for (const part of value.split(/\s*,\s*/)) {
      const tag = part.trim();
      if (tag && tag.length <= 64) result.subjects.push(tag);
    }
  }

  result.isbn = readIsbn(metadata);

  const series = readSeries(metaTags, refines);
  if (series) {
    result.series = series.name;
    if (series.index !== undefined) result.seriesIndex = series.index;
  }

  return result;
}

function readIsbn(metadata: XmlNode): string | undefined {
  for (const id of dcValues(metadata, "identifier")) {
    const scheme = (attr(id, "scheme") ?? "").toLowerCase();
    const value = deepText(id);
    const digits = value.replace(/^urn:isbn:/i, "").replace(/[^0-9Xx]/g, "");
    const looksIsbn = digits.length === 10 || digits.length === 13;
    if ((scheme === "isbn" || /^urn:isbn:/i.test(value)) && looksIsbn) return digits.toUpperCase();
    if (looksIsbn && scheme === "" && /isbn/i.test(attr(id, "id") ?? "")) return digits.toUpperCase();
  }
  return undefined;
}

function readSeries(
  metaTags: XmlNode[],
  refines: Map<string, Map<string, string>>,
): { name: string; index?: number } | null {
  // EPUB2 / Calibre convention.
  const calibreSeries = metaTags.find((m) => (attr(m, "name") ?? "").toLowerCase() === "calibre:series");
  if (calibreSeries) {
    const name = attr(calibreSeries, "content")?.trim();
    if (name) {
      const idxTag = metaTags.find((m) => (attr(m, "name") ?? "").toLowerCase() === "calibre:series_index");
      const idx = idxTag ? Number.parseFloat(attr(idxTag, "content") ?? "") : NaN;
      return { name, index: Number.isFinite(idx) ? idx : undefined };
    }
  }

  // EPUB3 collections.
  for (const m of metaTags) {
    if ((attr(m, "property") ?? "").toLowerCase() !== "belongs-to-collection") continue;
    const name = deepText(m);
    if (!name) continue;
    const id = attr(m, "id");
    const refinement = id ? refines.get(id) : undefined;
    const type = refinement?.get("collection-type");
    if (type && type.toLowerCase() !== "series") continue;
    const position = refinement?.get("group-position");
    const idx = position ? Number.parseFloat(position) : NaN;
    return { name, index: Number.isFinite(idx) ? idx : undefined };
  }

  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function readCover(
  reader: RangeReader,
  entries: Map<string, ZipEntry>,
  opf: XmlNode,
  opfPath: string,
): Promise<CoverImage | null> {
  const manifest = findFirst(opf, "manifest");
  if (!manifest) return null;
  const items = manifest.children.filter((c) => c.name === "item");

  const byId = new Map<string, XmlNode>();
  for (const item of items) {
    const id = attr(item, "id");
    if (id) byId.set(id, item);
  }

  const candidates: XmlNode[] = [];

  // 1. EPUB3: manifest item flagged properties="cover-image".
  for (const item of items) {
    if ((attr(item, "properties") ?? "").split(/\s+/).includes("cover-image")) candidates.push(item);
  }
  // 2. EPUB2: <meta name="cover" content="itemId">.
  const metadata = findFirst(opf, "metadata");
  if (metadata) {
    const coverMeta = findAll(metadata, "meta").find((c) => (attr(c, "name") ?? "").toLowerCase() === "cover");
    const refId = attr(coverMeta ?? null, "content");
    const item = refId ? byId.get(refId) : undefined;
    if (item) candidates.push(item);
  }
  // 3. Last resort: an image item that calls itself a cover.
  for (const item of items) {
    const id = (attr(item, "id") ?? "").toLowerCase();
    const href = (attr(item, "href") ?? "").toLowerCase();
    if (/cover/.test(id) || /cover/.test(href)) candidates.push(item);
  }

  for (const item of candidates) {
    const href = attr(item, "href");
    const mime = attr(item, "media-type") ?? "";
    if (!href || !mime.startsWith("image/")) continue;
    const path = resolvePath(opfPath, decodeURIComponent(href));
    const entry = findEntry(entries, path);
    if (!entry || entry.uncompressedSize > MAX_COVER_BYTES) continue;
    try {
      const bytes = await readEntry(reader, entry, MAX_COVER_BYTES);
      if (bytes.length === 0) continue;
      return { bytes, mime, name: path };
    } catch {
      // A cover we cannot inflate is not a reason to fail the whole import.
      continue;
    }
  }

  return null;
}
