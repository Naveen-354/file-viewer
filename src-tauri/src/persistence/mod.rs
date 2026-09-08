use crate::domain::{
    AppError, AppResult, CreateWorkspaceRequest, RecentFile, SessionTab, UserSettings, WindowState,
    Workspace, WorkspacePath,
};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use std::path::Path;

pub(crate) static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(data_dir: &Path) -> AppResult<SqlitePool> {
    std::fs::create_dir_all(data_dir).map_err(|error| AppError::io(error, data_dir))?;
    let database = data_dir.join("oneopen.sqlite3");
    let options = SqliteConnectOptions::new()
        .filename(database)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    MIGRATOR
        .run(&pool)
        .await
        .map_err(|error| AppError::new("migration_error", error.to_string()))?;
    Ok(pool)
}

pub async fn record_recent(
    pool: &SqlitePool,
    path: &str,
    display_name: &str,
    handler_id: &str,
) -> AppResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    sqlx::query("INSERT INTO recent_files(path, display_name, handler_id, last_opened_ms) VALUES(?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET display_name=excluded.display_name, handler_id=excluded.handler_id, last_opened_ms=excluded.last_opened_ms")
        .bind(path).bind(display_name).bind(handler_id).bind(now).execute(pool).await?;
    Ok(())
}

/// Moves every stored reference to `from` so a rename does not break a pin, a
/// recent entry or the saved session.
pub async fn repoint_path(pool: &SqlitePool, from: &str, to: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    // The destination may already have a row from an earlier life of that name;
    // dropping it first keeps the UPDATE from colliding with the primary key.
    sqlx::query("DELETE FROM recent_files WHERE path=?")
        .bind(to)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE recent_files SET path=? WHERE path=?")
        .bind(to)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM workspace_pins WHERE path=? AND workspace_id IN (SELECT workspace_id FROM workspace_pins WHERE path=?)")
        .bind(to)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE workspace_pins SET path=? WHERE path=?")
        .bind(to)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE session_tabs SET path=? WHERE path=?")
        .bind(to)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Empties the recent-files table. Workspace pins live in their own table and
/// are deliberately left alone.
pub async fn clear_recent_files(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM recent_files")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn recent_files(pool: &SqlitePool) -> AppResult<Vec<RecentFile>> {
    let rows = sqlx::query("SELECT path, display_name, handler_id, last_opened_ms, pinned FROM recent_files ORDER BY pinned DESC, last_opened_ms DESC LIMIT 100").fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let path: String = row.get("path");
            let metadata = std::fs::metadata(&path).ok();
            RecentFile {
                exists: metadata.as_ref().is_some_and(std::fs::Metadata::is_file),
                size: metadata.as_ref().map_or(0, std::fs::Metadata::len),
                path,
                display_name: row.get("display_name"),
                handler_id: row.get("handler_id"),
                last_opened_ms: row.get("last_opened_ms"),
                pinned: row.get::<i64, _>("pinned") != 0,
            }
        })
        .collect())
}

pub async fn set_pinned(pool: &SqlitePool, path: &str, pinned: bool) -> AppResult<()> {
    sqlx::query("UPDATE recent_files SET pinned=? WHERE path=?")
        .bind(i64::from(pinned))
        .bind(path)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn workspaces(pool: &SqlitePool) -> AppResult<Vec<Workspace>> {
    let rows = sqlx::query("SELECT id, name, restore_last_session, last_opened_ms FROM workspaces ORDER BY last_opened_ms DESC").fetch_all(pool).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        let folder_rows = sqlx::query(
            "SELECT path FROM workspace_folders WHERE workspace_id=? ORDER BY position",
        )
        .bind(&id)
        .fetch_all(pool)
        .await?;
        let pin_rows =
            sqlx::query("SELECT path FROM workspace_pins WHERE workspace_id=? ORDER BY position")
                .bind(&id)
                .fetch_all(pool)
                .await?;
        result.push(Workspace {
            id,
            name: row.get("name"),
            folders: folder_rows
                .into_iter()
                .map(|value| workspace_path(value.get::<String, _>("path"), true))
                .collect(),
            pinned_files: pin_rows
                .into_iter()
                .map(|value| workspace_path(value.get::<String, _>("path"), false))
                .collect(),
            restore_last_session: row.get::<i64, _>("restore_last_session") != 0,
            last_opened_ms: row.get("last_opened_ms"),
        });
    }
    Ok(result)
}

