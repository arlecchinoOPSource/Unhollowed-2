#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(test)]
mod acceptance_tests;

mod analytics;
mod checkins;
mod dashboards;
mod database;
mod document_links;
mod documents;
mod goals;
mod habits;
mod issues;
mod labels;
mod milestones;
mod overview;
#[cfg(test)]
mod perf_tests;
#[cfg(test)]
mod phase4_journey;
mod portability;
mod projects;
mod relationships;
mod saved_views;
mod scheduling;
mod search;
#[cfg(test)]
mod test_support;

fn main() {
    tauri::Builder::default()
        .plugin(database::plugin())
        // Used only from Rust to ask where to save exports. The webview has no
        // dialog permissions.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            database::database_status,
            relationships::list_issue_relationships,
            relationships::add_issue_relationship,
            relationships::remove_issue_relationship,
            goals::list_project_goals,
            goals::save_project_mission,
            goals::save_project_objective,
            documents::list_documents,
            documents::library::list_document_library,
            documents::references::list_document_references,
            documents::references::get_document_graph,
            documents::library::create_document_folder,
            documents::library::change_document_library,
            documents::library::create_library_document,
            documents::library::duplicate_document,
            documents::assets::store_document_image,
            documents::assets::get_document_image,
            documents::get_document,
            documents::printing::print_document,
            scheduling::list_calendar_items,
            scheduling::list_calendars,
            scheduling::create_calendar_event,
            scheduling::get_calendar_event,
            scheduling::create_issue_work_block,
            scheduling::reminders::get_reminders_enabled,
            scheduling::reminders::set_reminders_enabled,
            scheduling::reminders::get_event_reminder,
            scheduling::reminders::set_event_reminder,
            scheduling::reminders::claim_due_reminders,
            scheduling::reminders::send_test_notification,
            scheduling::ics::pick_ics_file,
            scheduling::ics::preview_ics_import,
            scheduling::ics::import_ics,
            scheduling::ics::export_calendar_ics,
            scheduling::links::get_event_links,
            scheduling::links::link_event_document,
            scheduling::links::unlink_event_document,
            scheduling::links::link_event_project,
            scheduling::links::unlink_event_project,
            scheduling::update_issue_work_block,
            scheduling::list_issue_work_blocks,
            scheduling::delete_issue_work_block,
            scheduling::search::search_calendar_items,
            scheduling::calendars::create_calendar,
            scheduling::calendars::update_calendar,
            scheduling::calendars::set_calendar_hidden,
            scheduling::calendars::set_default_calendar,
            scheduling::calendars::archive_calendar,
            scheduling::calendars::restore_calendar,
            scheduling::calendars::move_calendar_event,
            scheduling::events::update_calendar_event,
            scheduling::events::duplicate_calendar_event,
            scheduling::events::delete_calendar_event,
            scheduling::recurrence::update_event_occurrence,
            scheduling::recurrence::cancel_event_occurrence,
            scheduling::recurrence::restore_event_occurrence,
            scheduling::recurrence::split_event_series,
            scheduling::recurrence::end_event_series,
            documents::create_document,
            documents::update_document,
            documents::revisions::list_document_revisions,
            documents::revisions::restore_document_revision,
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
            dashboards::list_dashboards,
            dashboards::save_dashboard,
            dashboards::set_default_dashboard,
            dashboards::delete_dashboard,
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
            portability::save_document_file,
            portability::export_issues_csv,
            portability::preview_import,
            portability::import_project_data,
            habits::list_habits,
            habits::create_habit,
            habits::rename_habit,
            habits::reorder_habits,
            habits::archive_habit,
            habits::restore_habit,
            habits::get_habit_deletion_impact,
            habits::delete_habit,
            habits::get_habit_month,
            habits::list_habit_history,
            habits::set_habit_completion,
            habits::import::pick_habit_backup,
            habits::import::preview_habit_import,
            habits::import::import_habits,
            habits::backup::export_habit_backup,
            habits::backup::export_habit_history,
            habits::backup::pick_habit_restore,
            habits::backup::preview_habit_restore,
            habits::backup::restore_habits,
            habits::backup::undo_habit_restore,
            habits::stats::get_habit_statistics,
            habits::routines::list_habit_routines,
            habits::routines::list_routine_choices,
            habits::routines::link_habit_routine,
            habits::routines::unlink_habit_routine,
            habits::routines::list_routine_habits,
            checkins::get_checkin,
            checkins::list_checkins,
            checkins::save_checkin,
            checkins::delete_checkin,
            checkins::analytics::get_checkin_analytics,
            analytics::get_workspace_analytics,
            analytics::progress::get_progress_analytics,
            analytics::schedule::get_schedule_analytics,
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
