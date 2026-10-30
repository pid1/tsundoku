import { describe, expect, it } from "vitest";
import { documentHashes, documentToWrite, latestPosition, parseWebProgress } from "../../src/sync/web.js";
import type { ProgressRow } from "../../src/types.js";

function row(document: string, updated_at: number): ProgressRow {
  return {
    user_id: "u1",
    document,
    percentage: 0.5,
    progress: "/body/DocFragment[3]/body/p[2]/text().10",
    device: "Kobo",
    device_id: "kobo-1",
    metadata: null,
    updated_at,
  };
}

describe("documentHashes", () => {
  it("lists the primary first and drops missing or duplicate hashes", () => {
    expect(documentHashes({ partial_md5: "a", partial_md5_alt: "b" })).toEqual(["a", "b"]);
    expect(documentHashes({ partial_md5: "a", partial_md5_alt: "a" })).toEqual(["a"]);
    expect(documentHashes({ partial_md5: null, partial_md5_alt: null })).toEqual([]);
  });
});

describe("latestPosition", () => {
  it("picks the most recent row across both hashes", () => {
    expect(latestPosition([row("a", 100), row("b", 200)])?.document).toBe("b");
    expect(latestPosition([row("a", 300), null])?.document).toBe("a");
    expect(latestPosition([null, null])).toBeNull();
  });
});

describe("documentToWrite", () => {
  it("writes where the user's devices already read from", () => {
    // A device that filed the book under the alternative hash must still see
    // what the browser pushes, so the browser follows it there.
    expect(documentToWrite(["a", "b"], [null, row("b", 100)])).toBe("b");
  });

  it("falls back to the primary hash for a book nobody has synced yet", () => {
    expect(documentToWrite(["a", "b"], [null, null])).toBe("a");
  });

  it("has nowhere to write for an unindexed book", () => {
    expect(documentToWrite([], [])).toBeNull();
  });
});

describe("parseWebProgress", () => {
  const ok = { percentage: 0.25, progress: "/body/DocFragment[1]/body/p.0", device_id: "web-1", device: "Web reader" };

  it("accepts a complete push and clamps the percentage", () => {
    expect(parseWebProgress(ok)).toEqual(ok);
    expect(parseWebProgress({ ...ok, percentage: 1.7 })).toMatchObject({ percentage: 1 });
    expect(parseWebProgress({ ...ok, percentage: 0 })).toMatchObject({ percentage: 0 });
  });

  it("requires a percentage, a progress string and a device id", () => {
    expect(parseWebProgress({ ...ok, percentage: undefined })).toHaveProperty("error");
    expect(parseWebProgress({ ...ok, percentage: "nope" })).toHaveProperty("error");
    expect(parseWebProgress({ ...ok, progress: "" })).toHaveProperty("error");
    expect(parseWebProgress({ ...ok, device_id: undefined })).toHaveProperty("error");
  });

  it("names the device when the client did not", () => {
    expect(parseWebProgress({ ...ok, device: undefined })).toMatchObject({ device: "Web reader" });
  });
});
