-- Optional multi-identifier document matching.
--
-- Tracks koreader/koreader-sync-server#55, which is open and unmerged: a client
-- may offer several digests for one book (content, structure, metadata, ...) so
-- that a recompressed or re-downloaded copy keeps its position. A request that
-- names none is answered exactly as before, and nothing here is read on that
-- path.
--
-- Identifiers other than the record's own become aliases. They are per account,
-- like the positions they point at, so `ON DELETE CASCADE` removes them with
-- the user.
CREATE TABLE document_aliases (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,   -- an identifier value that is not itself a document
  id_type    TEXT NOT NULL,   -- the client's own label, stored and echoed uninterpreted
  document   TEXT NOT NULL,   -- the canonical digest it resolves to
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias)
);

CREATE INDEX document_aliases_document ON document_aliases(user_id, document);

-- The identifiers held by the client that wrote the current position, and the
-- position string they were written against. Kept as a pair because a later
-- push that names no identifiers must stop the earlier client's claims being
-- attributed to a string it did not write: the read compares `identifiers_for`
-- against `progress` and ignores the list when they differ, which is what makes
-- the plain write path need no change.
ALTER TABLE progress ADD COLUMN identifiers TEXT;
ALTER TABLE progress ADD COLUMN identifiers_for TEXT;
