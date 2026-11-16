#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;
mod document_links;
mod documents;
mod goals;
mod issues;
mod labels;
mod milestones;
mod overview;
mod portability;
mod projects;
mod relationships;
mod saved_views;
mod search;
#[cfg(test)]
mod test_support;

fn main() {
    tauri::Builder::default()
        .plugin(database::plugin())
        // Used only from Rust to ask where to save exports. The webview has no
        // dialog permissions.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            database::database_status,
            relationships::list_issue_relationships,
            relationships::add_issue_relationship,
            relationships::remove_issue_relationship,
            goals::list_project_goals,
            goals::save_project_mission,
            goals::save_project_objective,
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
            issues::set_issue_milestone,
            issues::set_issue_due_date,
            issues::set_issue_recurrence,
            issues::get_issue_recurrence,
            issues::archive_issue,
            issues::restore_issue,
            issues::get_issue_deletion_impact,
            issues::delete_issue,
            saved_views::list_saved_views,
            saved_views::get_saved_view,
            saved_views::create_saved_view,
            saved_views::update_saved_view,
            saved_views::delete_saved_view,
            document_links::list_issue_documents,
            document_links::link_issue_document,
            document_links::unlink_issue_document,
            document_links::list_project_documents,
            document_links::link_project_document,
            document_links::unlink_project_document,
            document_links::get_document_usage,
            overview::get_project_overview,
            search::search_workspace,
            portability::export_project_data,
            portability::export_issues_csv,
            portability::preview_import,
            portability::import_project_data,
            labels::list_labels,
            labels::create_label,
            labels::update_label,
            labels::archive_label,
            labels::restore_label,
            milestones::list_milestones,
            milestones::get_milestone,
            milestones::create_milestone,
            milestones::update_milestone,
            milestones::close_milestone,
            milestones::reopen_milestone
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Unhollowed 2");
}
