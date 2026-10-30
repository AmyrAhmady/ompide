mod commands;
#[cfg(windows)]
mod windows_chrome;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::NativeState::default())
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                use tauri::Manager;
                let state = webview.state::<commands::NativeState>();
                state
                    .terminal_generation
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                if let Ok(mut terminals) = state.terminals.lock() {
                    terminals.clear();
                }
            }
        })
        .setup(|app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                let window = app.get_webview_window("main").expect("main window missing");
                windows_chrome::install(&window)?;
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
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
            commands::create_entry,
            commands::rename_entry,
            commands::trash_entry,
            commands::git_request,
            commands::cancel_git,
            commands::terminal_shells,
            commands::terminal_start,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_acknowledge,
            commands::terminal_close,
            commands::terminal_close_all,
        ])
        .build(tauri::generate_context!())
        .expect("could not initialize Pawn IDE")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Ok(mut terminals) = app.state::<commands::NativeState>().terminals.lock() {
                    terminals.clear();
                }
                if let Ok(git) = app.state::<commands::NativeState>().git.lock()
                    && let Some((_, signal)) = git.as_ref()
                {
                    signal.store(true, std::sync::atomic::Ordering::Release);
                }
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
