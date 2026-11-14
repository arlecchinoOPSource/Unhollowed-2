#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;
mod documents;
#[cfg(test)]
mod test_support;

fn main() {
    tauri::Builder::default()
        .plugin(database::plugin())
        .invoke_handler(tauri::generate_handler![
            database::database_status,
            documents::list_documents,
            documents::get_document,
            documents::create_document,
            documents::update_document
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Unhollowed 2");
}
