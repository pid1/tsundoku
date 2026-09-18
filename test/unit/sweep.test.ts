import { describe, expect, it } from "vitest";
import { sweepOrphanCovers } from "../../src/index.js";
import type { Env } from "../../src/types.js";

const DAY = 24 * 60 * 60 * 1000;

interface StubObject {
  key: string;
  uploaded: Date;
}

/**
 * Minimal stand-ins for the two bindings the sweep touches. Enough surface to
 * exercise pagination and the two things the sweep must never do.
 */
function makeEnv(objects: StubObject[], referenced: string[], pageSize = 1000) {
  const deleted: string[] = [];
  const remaining = [...objects];

  const BOOKS = {
    // R2 lists in lexicographic key order and its cursor resumes *after a key*,
    // not at an index -- which is what makes deleting during pagination safe.
    // Model that, or the stub invents a bug the real binding does not have.
    list({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }) {
      const matching = remaining
        .filter((o) => o.key.startsWith(prefix) && (cursor === undefined || o.key > cursor))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const size = Math.min(limit, pageSize);
      const slice = matching.slice(0, size);
      const truncated = matching.length > slice.length;
      return Promise.resolve({
        objects: slice,
        truncated,
        cursor: truncated ? slice[slice.length - 1]!.key : undefined,
      });
    },
    delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        deleted.push(k);
        const i = remaining.findIndex((o) => o.key === k);
        if (i >= 0) remaining.splice(i, 1);
      }
      return Promise.resolve();
    },
  };

  const DB = {
    prepare() {
      return {
        all: () => Promise.resolve({ results: referenced.map((cover_key) => ({ cover_key })) }),
      };
    },
  };

  return { env: { BOOKS, DB } as unknown as Env, deleted };
}

const old = () => new Date(Date.now() - 10 * DAY);
const fresh = () => new Date(Date.now() - 60 * 1000);

describe("sweepOrphanCovers", () => {
  it("deletes an old cover no book points at", async () => {
    const { env, deleted } = makeEnv([{ key: "covers/orphan.png", uploaded: old() }], []);
    expect(await sweepOrphanCovers(env)).toBe(1);
    expect(deleted).toEqual(["covers/orphan.png"]);
  });

  it("never deletes a cover a book still references", async () => {
    const { env, deleted } = makeEnv(
      [
        { key: "covers/kept.png", uploaded: old() },
        { key: "covers/orphan.png", uploaded: old() },
      ],
      ["covers/kept.png"],
    );
    expect(await sweepOrphanCovers(env)).toBe(1);
    expect(deleted).toEqual(["covers/orphan.png"]);
  });

  // Covers are written before the book row is committed, so a sweep racing an
  // upload would otherwise delete the cover of a book that is about to exist.
  it("never deletes a cover written inside the grace period", async () => {
    const { env, deleted } = makeEnv([{ key: "covers/just-uploaded.png", uploaded: fresh() }], []);
    expect(await sweepOrphanCovers(env)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("walks every page when the listing is truncated", async () => {
    const objects = Array.from({ length: 2500 }, (_, i) => ({
      key: `covers/o${i}.png`,
      uploaded: old(),
    }));
    const { env, deleted } = makeEnv(objects, ["covers/o7.png", "covers/o2222.png"]);
    expect(await sweepOrphanCovers(env)).toBe(2498);
    expect(deleted).toHaveLength(2498);
    expect(deleted).not.toContain("covers/o7.png");
    expect(deleted).not.toContain("covers/o2222.png");
  });

  it("does nothing when there is nothing to sweep", async () => {
    const { env, deleted } = makeEnv([], []);
    expect(await sweepOrphanCovers(env)).toBe(0);
    expect(deleted).toEqual([]);
  });
});
