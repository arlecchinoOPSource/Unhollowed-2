#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;

fn main() {
    tauri::Builder::default()
        .plugin(database::plugin())
        .invoke_handler(tauri::generate_handler![database::database_status])
        .run(tauri::generate_context!())
        .expect("failed to start Unhollowed 2");
}
