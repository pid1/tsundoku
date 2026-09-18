# Resolving the partial-MD5 ambiguity

**Status: resolved against real LuaJIT on 2026-09-18; device confirmation still
outstanding. `primary` (offset 0) is the column to trust.**

## What is ambiguous

KOReader's document hash comes from `frontend/util.lua`:

```lua
local step, size = 1024, 1024
local update = md5()
for i = -1, 10 do
    file:seek("set", lshift(step, 2*i))
    local sample = file:read(size)
    if sample then update(sample) else break end
end
```

For `i = -1` the shift count is `-2`.

- Read arithmetically, `1024 >> 2` is **256**.
- LuaJIT's `bit.lshift` masks the shift count to five bits, so `-2` becomes `30`,
  and `1024 << 30` overflows 32 bits to **0**.

Those produce different hashes. `src/books/partialmd5.ts` computes both:
`primary` starts at offset 0, `alt` starts at 256. Both are stored, and lookups
match on either column, so the ambiguity costs one extra `TEXT` column rather
than a broken feature.

**Sync does not depend on this.** kosync only needs the hash to agree between a
user's own devices, and the server stores whatever string the client sends. What
depends on it is the nicety of linking a synced position back to a book in the
library, for display in the web UI.

## How to settle it

1. Put a known file on a KOReader device. An EPUB of a few hundred KB is ideal:
   large enough to exercise several sample offsets, small enough to copy around.
2. Open it in KOReader, read a page, and close it. KOReader writes a sidecar
   directory beside the book.
3. Read the checksum out of the sidecar:

   ```
   <book>.sdr/metadata.epub.lua
   ```

   Look for:

   ```lua
   ["partial_md5_checksum"] = "0123456789abcdef0123456789abcdef",
   ```

4. Upload the same file to tsundoku, then read back both candidates:

   ```bash
   curl -su you:secret https://books.example.com/api/books/<id> \
     | python3 -c 'import json,sys; b=json.load(sys.stdin); print("primary", b["partial_md5"]); print("alt    ", b["partial_md5_alt"])'
   ```

5. Whichever matches the sidecar is the real one.

## What to do with the answer

Record it here with the date and the KOReader version it was observed on, then:

- Keep both columns. A future KOReader or a different Lua bit library could
  produce the other reading, and matching on both costs nothing.
- Add a fixture to `test/unit/partialmd5.test.ts` asserting the confirmed
  variant against the real file's bytes and the sidecar's hash.

## Result

### Settled without a device, 2026-09-18

The ambiguity is about what Lua does, so it can be answered by asking Lua. On a
machine with LuaJIT (`brew install luajit`):

```console
$ luajit -e 'local bit=require("bit"); print(bit.lshift(1024,-2))'
0
```

The shift count is masked to five bits, so the first sample offset is **0**, not
256. `partial_md5` (`primary`) is what KOReader computes; `partial_md5_alt` is
the arithmetic reading and is the spare.

KOReader's loop was then transcribed into LuaJIT and run against two real files
that had been uploaded to a live deployment, and against the 200,000-byte
pattern the unit tests use. Every digest matched the corresponding column
exactly:

| File | Size | Offsets sampled | `primary` | `alt` |
|---|---|---|---|---|
| `pale-fire.epub` | 3,262 B | 0, 1024 | `4815a87f...` matched | `00c2625d...` matched |
| `benchmark-funnies-03.cbz` | 3,595,420 B | 0 … 1048576 (7) | `3d672036...` matched | `816e0c82...` matched |
| `pattern(200000)` (unit fixture) | 200,000 B | 0 … 65536 (5) | `1784b150...` | `a4c46791...` |

The last row is now pinned in `test/unit/partialmd5.test.ts`, so our TypeScript
is checked against the Lua the readers actually run rather than against our own
reading of the Lua.

### Still outstanding

This proves the algorithm and our implementation of it. It does **not** prove
what a given KOReader build writes into its sidecar -- that would need the
device procedure above, and it is the only thing that closes the loop on a
specific version. Both columns stay regardless, and sync never depended on this.

| Date | KOReader version | File | Sidecar hash | Matched |
|------|------------------|------|--------------|---------|
| _unrecorded -- device check still wanted_ | | | | |
