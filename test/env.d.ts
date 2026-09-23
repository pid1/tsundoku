import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/types.js";

// What `cloudflare:test` hands a test as `env`: the Worker's own bindings plus
// the migrations vitest.config.ts reads off disk for `applyD1Migrations`.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      MIGRATIONS: D1Migration[];
    }
  }
}
