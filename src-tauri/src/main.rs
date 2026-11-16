#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;
mod documents;
mod issues;
mod labels;
mod projects;
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
            documents::update_document,
            projects::list_projects,
            projects::get_project,
            projects::create_project,
            projects::update_project,
            projects::change_project_status,
            projects::archive_project,
            issues::list_issues,
            issues::query_issues,
            issues::get_issue,
            issues::create_issue,
            issues::update_issue,
            issues::change_issue_status,
            issues::complete_issue,
            issues::cancel_issue,
            issues::reopen_issue,
            issues::set_issue_project,
            issues::set_issue_labels,
            labels::list_labels,
            labels::create_label,
            labels::update_label,
            labels::archive_label,
            labels::restore_label
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Unhollowed 2");
}
