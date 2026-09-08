use dashmap::DashMap;
use sqlx::SqlitePool;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

pub struct AppState {
    pub database: SqlitePool,
    pub cancellations: Arc<DashMap<String, Arc<AtomicBool>>>,
    pub startup_files: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new(database: SqlitePool, startup_files: Vec<String>) -> Self {
        Self {
            database,
            cancellations: Arc::new(DashMap::new()),
            startup_files: Mutex::new(startup_files),
        }
    }
}
