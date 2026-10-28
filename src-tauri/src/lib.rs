mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::NativeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::choose_workspace,
            commands::activate_workspace,
            commands::recent_workspace,
            commands::choose_document,
            commands::remember_document,
            commands::recent_document,
            commands::read_document,
            commands::save_document,
            commands::save_document_as,
            commands::list_directory,
            commands::load_preferences,
            commands::store_preferences,
            commands::lsp_start,
            commands::choose_language_server,
            commands::lsp_send,
            commands::lsp_stop,
            commands::watch_start,
            commands::watch_stop,
        ])
        .build(tauri::generate_context!())
        .expect("could not initialize Pawn IDE")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Ok(mut session) = app.state::<commands::NativeState>().lsp.lock() {
                    session.take();
                }
                if let Ok(mut watch) = app.state::<commands::NativeState>().watch.lock() {
                    watch.take();
                }
            }
        });
}
