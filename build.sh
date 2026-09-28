#!/usr/bin/env bash
# The one build step a deploy needs, for Cloudflare Workers Builds (its build
# command) and for .github/workflows/cf-fallback.yml alike.
#
# The Worker itself is bundled by `wrangler deploy`; the only thing to produce
# here is public/.build-id, which identifies the deployed commit so the
# fallback workflow can tell whether Cloudflare already published this tree.
# public/_headers serves it with Cache-Control: no-store.
#
# Read the SHA from the checkout rather than the environment. Workers Builds
# sets WORKERS_CI_COMMIT_SHA to the *branch name* for a manually started build,
# and the fallback compares this value against github.sha -- so trusting the
# variable would leave a deployed site permanently looking stale and make the
# fallback redeploy on every push, which is precisely what it exists to avoid.

set -euo pipefail

cd "$(dirname "$0")"

sha=$(git rev-parse HEAD 2>/dev/null || echo "${WORKERS_CI_COMMIT_SHA:-${GITHUB_SHA:-local}}")
printf '%s\n' "$sha" > public/.build-id

echo "build id: $sha"
