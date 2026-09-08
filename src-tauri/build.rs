use std::{collections::HashMap, fs, path::Path};

/// Crates whose resolved versions the Native Engine settings page reports.
///
/// Reading them here keeps the page honest: it shows what Cargo actually
/// resolved for this build, not a number typed into the UI that drifts the
/// moment a dependency is bumped.
const REPORTED: &[&str] = &[
    "tauri",
    "calamine",
    "quick-xml",
    "zip",
    "image",
    "resvg",
    "tiny-skia",
    "sqlx",
    "libsqlite3-sys",
    "infer",
    "encoding_rs",
    "chardetng",
];

fn main() {
    emit_dependency_versions();
    println!(
        "cargo:rustc-env=OO_TARGET={}",
        std::env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );
    tauri_build::build()
}

fn emit_dependency_versions() {
    let lock = Path::new("Cargo.lock");
    println!("cargo:rerun-if-changed=Cargo.lock");
    let text = fs::read_to_string(lock).unwrap_or_default();
    let mut versions: HashMap<&str, String> = HashMap::new();
    let mut name: Option<&str> = None;
    for line in text.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            name = None;
        } else if let Some(value) = line.strip_prefix("name = ") {
            let value = value.trim_matches('"');
            name = REPORTED.iter().find(|entry| **entry == value).copied();
        } else if let Some(value) = line.strip_prefix("version = ") {
            if let Some(found) = name.take() {
                versions
                    .entry(found)
                    .or_insert_with(|| value.trim_matches('"').to_string());
            }
        }
    }
    for crate_name in REPORTED {
        let key = crate_name.to_uppercase().replace('-', "_");
        let value = versions
            .get(crate_name)
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        println!("cargo:rustc-env=OO_VER_{key}={value}");
    }
}
