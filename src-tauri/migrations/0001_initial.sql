CREATE TABLE IF NOT EXISTS recent_files (
  path TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  last_opened_ms INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recent_files_last_opened ON recent_files(last_opened_ms DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tabs (
  position INTEGER PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS window_state (
  window_label TEXT PRIMARY KEY NOT NULL,
  x INTEGER,
  y INTEGER,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  maximized INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS handler_preferences (
  detected_type TEXT PRIMARY KEY NOT NULL,
  handler_id TEXT NOT NULL
);