pub async fn create_workspace(
    pool: &SqlitePool,
    request: &CreateWorkspaceRequest,
) -> AppResult<Workspace> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::new(
            "invalid_workspace",
            "Workspace name must contain 1–80 characters",
        ));
    }
    if request.folders.is_empty() || request.folders.len() > 20 || request.pinned_files.len() > 50 {
        return Err(AppError::new(
            "invalid_workspace",
            "Choose 1–20 folders and up to 50 pinned files",
        ));
    }
    if request.folders.iter().any(|path| !Path::new(path).is_dir())
        || request
            .pinned_files
            .iter()
            .any(|path| !Path::new(path).is_file())
    {
        return Err(AppError::new(
            "invalid_workspace_path",
            "Every selected folder and pinned file must exist",
        ));
    }
    // Stored in canonical form so a pin added here and one added later through
    // `pin_file` are the same row, and so both match an open tab's path.
    let folders: Vec<String> = request
        .folders
        .iter()
        .map(|path| {
            crate::security::canonical_directory(path)
                .map(|value| value.to_string_lossy().into_owned())
        })
        .collect::<AppResult<_>>()?;
    let pinned_files: Vec<String> = request
        .pinned_files
        .iter()
        .map(|path| {
            crate::security::canonical_file(path).map(|value| value.to_string_lossy().into_owned())
        })
        .collect::<AppResult<_>>()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let id = format!("ws-{now}-{}", std::process::id());
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO workspaces(id, name, restore_last_session, created_ms, last_opened_ms) VALUES(?, ?, ?, ?, ?)")
        .bind(&id).bind(name).bind(i64::from(request.restore_last_session)).bind(now).bind(now).execute(&mut *tx).await?;
    for (position, path) in folders.iter().enumerate() {
        sqlx::query("INSERT INTO workspace_folders(workspace_id, position, path) VALUES(?, ?, ?)")
            .bind(&id)
            .bind(position as i64)
            .bind(path)
            .execute(&mut *tx)
            .await?;
    }
    for (position, path) in pinned_files.iter().enumerate() {
        sqlx::query("INSERT INTO workspace_pins(workspace_id, position, path) VALUES(?, ?, ?)")
            .bind(&id)
            .bind(position as i64)
            .bind(path)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Workspace {
        id,
        name: name.to_string(),
        folders: folders
            .into_iter()
            .map(|path| workspace_path(path, true))
            .collect(),
        pinned_files: pinned_files
            .into_iter()
            .map(|path| workspace_path(path, false))
            .collect(),
        restore_last_session: request.restore_last_session,
        last_opened_ms: now,
    })
}

pub async fn activate_workspace(pool: &SqlitePool, id: &str) -> AppResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let result = sqlx::query("UPDATE workspaces SET last_opened_ms=? WHERE id=?")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::new(
            "workspace_not_found",
            "Workspace no longer exists",
        ));
    }
    Ok(())
}

pub async fn remove_workspace(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM workspaces WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// A workspace holds at most this many pinned files, matching the limit
/// `create_workspace` enforces when the workspace is first created.
const MAX_PINS: usize = 50;

async fn pins_of(pool: &SqlitePool, workspace_id: &str) -> AppResult<Vec<WorkspacePath>> {
    let rows =
        sqlx::query("SELECT path FROM workspace_pins WHERE workspace_id=? ORDER BY position")
            .bind(workspace_id)
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|row| workspace_path(row.get::<String, _>("path"), false))
        .collect())
}

