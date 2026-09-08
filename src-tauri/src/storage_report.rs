//! What OneOpen keeps on disk, for the Storage & Scratch settings page.
//!
//! Everything here is counted at the moment it is asked for. There are no
//! caches to describe: the app keeps one SQLite database and re-reads file
//! content on every open.

use crate::domain::{AppResult, StorageReport, StorageTable};
use sqlx::{Row, SqlitePool};
use std::path::Path;

/// The tables the database actually has, with what each is for and the limit
/// the code enforces on it. Kept in step with `migrations/` by a test.
const TABLES: &[(&str, &str, Option<&str>)] = &[
    ("settings", "Your preferences, stored as one JSON row.", None),
    (
        "recent_files",
        "Paths and names of files you have opened.",
        Some("100 returned"),
    ),
    (
        "session_tabs",
        "The tab list restored on launch.",
        Some("50 saved"),
    ),
    (
        "window_state",
        "Window position, size and maximised state.",
        None,
    ),
    ("workspaces", "Saved workspaces.", None),
    (
        "workspace_folders",
        "Folders belonging to a workspace.",
        Some("20 per workspace"),
    ),
    (
        "workspace_pins",
        "Files pinned to a workspace.",
        Some("50 per workspace"),
    ),
    (
        "handler_preferences",
        "Created by the first migration and never used. Viewer overrides live in the settings row instead.",
        None,
    ),
];

pub async fn build(pool: &SqlitePool, data_dir: &Path) -> AppResult<StorageReport> {
    let database = data_dir.join("oneopen.sqlite3");
    let mut tables = Vec::with_capacity(TABLES.len());
    let mut total = 0i64;
    for (name, purpose, cap) in TABLES {
        // The names come from the constant above, never from user input.
        let rows: i64 = sqlx::query(&format!("SELECT COUNT(*) AS count FROM {name}"))
            .fetch_one(pool)
            .await
            .map(|row| row.get::<i64, _>("count"))
            .unwrap_or(0);
        total += rows;
        tables.push(StorageTable {
            name: (*name).to_string(),
            purpose: (*purpose).to_string(),
            cap: cap.map(|value| value.to_string()),
            rows: rows.max(0) as u64,
        });
    }
    Ok(StorageReport {
        database_path: database.to_string_lossy().into_owned(),
        database_bytes: std::fs::metadata(&database)
            .map(|meta| meta.len())
            .unwrap_or(0),
        total_rows: total.max(0) as u64,
        tables,
    })
}

#[cfg(test)]
mod tests {
    use super::{build, TABLES};
    use crate::persistence::MIGRATOR;
    use assert_fs::TempDir;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Every table the migrations create must be described, and every table
    /// described must exist — otherwise the page reports a table that is gone,
    /// or silently omits one that holds data.
    #[tokio::test]
    async fn describes_exactly_the_tables_the_database_has() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        let actual: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx%'",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| sqlx::Row::get::<String, _>(&row, "name"))
        .collect();

        let described: Vec<&str> = TABLES.iter().map(|(name, _, _)| *name).collect();
        for name in &actual {
            assert!(
                described.contains(&name.as_str()),
                "{name} is not described"
            );
        }
        for name in &described {
            assert!(actual.contains(&name.to_string()), "{name} does not exist");
        }
    }

    #[tokio::test]
    async fn counts_rows_and_reports_a_missing_database_as_zero_bytes() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO recent_files(path, display_name, handler_id, last_opened_ms) VALUES('a','a','text',1)")
            .execute(&pool)
            .await
            .unwrap();

        let dir = TempDir::new().unwrap();
        let report = build(&pool, dir.path()).await.unwrap();
        let recents = report
            .tables
            .iter()
            .find(|table| table.name == "recent_files")
            .unwrap();
        assert_eq!(recents.rows, 1);
        assert_eq!(recents.cap.as_deref(), Some("100 returned"));
        assert_eq!(report.total_rows, 1);
        // The in-memory pool has no file behind it.
        assert_eq!(report.database_bytes, 0);
        assert!(report.database_path.ends_with("oneopen.sqlite3"));
    }
}
