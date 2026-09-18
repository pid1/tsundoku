import { describe, expect, it } from "vitest";
import { bytesRangeReader, findEntry, readCentralDirectory, readEntry, readEntryText } from "../../src/books/zip.js";
import { buildZip } from "../helpers/zip.js";

describe("zip reader", () => {
  it("reads the central directory without touching the whole archive", async () => {
    const zip = await buildZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.txt", data: "world", method: 0 },
    ]);
    const entries = await readCentralDirectory(bytesRangeReader(zip));
    expect([...entries.keys()].sort()).toEqual(["a.txt", "dir/b.txt"]);
    expect(entries.get("dir/b.txt")?.method).toBe(0);
    expect(entries.get("a.txt")?.method).toBe(8);
  });

  it("inflates a deflated entry", async () => {
    const text = "The quick brown fox ".repeat(50);
    const zip = await buildZip([{ name: "big.txt", data: text }]);
    const reader = bytesRangeReader(zip);
    const entries = await readCentralDirectory(reader);
    expect(await readEntryText(reader, entries.get("big.txt")!)).toBe(text);
  });

  it("returns a stored entry verbatim", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const zip = await buildZip([{ name: "raw.bin", data: bytes, method: 0 }]);
    const reader = bytesRangeReader(zip);
    const entries = await readCentralDirectory(reader);
    expect([...(await readEntry(reader, entries.get("raw.bin")!))]).toEqual([...bytes]);
  });

  it("locates the EOCD behind a trailing archive comment", async () => {
    const zip = await buildZip([{ name: "a.txt", data: "hi" }]);
    // Append a comment and fix the comment-length field, as a real archiver would.
    const comment = new TextEncoder().encode("x".repeat(300));
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    new DataView(withComment.buffer).setUint16(zip.length - 2, comment.length, true);

    const entries = await readCentralDirectory(bytesRangeReader(withComment));
    expect(entries.has("a.txt")).toBe(true);
  });

  it("matches entry names case-insensitively", async () => {
    const zip = await buildZip([{ name: "META-INF/container.xml", data: "<x/>" }]);
    const entries = await readCentralDirectory(bytesRangeReader(zip));
    expect(findEntry(entries, "meta-inf/CONTAINER.XML")).not.toBeNull();
  });

  it("refuses a file that is not a zip", async () => {
    const notAZip = new TextEncoder().encode("this is a plain text file, not an archive at all");
    await expect(readCentralDirectory(bytesRangeReader(notAZip))).rejects.toThrow(/not a zip/);
  });

  it("refuses an entry larger than the caller's budget", async () => {
    const zip = await buildZip([{ name: "big.bin", data: new Uint8Array(4096), method: 0 }]);
    const reader = bytesRangeReader(zip);
    const entries = await readCentralDirectory(reader);
    await expect(readEntry(reader, entries.get("big.bin")!, 1024)).rejects.toThrow(/over the 1024 limit/);
  });

  it("reads data past a local header whose extra field differs from the central one", async () => {
    // The local header's name and extra lengths are authoritative for where the
    // data starts; using the central directory's is a classic off-by-N.
    const zip = await buildZip([{ name: "some/deeply/nested/name.txt", data: "payload" }]);
    const reader = bytesRangeReader(zip);
    const entries = await readCentralDirectory(reader);
    expect(await readEntryText(reader, entries.get("some/deeply/nested/name.txt")!)).toBe("payload");
  });
});