/// Adds a file to a workspace's pins and returns the new pin list.
///
/// The path is canonicalised here so a pin matches the path an open tab
/// carries, which is what lets the UI tell a pinned file from an unpinned one.
/// Rows for an older spelling of the same file are replaced rather than
/// duplicated.
pub async fn pin_file(
    pool: &SqlitePool,
    workspace_id: &str,
    path: &str,
) -> AppResult<Vec<WorkspacePath>> {
    let canonical = crate::security::canonical_file(path)?;
    let stored = canonical.to_string_lossy().into_owned();
    let known = sqlx::query_scalar::<_, String>("SELECT id FROM workspaces WHERE id=?")
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?;
    if known.is_none() {
        return Err(AppError::new(
            "workspace_not_found",
            "Workspace no longer exists",
        ));
    }
    let mut tx = pool.begin().await?;
    let removed = sqlx::query("DELETE FROM workspace_pins WHERE workspace_id=? AND path IN (?, ?)")
        .bind(workspace_id)
        .bind(path)
        .bind(&stored)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspace_pins WHERE workspace_id=?")
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await?;
    if count as usize >= MAX_PINS {
        return Err(AppError::new(
            "pin_limit",
            "A workspace holds at most 50 pinned files",
        ));
    }
    // Re-pinning an existing file keeps its place in the list.
    let position = if removed > 0 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MIN(position), 0) FROM workspace_pins WHERE workspace_id=?",
        )
        .bind(workspace_id)
        .fetch_one(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM workspace_pins WHERE workspace_id=?",
        )
        .bind(workspace_id)
        .fetch_one(&mut *tx)
        .await?
    };
    sqlx::query("INSERT INTO workspace_pins(workspace_id, position, path) VALUES(?, ?, ?)")
        .bind(workspace_id)
        .bind(position)
        .bind(&stored)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    pins_of(pool, workspace_id).await
}

/// Removes a pin by the exact path stored, so a file that has since been
/// deleted or moved can still be unpinned.
pub async fn unpin_file(
    pool: &SqlitePool,
    workspace_id: &str,
    path: &str,
) -> AppResult<Vec<WorkspacePath>> {
    sqlx::query("DELETE FROM workspace_pins WHERE workspace_id=? AND path=?")
        .bind(workspace_id)
        .bind(path)
        .execute(pool)
        .await?;
    pins_of(pool, workspace_id).await
}

fn workspace_path(path: String, directory: bool) -> WorkspacePath {
    let value = Path::new(&path);
    WorkspacePath {
        name: value
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_string(),
        exists: if directory {
            value.is_dir()
        } else {
            value.is_file()
        },
        path,
    }
}

pub async fn get_settings(pool: &SqlitePool) -> AppResult<UserSettings> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='user'")
        .fetch_optional(pool)
        .await?;
    match value {
        Some(json) => serde_json::from_str(&json)
            .map_err(|error| AppError::new("settings_error", error.to_string())),
        None => Ok(UserSettings::default()),
    }
}

pub async fn update_settings(pool: &SqlitePool, settings: &UserSettings) -> AppResult<()> {
    validate_settings(settings)?;
    let value = serde_json::to_string(settings)
        .map_err(|error| AppError::new("settings_error", error.to_string()))?;
    sqlx::query("INSERT INTO settings(key, value) VALUES('user', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value).execute(pool).await?;
    Ok(())
}

/// The viewers a file can be routed to. Must match `handlers/registry.ts`.
const HANDLER_IDS: &[&str] = &[
    "text",
    "structured",
    "csv",
    "sql",
    "image",
    "pdf",
    "media",
    "spreadsheet",
    "document",
    "archive",
    "fallback",
];

/// Every option here reaches the UI as a CSS class, a font stack or a window
/// effect name, so each one is checked against a closed list rather than being
/// passed through. The lists have to stay in step with the settings page.
fn validate_settings(settings: &UserSettings) -> AppResult<()> {
    let one_of = |value: &str, allowed: &[&str], what: &str| -> AppResult<()> {
        if allowed.contains(&value) {
            Ok(())
        } else {
            Err(AppError::new(
                "invalid_settings",
                format!("Unsupported {what}"),
            ))
        }
    };
    one_of(&settings.theme, &["light", "dark", "system"], "theme")?;
    one_of(
        &settings.accent,
        &["indigo", "cyan", "emerald", "amber", "violet"],
        "accent colour",
    )?;
    one_of(
        &settings.window_effect,
        &["none", "mica", "acrylic", "tabbed"],
        "window effect",
    )?;
    one_of(&settings.tab_overflow, &["scroll", "wrap"], "tab layout")?;
    one_of(
        &settings.mono_font,
        &["cascadia", "consolas", "jetbrains", "fira", "ibm", "system"],
        "editor font",
    )?;
    if !(10..=24).contains(&settings.editor_font_size) {
        return Err(AppError::new(
            "invalid_settings",
            "Editor font size must be between 10 and 24",
        ));
    }
    // Overrides name a viewer for an extension, so both halves are checked
    // against closed lists rather than being stored as typed.
    if settings.handler_overrides.len() > 40 {
        return Err(AppError::new(
            "invalid_settings",
            "Too many handler overrides",
        ));
    }
    for (extension, handler) in &settings.handler_overrides {
        if extension.is_empty()
            || extension.len() > 12
            || !extension
                .chars()
                .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            return Err(AppError::new(
                "invalid_settings",
                format!("{extension} is not a file extension"),
            ));
        }
        one_of(handler, HANDLER_IDS, "handler")?;
    }
    if settings
        .csv_delimiter
        .as_ref()
        .is_some_and(|value| ![",", "\t", ";", "|"].contains(&value.as_str()))
    {
        return Err(AppError::new(
            "invalid_settings",
            "Unsupported CSV delimiter",
        ));
    }
    Ok(())
}

