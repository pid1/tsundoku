import { describe, expect, it } from "vitest";
import { common, decodeList, encodeList, parseList, parseQuery } from "../../src/sync/identifiers.js";

/**
 * The parsing and comparison half of the optional identifier list, which is
 * where a wrong answer is silent: a list that degrades to "none offered"
 * answers a matching request with an unmatched body instead of an error, and a
 * `progress_match` computed from the wrong side tells a reader an xpointer is
 * safe on the strength of a claim nobody made.
 */

describe("parseList", () => {
  it("keeps the client's order", () => {
    const list = parseList([
      { type: "metadata", value: "M" },
      { type: "content", value: "C1" },
    ]);
    expect(list?.map((i) => i.type)).toEqual(["metadata", "content"]);
  });

  it("accepts eight and rejects nine", () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ type: `t${i}`, value: `v${i}` }));
    expect(parseList(entries(8))).not.toBeNull();
    expect(parseList(entries(9))).toBeNull();
  });

  it("rejects an empty list, a duplicate type and a malformed entry", () => {
    expect(parseList([])).toBeNull();
    expect(parseList([{ type: "content", value: "A" }, { type: "content", value: "B" }])).toBeNull();
    expect(parseList([{ type: "Content", value: "A" }])).toBeNull();
    expect(parseList([{ type: "content", value: "-A" }])).toBeNull();
    expect(parseList("content:A")).toBeNull();
  });
});

describe("parseQuery", () => {
  it("reads the flattened form", () => {
    expect(parseQuery("content:C1,structure:S1")).toEqual([
      { type: "content", value: "C1" },
      { type: "structure", value: "S1" },
    ]);
  });

  it("rejects an entry with no type and an empty parameter", () => {
    expect(parseQuery("C1")).toBeNull();
    expect(parseQuery("content:C1,")).toBeNull();
    expect(parseQuery("")).toBeNull();
  });

  it("round-trips through the stored encoding", () => {
    const list = [
      { type: "content", value: "C1" },
      { type: "metadata", value: "M" },
    ];
    expect(decodeList(encodeList(list))).toEqual(list);
    expect(decodeList(null)).toBeNull();
  });
});

describe("common", () => {
  const reader = [
    { type: "content", value: "C1" },
    { type: "structure", value: "S1" },
    { type: "metadata", value: "M" },
  ];

  it("reports the strongest shared identifier under the reader's own label", () => {
    const writer = [
      { type: "sha", value: "C3" },
      { type: "meta", value: "M" },
    ];
    expect(common(reader, writer)).toBe("metadata");
  });

  it("is null when nothing is shared", () => {
    expect(common(reader, [{ type: "content", value: "C9" }])).toBeNull();
  });
});
