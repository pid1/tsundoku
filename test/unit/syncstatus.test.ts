import { describe, expect, it } from "vitest";
import { IN_SYNC_EPSILON, groupSyncRows, usersInRows } from "../../src/sync/status.js";
import type { DeviceProgressRow } from "../../src/types.js";

function row(overrides: Partial<DeviceProgressRow> = {}): DeviceProgressRow {
  return {
    user_id: "u1",
    document: "doc-a",
    device_id: "d1",
    device: "Kobo",
    percentage: 0.5,
    progress: "/body/DocFragment[3]",
    updated_at: 1000,
    username: "alice",
    display_name: "Alice",
    book_id: "b1",
    book_title: "Pale Fire",
    book_format: "epub",
    metadata: null,
    furthest_percentage: 0.5,
    latest_updated_at: 1000,
    device_count: 1,
    ...overrides,
  };
}

/** Two devices on one document, with the aggregates SQL would have computed. */
function pair(a: Partial<DeviceProgressRow>, b: Partial<DeviceProgressRow>): DeviceProgressRow[] {
  const rows = [row(a), row(b)];
  const furthest = Math.max(...rows.map((r) => r.percentage));
  const latest = Math.max(...rows.map((r) => r.updated_at));
  return rows.map((r) => ({
    ...r,
    furthest_percentage: furthest,
    latest_updated_at: latest,
    device_count: rows.length,
  }));
}

describe("groupSyncRows", () => {
  it("folds one device into a single book marked 'single'", () => {
    const [book] = groupSyncRows([row()]);
    expect(book!.title).toBe("Pale Fire");
    expect(book!.userLabel).toBe("Alice");
    expect(book!.status).toBe("single");
    expect(book!.devices).toHaveLength(1);
    expect(book!.spread).toBe(0);
  });

  it("calls two devices at the same position in sync", () => {
    const [book] = groupSyncRows(
      pair({ device_id: "d1", device: "Kobo", percentage: 0.42 }, { device_id: "d2", device: "Boox", percentage: 0.42 }),
    );
    expect(book!.status).toBe("in-sync");
    expect(book!.deviceCount).toBe(2);
  });

  // A device that re-rendered the page it was handed can report a hair
  // different float; that is not a disagreement anyone would recognise.
  it("tolerates a sub-epsilon difference", () => {
    const [book] = groupSyncRows(
      pair(
        { device_id: "d1", percentage: 0.42 },
        { device_id: "d2", percentage: 0.42 + IN_SYNC_EPSILON / 2 },
      ),
    );
    expect(book!.status).toBe("in-sync");
  });

  it("calls a real gap diverged and says how far behind each device is", () => {
    const [book] = groupSyncRows(
      pair(
        { device_id: "d1", device: "Kobo", percentage: 0.8, updated_at: 2000 },
        { device_id: "d2", device: "Boox", percentage: 0.3, updated_at: 1000 },
      ),
    );
    expect(book!.status).toBe("diverged");
    expect(book!.spread).toBeCloseTo(0.5, 10);

    // Furthest first.
    expect(book!.devices[0]!.device).toBe("Kobo");
    expect(book!.devices[0]!.isFurthest).toBe(true);
    expect(book!.devices[0]!.behindBy).toBe(0);
    expect(book!.devices[1]!.device).toBe("Boox");
    expect(book!.devices[1]!.isFurthest).toBe(false);
    expect(book!.devices[1]!.behindBy).toBeCloseTo(0.5, 10);
  });

  it("marks the most recent push even when it is not the furthest", () => {
    const [book] = groupSyncRows(
      pair(
        { device_id: "d1", device: "Kobo", percentage: 0.8, updated_at: 1000 },
        { device_id: "d2", device: "Boox", percentage: 0.3, updated_at: 2000 },
      ),
    );
    const boox = book!.devices.find((d) => d.device === "Boox")!;
    expect(boox.isLatest).toBe(true);
    expect(boox.isFurthest).toBe(false);
  });

  it("keeps positions for books not in the library, titled from kosync metadata", () => {
    const [book] = groupSyncRows([
      row({ book_id: null, book_title: null, book_format: null, metadata: '{"title":"A Wizard of Earthsea"}' }),
    ]);
    expect(book!.unmatched).toBe(true);
    expect(book!.title).toBe("A Wizard of Earthsea");
  });

  it("falls back to the filename, then to the document hash", () => {
    const [byFilename] = groupSyncRows([
      row({ book_id: null, book_title: null, metadata: '{"filename":"earthsea.epub"}' }),
    ]);
    expect(byFilename!.title).toBe("earthsea.epub");

    const [byHash] = groupSyncRows([
      row({ book_id: null, book_title: null, document: "0123456789abcdef", metadata: null }),
    ]);
    expect(byHash!.title).toContain("0123456789ab");
  });

  it("does not throw on malformed metadata", () => {
    const [book] = groupSyncRows([row({ book_id: null, book_title: null, metadata: "{not json" })]);
    expect(book!.title).toContain("doc-a");
  });

  it("separates the same document read by two different users", () => {
    const books = groupSyncRows([
      row({ user_id: "u1", username: "alice", display_name: "Alice" }),
      row({ user_id: "u2", username: "bob", display_name: null }),
    ]);
    expect(books).toHaveLength(2);
    expect(books.map((b) => b.userLabel).sort()).toEqual(["Alice", "bob"]);
  });

  it("orders books by most recently synced", () => {
    const books = groupSyncRows([
      row({ document: "old", latest_updated_at: 100, updated_at: 100 }),
      row({ document: "new", latest_updated_at: 900, updated_at: 900 }),
    ]);
    expect(books.map((b) => b.document)).toEqual(["new", "old"]);
  });

  it("returns nothing for no rows", () => {
    expect(groupSyncRows([])).toEqual([]);
  });
});

describe("usersInRows", () => {
  it("lists each user once, by display name, sorted", () => {
    expect(
      usersInRows([
        row({ user_id: "u2", username: "bob", display_name: "Bob" }),
        row({ user_id: "u1", username: "alice", display_name: "Alice" }),
        row({ user_id: "u2", username: "bob", display_name: "Bob", document: "other" }),
      ]),
    ).toEqual([
      { id: "u1", label: "Alice" },
      { id: "u2", label: "Bob" },
    ]);
  });

  it("falls back to the username when there is no display name", () => {
    expect(usersInRows([row({ user_id: "u9", username: "carol", display_name: null })])).toEqual([
      { id: "u9", label: "carol" },
    ]);
  });
});
