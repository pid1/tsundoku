import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parsePreferences } from "../../src/preferences.js";

describe("parsePreferences", () => {
  it("accepts a font from the fixed set", () => {
    expect(parsePreferences({ reader_font: "atkinson-hyperlegible-next" }, DEFAULT_PREFERENCES)).toEqual({
      reader_font: "atkinson-hyperlegible-next",
    });
  });

  it("keeps the current value for an absent key", () => {
    const current = { reader_font: "atkinson-hyperlegible-next" } as const;
    expect(parsePreferences({}, current)).toEqual(current);
  });

  it("refuses a font outside the set rather than storing it", () => {
    // The reader turns this into CSS; an arbitrary string must never reach it.
    for (const reader_font of ["Comic Sans", "", null, 3, "publisher; } body { display:none"]) {
      expect(parsePreferences({ reader_font }, DEFAULT_PREFERENCES)).toHaveProperty("error");
    }
  });

  it("refuses a body that is not an object", () => {
    for (const body of [null, "x", 1, ["publisher"]]) {
      expect(parsePreferences(body, DEFAULT_PREFERENCES)).toHaveProperty("error");
    }
  });
});
