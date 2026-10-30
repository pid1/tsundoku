-- Per-user preferences for the web UI. One row per user, created on first save;
-- a user with no row gets the defaults, so nothing here needs seeding.
--
-- Columns rather than a JSON blob: each preference is validated against a fixed
-- set of values in src/preferences.ts, and a column says what that set is.
CREATE TABLE user_preferences (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reader_font TEXT NOT NULL DEFAULT 'publisher',  -- 'publisher' | 'atkinson-hyperlegible-next'
  updated_at  INTEGER NOT NULL
);
