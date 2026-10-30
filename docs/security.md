# Security

How tsundoku signs people in, how it stores passwords, and why. [PLAN.md §5](../PLAN.md) has the full reasoning. If you're exposing tsundoku to more than a handful of people, read both first.

## Three kinds of client, one password

| Surface | Mechanism |
|---|---|
| OPDS feeds, downloads, covers | HTTP **Basic**, the only scheme KOReader's OPDS client speaks |
| Web UI | a signed `HttpOnly; Secure; SameSite=Lax` session cookie |
| kosync | `x-auth-user` and `x-auth-key` (the MD5 of the password), as the protocol requires |

Every route but `/healthcheck` and the sign-in page needs credentials.

## How passwords are stored

**Passwords are stored as a peppered keyed hash (HMAC-SHA256), not a slow KDF.** Basic sends the password with every request, and the free plan's 10 ms CPU limit does not fit a slow KDF on that path. The pepper lives in Workers Secrets, not in D1, so a leaked database on its own yields nothing to crack.

What makes up for it: no self-signup, a closed set of accounts, generated high-entropy passwords, rate limiting on failed sign-ins per IP and per username, and constant-time comparison.

## The PBKDF2 benchmark

Measured 2026-09-18 on a deployed Worker with the harness in [`test/bench/`](../test/bench/), reading `cpuTime` from `wrangler tail`. (`Date.now()` doesn't advance during computation in Workers, so it can't measure this.)

| PBKDF2-SHA256 iterations | CPU time |
|---|---|
| 1,000 | 0 ms |
| 10,000 | 3 ms |
| 50,000 | 10 ms |
| 100,000 | 22–27 ms |
| 200,000 | **throws**: `Pbkdf2 failed: iteration counts above 100000 are not supported` |
| HMAC-SHA256 × 50 (what tsundoku does) | 0 ms |

Three findings, which together say **keep HMAC**:

1. **workerd caps PBKDF2 at 100,000 iterations.** Above that it throws, so it's a hard ceiling. OWASP currently advises 600,000 for PBKDF2-SHA256, six times what a Worker will run at all. No defensible modern iteration count is reachable here on any plan.
2. **Within the free plan's 10 ms, about 30,000 iterations fit with margin.** 50,000 lands exactly on the limit. That's a weak KDF, not a good one.
3. **It would buy nothing anyway.** The same password has to stay checkable by a fast keyed hash for Basic and kosync, which send it on every request. An attacker with the database and the pepper attacks the fast verifier and ignores the slow one: the weakest verifier decides. PBKDF2 on the sign-in page alone would add cost and a column for no gain, unless Basic and kosync were dropped, and that would mean dropping KOReader.

So the design stands, for a different reason than first assumed. It isn't the 10 ms limit that rules PBKDF2 out, but workerd's 100,000 ceiling and the shared password.

## The web reader

A book is untrusted content. The reader renders each chapter in a `blob:` frame, which inherits the reader page's Content-Security-Policy (`public/_headers`). That policy runs only scripts served by this site, so a script inside an EPUB never runs with your session.

## Known unknowns

1. **The KOReader document hash is settled against LuaJIT, not yet against a device.** `bit.lshift(1024, -2)` returns `0` in real LuaJIT, because the shift count is masked to five bits. So the first sample is at offset 0, and `partial_md5` is the column KOReader computes. KOReader's loop was run in LuaJIT and matched both stored columns byte for byte on files up to 3.6 MB, and that pair is pinned in `test/unit/partialmd5.test.ts`. What's still unconfirmed is what a given KOReader build writes to its sidecar. [`test/conformance/partial-md5.md`](../test/conformance/partial-md5.md) has the evidence and the device procedure.
2. **Reader quirks, not specs, are the real compatibility risk.** KOReader has a history of OPDS sign-in bugs across versions. Test against devices.
3. **OPDS 2.0 support in readers is thin.** It's built and correct, but 1.2 is what gets used.
