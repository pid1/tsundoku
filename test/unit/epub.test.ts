import { describe, expect, it } from "vitest";
import { extractEpub, resolvePath } from "../../src/books/epub.js";
import { bytesRangeReader } from "../../src/books/zip.js";
import { buildEpub } from "../helpers/zip.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("resolvePath", () => {
  it("resolves relative to the OPF's own directory", () => {
    expect(resolvePath("OEBPS/content.opf", "images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
    expect(resolvePath("content.opf", "cover.jpg")).toBe("cover.jpg");
    expect(resolvePath("OEBPS/sub/content.opf", "../images/c.jpg")).toBe("OEBPS/images/c.jpg");
    expect(resolvePath("OEBPS/content.opf", "/absolute/c.jpg")).toBe("absolute/c.jpg");
    expect(resolvePath("OEBPS/content.opf", "c.jpg#anchor")).toBe("OEBPS/c.jpg");
  });
});

describe("extractEpub", () => {
  it("reads the core Dublin Core fields", async () => {
    const epub = await buildEpub({
      title: "The Left Hand of Darkness",
      authors: [{ name: "Ursula K. Le Guin", fileAs: "Le Guin, Ursula K." }],
      language: "en",
      publisher: "Ace Books",
      date: "1969-03-01",
      description: "Winter is a planet.",
      subjects: ["Science fiction", "Gender"],
      isbn: "978-0-441-47812-5",
    });
    const meta = await extractEpub(bytesRangeReader(epub));

    expect(meta.title).toBe("The Left Hand of Darkness");
    expect(meta.authors).toEqual(["Ursula K. Le Guin"]);
    expect(meta.language).toBe("en");
    expect(meta.publisher).toBe("Ace Books");
    expect(meta.published).toBe("1969-03-01");
    expect(meta.description).toBe("Winter is a planet.");
    expect(meta.subjects).toEqual(["Science fiction", "Gender"]);
    expect(meta.isbn).toBe("9780441478125");
  });

  it("keeps authors and drops other creator roles", async () => {
    const epub = await buildEpub({
      title: "Illustrated",
      authors: [
        { name: "Real Author", role: "aut" },
        { name: "Some Illustrator", role: "ill" },
      ],
    });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.authors).toEqual(["Real Author"]);
  });

  it("still produces a byline when every creator is a non-author role", async () => {
    const epub = await buildEpub({ title: "Anthology", authors: [{ name: "An Editor", role: "edt" }] });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.authors).toEqual(["An Editor"]);
  });

  it("reads Calibre-style EPUB2 series", async () => {
    const epub = await buildEpub({ title: "Book Three", series: { name: "The Expanse", index: 3 } });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.series).toBe("The Expanse");
    expect(meta.seriesIndex).toBe(3);
  });

  it("reads EPUB3 belongs-to-collection with its refinements", async () => {
    const epub = await buildEpub({ title: "Book Two", collection: { name: "Earthsea", position: 2 } });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.series).toBe("Earthsea");
    expect(meta.seriesIndex).toBe(2);
  });

  it("splits a comma-joined subject list, as Calibre writes it", async () => {
    const epub = await buildEpub({ title: "T", subjects: ["Fiction, Fantasy, Epic"] });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.subjects).toEqual(["Fiction", "Fantasy", "Epic"]);
  });

  it("extracts an EPUB2 cover named by a meta tag", async () => {
    const epub = await buildEpub({
      title: "With cover",
      cover: { bytes: PNG, mime: "image/png", href: "images/cover.png" },
    });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.cover?.mime).toBe("image/png");
    expect([...(meta.cover?.bytes ?? [])]).toEqual([...PNG]);
  });

  it("extracts an EPUB3 cover flagged properties=cover-image", async () => {
    const epub = await buildEpub({
      title: "With cover",
      cover: { bytes: PNG, mime: "image/png", href: "cover.png", epub3: true },
    });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.cover?.name).toBe("OEBPS/cover.png");
  });

  it("handles an OPF at the archive root", async () => {
    const epub = await buildEpub({
      title: "Root OPF",
      opfPath: "content.opf",
      cover: { bytes: PNG, mime: "image/png", href: "cover.png" },
    });
    const meta = await extractEpub(bytesRangeReader(epub));
    expect(meta.title).toBe("Root OPF");
    expect(meta.cover?.name).toBe("cover.png");
  });

  it("reports a file that is not an EPUB rather than returning nonsense", async () => {
    const notAnEpub = new TextEncoder().encode("plain text".repeat(40));
    await expect(extractEpub(bytesRangeReader(notAnEpub))).rejects.toThrow();
  });
});
