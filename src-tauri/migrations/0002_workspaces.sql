CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  restore_last_session INTEGER NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL,
  last_opened_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_folders (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

CREATE TABLE IF NOT EXISTS workspace_pins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_ms DESC);
