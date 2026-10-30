# foliate-js (vendored)

The rendering engine behind `/reader.html`, copied unmodified from
https://github.com/johnfactotum/foliate-js at commit
`78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01). MIT, see `LICENSE`.

It is vendored rather than installed because the UI has no bundler: these are
plain ES modules served as static assets. Only the modules the reader can reach
are copied. `pdf.js` (and pdf.js itself), `search.js`, `tts.js` and the `ui/`
widgets are left out; `view.js` imports them lazily, so nothing requests them
unless that feature is called, and the reader never calls it.

To update: copy the same files from a newer commit, bump the hash above, and
open a book of each format (EPUB, CBZ, MOBI/AZW3, FB2) in the reader.