pub async fn load_session(pool: &SqlitePool) -> AppResult<Vec<SessionTab>> {
    let rows = sqlx::query("SELECT path, active FROM session_tabs ORDER BY position")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let path: String = row.get("path");
            Path::new(&path).is_file().then(|| SessionTab {
                path,
                active: row.get::<i64, _>("active") != 0,
            })
        })
        .collect())
}

pub async fn save_session(pool: &SqlitePool, tabs: &[SessionTab]) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM session_tabs")
        .execute(&mut *tx)
        .await?;
    for (position, tab) in tabs.iter().take(50).enumerate() {
        sqlx::query("INSERT INTO session_tabs(position, path, active) VALUES(?, ?, ?)")
            .bind(position as i64)
            .bind(&tab.path)
            .bind(i64::from(tab.active))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn get_window_state(pool: &SqlitePool) -> AppResult<Option<WindowState>> {
    let row = sqlx::query(
        "SELECT x, y, width, height, maximized FROM window_state WHERE window_label='main'",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| WindowState {
        x: row.get("x"),
        y: row.get("y"),
        width: row.get::<i64, _>("width") as u32,
        height: row.get::<i64, _>("height") as u32,
        maximized: row.get::<i64, _>("maximized") != 0,
    }))
}

pub async fn save_window_state(pool: &SqlitePool, value: &WindowState) -> AppResult<()> {
    if value.width < 400 || value.height < 300 || value.width > 16_384 || value.height > 16_384 {
        return Err(AppError::new(
            "invalid_window_state",
            "Window dimensions are outside safe bounds",
        ));
    }
    sqlx::query("INSERT INTO window_state(window_label, x, y, width, height, maximized) VALUES('main', ?, ?, ?, ?, ?) ON CONFLICT(window_label) DO UPDATE SET x=excluded.x, y=excluded.y, width=excluded.width, height=excluded.height, maximized=excluded.maximized")
        .bind(value.x).bind(value.y).bind(value.width).bind(value.height).bind(i64::from(value.maximized)).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        create_workspace, get_settings, load_session, pin_file, recent_files, record_recent,
        remove_workspace, repoint_path, save_session, unpin_file, update_settings, workspaces,
        CreateWorkspaceRequest, SessionTab, UserSettings, MIGRATOR,
    };
    use assert_fs::{fixture::PathChild, TempDir};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn migrations_and_session_round_trip() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        let settings = UserSettings {
            theme: "dark".into(),
            word_wrap: false,
            csv_delimiter: Some(";".into()),
            ..UserSettings::default()
        };
        update_settings(&pool, &settings).await.unwrap();
        assert_eq!(get_settings(&pool).await.unwrap().theme, "dark");
        save_session(
            &pool,
            &[SessionTab {
                path: "missing-file".into(),
                active: true,
            }],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn removing_workspace_preserves_source_files() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        let source = TempDir::new().unwrap();
        let pinned = source.child("keep.txt");
        std::fs::write(pinned.path(), "keep me").unwrap();
        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![pinned.path().to_string_lossy().into_owned()],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(workspaces(&pool).await.unwrap().len(), 1);
        remove_workspace(&pool, &created.id).await.unwrap();
        assert!(workspaces(&pool).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(pinned.path()).unwrap(), "keep me");
    }

    #[tokio::test]
    async fn pins_a_file_after_the_workspace_exists() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let first = source.child("one.txt");
        let second = source.child("two.txt");
        std::fs::write(first.path(), "1").unwrap();
        std::fs::write(second.path(), "2").unwrap();
        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        assert!(created.pinned_files.is_empty());

        let pins = pin_file(&pool, &created.id, &first.path().to_string_lossy())
            .await
            .unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].name, "one.txt");
        assert!(pins[0].exists);

        let pins = pin_file(&pool, &created.id, &second.path().to_string_lossy())
            .await
            .unwrap();
        assert_eq!(pins.len(), 2);
        // A reload sees the same pins, so the pin outlived the call.
        let reloaded = workspaces(&pool).await.unwrap();
        assert_eq!(reloaded[0].pinned_files.len(), 2);
    }

    #[tokio::test]
    async fn pinning_the_same_file_twice_does_not_duplicate_it() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let file = source.child("one.txt");
        std::fs::write(file.path(), "1").unwrap();
        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![file.path().to_string_lossy().into_owned()],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        let pins = pin_file(&pool, &created.id, &file.path().to_string_lossy())
            .await
            .unwrap();
        assert_eq!(pins.len(), 1);
    }

    #[tokio::test]
    async fn unpins_a_file_that_no_longer_exists_on_disk() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let file = source.child("gone.txt");
        std::fs::write(file.path(), "bye").unwrap();
        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![file.path().to_string_lossy().into_owned()],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        let stored = created.pinned_files[0].path.clone();
        std::fs::remove_file(file.path()).unwrap();
        assert!(!workspaces(&pool).await.unwrap()[0].pinned_files[0].exists);
        let pins = unpin_file(&pool, &created.id, &stored).await.unwrap();
        assert!(pins.is_empty());
    }

    #[tokio::test]
    async fn refuses_to_pin_into_a_workspace_that_is_gone() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let file = source.child("one.txt");
        std::fs::write(file.path(), "1").unwrap();
        let error = pin_file(&pool, "ws-missing", &file.path().to_string_lossy())
            .await
            .unwrap_err();
        assert_eq!(error.code, "workspace_not_found");
    }

    #[tokio::test]
    async fn refuses_to_pin_a_directory() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        let error = pin_file(&pool, &created.id, &source.path().to_string_lossy())
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_a_file");
    }

    #[tokio::test]
    async fn repointing_a_path_carries_pins_recents_and_the_session() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let file = source.child("old.sql");
        std::fs::write(file.path(), "select 1;").unwrap();
        let old = file.path().to_string_lossy().into_owned();
        let new = source
            .child("new.sql")
            .path()
            .to_string_lossy()
            .into_owned();

        let created = create_workspace(
            &pool,
            &CreateWorkspaceRequest {
                name: "Local files".into(),
                folders: vec![source.path().to_string_lossy().into_owned()],
                pinned_files: vec![old.clone()],
                restore_last_session: true,
            },
        )
        .await
        .unwrap();
        // Everything the app stores comes from a canonicalised descriptor path,
        // so the test uses the same spelling the pin was stored under.
        let stored = created.pinned_files[0].path.clone();
        record_recent(&pool, &stored, "old.sql", "sql")
            .await
            .unwrap();
        save_session(
            &pool,
            &[SessionTab {
                path: stored.clone(),
                active: true,
            }],
        )
        .await
        .unwrap();

        std::fs::rename(file.path(), source.child("new.sql").path()).unwrap();
        repoint_path(&pool, &stored, &new).await.unwrap();

        assert_eq!(
            workspaces(&pool).await.unwrap()[0].pinned_files[0].path,
            new
        );
        assert!(workspaces(&pool).await.unwrap()[0].pinned_files[0].exists);
        assert_eq!(load_session(&pool).await.unwrap()[0].path, new);
        let recents = recent_files(&pool).await.unwrap();
        assert!(recents.iter().any(|entry| entry.path == new));
        assert!(!recents.iter().any(|entry| entry.path == stored));
    }

    #[tokio::test]
    async fn repointing_onto_a_name_that_was_used_before_replaces_the_old_row() {
        let pool = pool().await;
        let source = TempDir::new().unwrap();
        let old = source
            .child("old.sql")
            .path()
            .to_string_lossy()
            .into_owned();
        let new = source
            .child("new.sql")
            .path()
            .to_string_lossy()
            .into_owned();
        record_recent(&pool, &old, "old.sql", "sql").await.unwrap();
        // `new.sql` existed at some point and left a stale recent entry behind.
        record_recent(&pool, &new, "new.sql", "sql").await.unwrap();

        repoint_path(&pool, &old, &new).await.unwrap();

        let recents = recent_files(&pool).await.unwrap();
        assert_eq!(recents.iter().filter(|entry| entry.path == new).count(), 1);
        assert!(!recents.iter().any(|entry| entry.path == old));
    }

    #[tokio::test]
    async fn rejects_a_setting_that_is_not_on_its_list() {
        let pool = pool().await;
        for broken in [
            UserSettings {
                theme: "neon".into(),
                ..UserSettings::default()
            },
            UserSettings {
                accent: "puce".into(),
                ..UserSettings::default()
            },
            UserSettings {
                window_effect: "blur".into(),
                ..UserSettings::default()
            },
            UserSettings {
                tab_overflow: "carousel".into(),
                ..UserSettings::default()
            },
            UserSettings {
                mono_font: "comic".into(),
                ..UserSettings::default()
            },
            UserSettings {
                editor_font_size: 9,
                ..UserSettings::default()
            },
            UserSettings {
                editor_font_size: 25,
                ..UserSettings::default()
            },
            UserSettings {
                csv_delimiter: Some("::".into()),
                ..UserSettings::default()
            },
            // An override must name a real viewer and a plausible extension.
            UserSettings {
                handler_overrides: [("json".to_string(), "hexeditor".to_string())].into(),
                ..UserSettings::default()
            },
            UserSettings {
                handler_overrides: [("../etc".to_string(), "text".to_string())].into(),
                ..UserSettings::default()
            },
            UserSettings {
                handler_overrides: [("JSON".to_string(), "text".to_string())].into(),
                ..UserSettings::default()
            },
        ] {
            let error = update_settings(&pool, &broken).await.unwrap_err();
            assert_eq!(error.code, "invalid_settings");
        }
    }

    #[tokio::test]
    async fn settings_saved_before_the_new_fields_existed_still_load() {
        let pool = pool().await;
        // Exactly what the first release wrote.
        sqlx::query("INSERT INTO settings(key, value) VALUES('user', ?)")
            .bind(r#"{"theme":"dark","wordWrap":false,"csvDelimiter":";","restoreSession":false}"#)
            .execute(&pool)
            .await
            .unwrap();
        let loaded = get_settings(&pool).await.unwrap();
        assert_eq!(loaded.theme, "dark");
        assert!(!loaded.word_wrap);
        assert!(!loaded.restore_session);
        // The fields added later fall back to their defaults instead of failing.
        assert_eq!(loaded.accent, "indigo");
        assert_eq!(loaded.window_effect, "none");
        assert_eq!(loaded.editor_font_size, 13);
        assert!(loaded.ligatures);
    }

    #[tokio::test]
    async fn every_new_setting_survives_a_round_trip() {
        let pool = pool().await;
        let settings = UserSettings {
            theme: "light".into(),
            accent: "violet".into(),
            window_effect: "mica".into(),
            tab_overflow: "wrap".into(),
            compact_density: true,
            mono_font: "jetbrains".into(),
            editor_font_size: 16,
            ligatures: false,
            tabular_figures: false,
            ..UserSettings::default()
        };
        update_settings(&pool, &settings).await.unwrap();
        let loaded = get_settings(&pool).await.unwrap();
        assert_eq!(loaded.accent, "violet");
        assert_eq!(loaded.window_effect, "mica");
        assert_eq!(loaded.tab_overflow, "wrap");
        assert!(loaded.compact_density);
        assert_eq!(loaded.mono_font, "jetbrains");
        assert_eq!(loaded.editor_font_size, 16);
        assert!(!loaded.ligatures);
        assert!(!loaded.tabular_figures);
    }

    #[tokio::test]
    async fn keeps_handler_overrides_across_a_round_trip() {
        let pool = pool().await;
        let settings = UserSettings {
            handler_overrides: [
                ("json".to_string(), "text".to_string()),
                ("csv".to_string(), "text".to_string()),
            ]
            .into(),
            ..UserSettings::default()
        };
        update_settings(&pool, &settings).await.unwrap();
        let loaded = get_settings(&pool).await.unwrap();
        assert_eq!(loaded.handler_overrides.get("json").unwrap(), "text");
        assert_eq!(loaded.handler_overrides.len(), 2);
    }
}
