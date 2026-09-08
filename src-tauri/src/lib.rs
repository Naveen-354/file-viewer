mod application;
mod commands;
mod domain;
mod engine_report;
mod file_detection;
mod file_io;
mod handlers;
mod persistence;
mod platform;
mod security;
mod state;
mod storage_report;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_files = application::paths_from_args(std::env::args(), None);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let files = application::paths_from_args(args, Some(&cwd));
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let database = tauri::async_runtime::block_on(persistence::connect(&data_dir))
                .map_err(|error| error.to_string())?;
            app.manage(state::AppState::new(database, startup_files));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect_file,
            commands::read_file_chunk,
            commands::read_file_metadata,
            commands::save_text_file,
            commands::save_text_as,
            commands::save_pdf_file,
            commands::save_pdf_as,
            commands::save_image_frame,
            commands::open_with_system,
            commands::show_in_folder,
            commands::print_file,
            commands::get_recent_files,
            commands::set_pinned,
            commands::get_workspaces,
            commands::create_workspace,
            commands::activate_workspace,
            commands::remove_workspace,
            commands::pin_file,
            commands::unpin_file,
            commands::rename_file,
            commands::get_engine_report,
            commands::get_storage_report,
            commands::clear_recent_files,
            commands::clear_saved_session,
            commands::list_directory,
            commands::get_settings,
            commands::update_settings,
            commands::load_session,
            commands::save_session,
            commands::get_window_state,
            commands::save_window_state,
            commands::read_spreadsheet,
            commands::read_document,
            commands::edit_spreadsheet,
            commands::get_image_formats,
            commands::convert_image,
            commands::list_archive_entries,
            commands::extract_archive_entries,
            commands::cancel_operation,
            commands::take_startup_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneOpen");
}
