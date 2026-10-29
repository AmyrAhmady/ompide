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
            commands::discover_projects,
            commands::inspect_project,
            commands::build_tools,
            commands::choose_build_tool,
            commands::preview_project,
            commands::create_project,
            commands::build_project,
            commands::cancel_build,
            commands::search_workspace,
            commands::cancel_search,
        ])
        .build(tauri::generate_context!())
        .expect("could not initialize Pawn IDE")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Ok(search) = app.state::<commands::NativeState>().search.lock()
                    && let Some((_, cancel)) = search.as_ref()
                {
                    cancel.store(true, std::sync::atomic::Ordering::Release);
                }
                if let Ok(build) = app.state::<commands::NativeState>().build.lock()
                    && let Some(task) = build.as_ref()
                {
                    task.cancel
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                if let Ok(mut session) = app.state::<commands::NativeState>().lsp.lock() {
                    session.take();
                }
                if let Ok(mut watch) = app.state::<commands::NativeState>().watch.lock() {
                    watch.take();
                }
            }
        });
}
