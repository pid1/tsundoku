import type { ExtractedMetadata } from "./epub.js";
import { attr, deepText, findFirst, parseXml } from "./xml.js";
import { findEntry, readCentralDirectory, readEntry, readEntryText } from "./zip.js";
import type { RangeReader, ZipEntry } from "./zip.js";
import { titleFromFilename } from "../util.js";

const MAX_COVER_BYTES = 6 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

function imageMime(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

/**
 * Comics carry no standard metadata, so the filename is the source of truth --
 * except when the archive ships a ComicInfo.xml, which many do.
 */
export async function extractCbz(reader: RangeReader, filename: string): Promise<ExtractedMetadata> {
  const entries = await readCentralDirectory(reader);
  const result: ExtractedMetadata = { authors: [], subjects: [], ...parseComicFilename(filename) };

  const comicInfo = findEntry(entries, "ComicInfo.xml");
  if (comicInfo) {
    try {
      const doc = parseXml(await readEntryText(reader, comicInfo));
      applyComicInfo(doc, result);
    } catch {
      // Malformed ComicInfo is common; the filename guess stands.
    }
  }

  const cover = await readFirstImage(reader, entries);
  if (cover) result.cover = cover;
  return result;
}

function applyComicInfo(doc: ReturnType<typeof parseXml>, into: ExtractedMetadata): void {
  const root = findFirst(doc, "comicinfo");
  if (!root) return;
  const text = (name: string): string | undefined => {
    const node = root.children.find((c) => c.name === name);
    const value = node ? deepText(node) : "";
    return value || undefined;
  };

  const series = text("series");
  const number = text("number");
  const title = text("title");

  if (series) into.series = series;
  if (number) {
    const idx = Number.parseFloat(number);
    if (Number.isFinite(idx)) into.seriesIndex = idx;
  }
  if (series && number) into.title = title ? `${series} #${number}: ${title}` : `${series} #${number}`;
  else if (title) into.title = title;

  const writer = text("writer") ?? text("penciller");
  if (writer) into.authors = writer.split(/\s*,\s*/).filter(Boolean);

  const publisher = text("publisher");
  if (publisher) into.publisher = publisher;

  const summary = text("summary");
  if (summary) into.description = summary.slice(0, 8000);

  const year = text("year");
  if (year) into.published = year;

  const genre = text("genre");
  if (genre) into.subjects = genre.split(/\s*,\s*/).filter(Boolean);

  void attr;
}

/**
 * "Saga - 012 - Some Title.cbz" and "Saga v03 (2013).cbz" both parse; anything
 * else falls back to the filename as the title.
 */
export function parseComicFilename(filename: string): Partial<ExtractedMetadata> {
  const base = filename.replace(/\.[^.]+$/, "");

  const dashed = /^(.+?)\s+-\s+(\d{1,4})(?:\s+-\s+(.+))?$/.exec(base);
  if (dashed) {
    const [, series, number, rest] = dashed;
    return {
      series: series.trim(),
      seriesIndex: Number.parseInt(number, 10),
      title: rest ? `${series.trim()} #${Number.parseInt(number, 10)}: ${rest.trim()}` : `${series.trim()} #${Number.parseInt(number, 10)}`,
    };
  }

  const volume = /^(.+?)\s+v(?:ol)?\.?\s*(\d{1,3})\b/i.exec(base);
  if (volume) {
    const [, series, number] = volume;
    return {
      series: series.trim(),
      seriesIndex: Number.parseInt(number, 10),
      title: `${series.trim()} vol. ${Number.parseInt(number, 10)}`,
    };
  }

  return { title: titleFromFilename(filename) };
}

async function readFirstImage(
  reader: RangeReader,
  entries: Map<string, ZipEntry>,
): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
  const images = [...entries.values()]
    .filter((e) => imageMime(e.name) !== null && !e.name.split("/").pop()?.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  for (const entry of images) {
    if (entry.uncompressedSize > MAX_COVER_BYTES) continue;
    try {
      const bytes = await readEntry(reader, entry, MAX_COVER_BYTES);
      if (bytes.length > 0) return { bytes, mime: imageMime(entry.name) as string, name: entry.name };
    } catch {
      continue;
    }
  }
  return null;
}
