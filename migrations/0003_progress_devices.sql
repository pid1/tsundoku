-- Per-device reading positions.
--
-- `progress` is keyed (user_id, document) because that is what kosync itself
-- is: one position per user per book, last writer wins. That answers "where am
-- I in this book" but destroys "where is each device", because every push
-- overwrites the previous device's row.
--
-- This table keeps the latest position per (user, document, device) alongside
-- it. Nothing in the kosync protocol reads it: GET /syncs/progress/:document
-- still answers from `progress`, unchanged. It exists so the Sync page can show
-- which devices agree and which are behind.
CREATE TABLE progress_devices (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  device     TEXT NOT NULL,
  percentage REAL NOT NULL,
  progress   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, device_id)
);

CREATE INDEX progress_devices_updated ON progress_devices(user_id, updated_at DESC);
CREATE INDEX progress_devices_document ON progress_devices(document);

-- Seed from what we already hold. Each existing row becomes that book's single
-- known device; the rest fills in as devices push.
INSERT INTO progress_devices (user_id, document, device_id, device, percentage, progress, updated_at)
SELECT user_id, document, device_id, device, percentage, progress, updated_at FROM progress;
