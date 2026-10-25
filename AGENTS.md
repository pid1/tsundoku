# AGENTS.md

## Sadr

### Build and test
- Install with `npm ci`, then run `npm run typecheck` (tsc --noEmit) and `npm test` (vitest inside workerd through @cloudflare/vitest-plugin). Passing is a clean typecheck and every test passing. Neither needs a Cloudflare account.
- Run the app with `npm run db:migrate:local`, then `npx wrangler dev --port 8787 --ip 127.0.0.1 --var PEPPER:ci-pepper --var SESSION_KEY:ci-session --var ADMIN_USERNAME:ciuser --var ADMIN_PASSWORD:cipassword`. `GET /healthcheck` answers `{"state":"OK"}`. The first authenticated request seeds the admin account.
- The kosync protocol check clones https://github.com/pid1/kosync-conformance and runs its `verify.mjs` against the local Worker, as .github/workflows/kosync-conformance.yml does. Passing is "conformant (every MUST satisfied)".
- Never run `npm run deploy`, `npm run db:migrate`, `npm run setup` or `npm run db:backup`. They write to the Cloudflare account.

### Toolchain
- npm is the only package manager, with package-lock.json. CI installs Node with actions/setup-node and runs `npm ci`.

### Deploys outside CI
- Cloudflare Workers Builds deploys the Worker on every push to main, with build command `./build.sh` and deploy command `npx wrangler deploy` (wrangler.toml). .github/workflows/cf-fallback.yml deploys only when the live `/.build-id` does not match the pushed commit.
