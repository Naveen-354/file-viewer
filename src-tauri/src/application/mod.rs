use std::path::{Path, PathBuf};

pub fn paths_from_args<I, S>(args: I, working_directory: Option<&str>) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter_map(|raw| {
            let raw = raw.as_ref();
            if raw.starts_with('-') || raw.is_empty() {
                return None;
            }
            let path = Path::new(raw);
            let absolute = if path.is_absolute() {
                path.to_path_buf()
            } else {
                working_directory
                    .map(PathBuf::from)
                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
                    .join(path)
            };
            absolute
                .is_file()
                .then(|| absolute.to_string_lossy().into_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::paths_from_args;
    use assert_fs::{fixture::PathChild, TempDir};

    #[test]
    fn accepts_unicode_and_spaced_cli_paths() {
        let dir = TempDir::new().unwrap();
        let file = dir.child("hello Ω world.txt");
        std::fs::write(file.path(), "ok").unwrap();
        let args = vec!["oneopen".into(), file.path().to_string_lossy().into_owned()];
        assert_eq!(paths_from_args(args, None).len(), 1);
    }
}
