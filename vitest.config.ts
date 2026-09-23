import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// The suite's own copy of migrations/, handed to `applyD1Migrations` by the
// tests that need a schema. Reading them here is what keeps a test's tables the
// ones a deployment actually gets.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// Tests run inside workerd, so DecompressionStream, crypto.subtle.digest("MD5")
// and the D1/R2 bindings behave exactly as they will in production. Testing the
// ZIP reader or the partial-MD5 against a Node polyfill would prove nothing.
//
// The bindings are declared here rather than read from wrangler.toml so the
// suite runs with no Cloudflare account and no real database_id -- which is
// what CI has.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        d1Databases: ["DB"],
        r2Buckets: ["BOOKS"],
        bindings: {
          PEPPER: "test-pepper",
          SESSION_KEY: "test-session-key",
          CATALOG_TITLE: "tsundoku-test",
          PAGE_SIZE: "50",
          MAX_UPLOAD_MB: "95",
          ALLOW_KOSYNC_REGISTER: "0",
          MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["test/unit/**/*.test.ts"],
  },
});
