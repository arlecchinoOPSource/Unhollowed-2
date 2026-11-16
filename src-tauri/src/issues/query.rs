//! Issue search, filtering, sorting, and paging.
//!
//! `IssueFilter` is the shared filter definition. The list page uses it now,
//! and board and saved views can store and reuse the same JSON shape.
//!
//! Search strategy: each issue stores `search_text`, the title and the
//! readable text of its Tiptap description, lowercased with Rust's full
//! Unicode rules. Queries are lowercased the same way and matched as literal
//! substrings with `instr`, so `%` and `_` have no special meaning. Workspaces
//! hold hundreds of issues, so a scan of the workspace's rows is fast enough
//! without a full-text index.

use super::{storage_failed, IssueError, IssueSummary, PRIORITIES, STATUSES, SUMMARY_FIELDS};
use crate::projects::valid_date;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

pub const DEFAULT_LIMIT: u32 = 100;
pub const MAX_LIMIT: u32 = 200;
const MAX_TEXT_CHARS: usize = 200;
const MAX_LIST_ITEMS: usize = 100;

/// Combinable issue filters. Empty lists and `None` mean "no restriction".
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueFilter {
    /// Literal text to find in the title or description.
    pub text: Option<String>,
    /// `open`, `closed`, or `all` (the default).
    pub state: Option<String>,
    pub statuses: Vec<String>,
    pub priorities: Vec<String>,
    /// Issues in any of these projects.
    pub project_ids: Vec<String>,
    /// Also match issues with no project (the Inbox).
    pub inbox: bool,
    /// Inclusive local dates. A range matches only dated issues unless
    /// `undated` is `include`.
    pub due_after: Option<String>,
    pub due_before: Option<String>,
    /// `include` (the default), `exclude`, or `only` issues without a due date.
    pub undated: Option<String>,
    /// Issues carrying these labels. Archived labels still match.
    pub label_ids: Vec<String>,
    /// `any` (the default) matches at least one label, `all` every label.
    pub label_match: Option<String>,
    /// Issues in any of these milestones.
    pub milestone_ids: Vec<String>,
    /// Also match issues without a milestone.
    pub no_milestone: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueQuery {
    #[serde(flatten)]
    pub filter: IssueFilter,
    /// `updated` (the default), `created`, `priority`, `title`, or `due`.
    pub sort: Option<String>,
    /// `asc` or `desc`. Defaults to `desc`, except `asc` for title and due.
    pub direction: Option<String>,
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub issues: Vec<IssueSummary>,
    /// Matches for the whole filter, across all pages.
    pub total: i64,
    /// Matches for the filter without its state, split by open and closed.
    pub open: i64,
    pub closed: i64,
}

/// Returns the searchable form of an issue: the title and the text nodes of a
/// Tiptap document, with a line break after each block, lowercased.
pub(crate) fn search_text(title: &str, description: &str) -> String {
    fn collect(node: &Value, out: &mut String) {
        match node.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = node.get("text").and_then(Value::as_str) {
                    out.push_str(text);
                }
            }
            Some("hardBreak") => out.push('\n'),
            kind => {
                for child in node
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    collect(child, out);
                }
                if kind != Some("doc") {
                    out.push('\n');
                }
            }
        }
    }
    let mut out = format!("{title}\n");
    if let Ok(document) = serde_json::from_str::<Value>(description) {
        collect(&document, &mut out);
    }
    out.to_lowercase()
}

enum Undated {
    Include,
    Exclude,
    Only,
}

struct ValidQuery {
    text: Option<String>,
    closed: Option<bool>,
    statuses: Vec<String>,
    priorities: Vec<String>,
    project_ids: Vec<String>,
    inbox: bool,
    due_after: Option<String>,
    due_before: Option<String>,
    undated: Undated,
    label_ids: Vec<String>,
    match_all_labels: bool,
    milestone_ids: Vec<String>,
    no_milestone: bool,
    order: String,
    limit: u32,
    offset: u32,
}

fn validate(query: IssueQuery) -> Result<ValidQuery, IssueError> {
    let IssueQuery {
        filter,
        sort,
        direction,
        limit,
        offset,
    } = query;
    let invalid = || IssueError::InvalidFilter;
    let text = filter
        .text
        .map(|text| text.trim().to_lowercase())
        .filter(|text| !text.is_empty());
    if text
        .as_ref()
        .is_some_and(|text| text.chars().count() > MAX_TEXT_CHARS || text.contains('\0'))
    {
        return Err(invalid());
    }
    let closed = match filter.state.as_deref() {
        None | Some("all") => None,
        Some("open") => Some(false),
        Some("closed") => Some(true),
        Some(_) => return Err(invalid()),
    };
    if filter.statuses.len() > MAX_LIST_ITEMS
        || filter.priorities.len() > MAX_LIST_ITEMS
        || filter.project_ids.len() > MAX_LIST_ITEMS
        || filter.label_ids.len() > MAX_LIST_ITEMS
        || filter.milestone_ids.len() > MAX_LIST_ITEMS
        || !filter
            .statuses
            .iter()
            .all(|status| STATUSES.contains(&status.as_str()))
        || !filter
            .priorities
            .iter()
            .all(|priority| PRIORITIES.contains(&priority.as_str()))
    {
        return Err(invalid());
    }
    let undated = match filter.undated.as_deref() {
        None | Some("include") => Undated::Include,
        Some("exclude") => Undated::Exclude,
        Some("only") => Undated::Only,
        Some(_) => return Err(invalid()),
    };
    let has_range = filter.due_after.is_some() || filter.due_before.is_some();
    if filter
        .due_after
        .iter()
        .chain(&filter.due_before)
        .any(|date| !valid_date(date))
        || matches!(
            (&filter.due_after, &filter.due_before),
            (Some(after), Some(before)) if after > before
        )
        || (has_range && matches!(undated, Undated::Only))
    {
        return Err(invalid());
    }

    let match_all_labels = match filter.label_match.as_deref() {
        None | Some("any") => false,
        Some("all") => true,
        Some(_) => return Err(invalid()),
    };
    let mut label_ids = filter.label_ids;
    label_ids.sort();
    label_ids.dedup();

    let field = sort.as_deref().unwrap_or("updated");
    let expression = match field {
        "updated" => "updated_at",
        "created" => "created_at",
        "priority" => {
            "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 \
             WHEN 'low' THEN 1 ELSE 0 END"
        }
        "title" => "title COLLATE NOCASE",
        "due" => "due_date",
        _ => return Err(invalid()),
    };
    let direction = match direction.as_deref() {
        Some("asc") => "ASC",
        Some("desc") => "DESC",
        None if matches!(field, "title" | "due") => "ASC",
        None => "DESC",
        Some(_) => return Err(invalid()),
    };
    // Undated issues always come last. The issue number breaks every tie, so
    // the order is total and pages never overlap or skip.
    let nulls_last = if field == "due" {
        "due_date IS NULL, "
    } else {
        ""
    };
    let order = format!("{nulls_last}{expression} {direction}, number {direction}");

    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid());
    }
    Ok(ValidQuery {
        text,
        closed,
        statuses: filter.statuses,
        priorities: filter.priorities,
        project_ids: filter.project_ids,
        inbox: filter.inbox,
        due_after: filter.due_after,
        due_before: filter.due_before,
        undated,
        label_ids,
        match_all_labels,
        milestone_ids: filter.milestone_ids,
        no_milestone: filter.no_milestone,
        order,
        limit,
        offset,
    })
}

fn push_list(builder: &mut QueryBuilder<'_, Sqlite>, column: &str, values: &[String]) {
    builder.push(format!(" AND {column} IN ("));
    let mut list = builder.separated(", ");
    for value in values {
        list.push_bind(value.clone());
    }
    list.push_unseparated(")");
}

/// Adds the WHERE clause. Every value is bound as a parameter.
fn push_filters(
    builder: &mut QueryBuilder<'_, Sqlite>,
    workspace: &str,
    query: &ValidQuery,
    with_state: bool,
) {
    builder
        .push(" WHERE workspace_id = ")
        .push_bind(workspace.to_owned());
    if let Some(text) = &query.text {
        builder
            .push(" AND instr(search_text, ")
            .push_bind(text.clone())
            .push(") > 0");
    }
    if let (true, Some(closed)) = (with_state, query.closed) {
        builder.push(if closed {
            " AND closed = 1"
        } else {
            " AND closed = 0"
        });
    }
    if !query.statuses.is_empty() {
        push_list(builder, "status", &query.statuses);
    }
    if !query.priorities.is_empty() {
        push_list(builder, "priority", &query.priorities);
    }
    match (query.project_ids.is_empty(), query.inbox) {
        (true, false) => {}
        (true, true) => {
            builder.push(" AND project_id IS NULL");
        }
        (false, inbox) => {
            builder.push(" AND (project_id IN (");
            let mut list = builder.separated(", ");
            for id in &query.project_ids {
                list.push_bind(id.clone());
            }
            list.push_unseparated(")");
            if inbox {
                builder.push(" OR project_id IS NULL");
            }
            builder.push(")");
        }
    }
    match (query.milestone_ids.is_empty(), query.no_milestone) {
        (true, false) => {}
        (true, true) => {
            builder.push(" AND milestone_id IS NULL");
        }
        (false, none) => {
            builder.push(" AND (milestone_id IN (");
            let mut list = builder.separated(", ");
            for id in &query.milestone_ids {
                list.push_bind(id.clone());
            }
            list.push_unseparated(")");
            if none {
                builder.push(" OR milestone_id IS NULL");
            }
            builder.push(")");
        }
    }
    if !query.label_ids.is_empty() {
        builder.push(if query.match_all_labels {
            " AND (SELECT count(*) FROM issue_labels WHERE issue_id = issues.id AND label_id IN ("
        } else {
            " AND EXISTS (SELECT 1 FROM issue_labels WHERE issue_id = issues.id AND label_id IN ("
        });
        let mut list = builder.separated(", ");
        for id in &query.label_ids {
            list.push_bind(id.clone());
        }
        list.push_unseparated("))");
        if query.match_all_labels {
            builder.push(" = ").push_bind(query.label_ids.len() as i64);
        }
    }
    if let Undated::Only = query.undated {
        builder.push(" AND due_date IS NULL");
        return;
    }
    if query.due_after.is_none() && query.due_before.is_none() {
        if let Undated::Exclude = query.undated {
            builder.push(" AND due_date IS NOT NULL");
        }
        return;
    }
    builder.push(match query.undated {
        Undated::Include => " AND (due_date IS NULL OR (1 = 1",
        _ => " AND (due_date IS NOT NULL AND (1 = 1",
    });
    if let Some(after) = &query.due_after {
        builder.push(" AND due_date >= ").push_bind(after.clone());
    }
    if let Some(before) = &query.due_before {
        builder.push(" AND due_date <= ").push_bind(before.clone());
    }
    builder.push("))");
}

/// Computes `search_text` for rows saved before migration 6. Writes keep it
/// current afterwards, so this finds nothing on later calls.
async fn index_missing(pool: &SqlitePool, workspace: &str) -> Result<(), IssueError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, description FROM issues
         WHERE workspace_id = ? AND search_text IS NULL",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await
    .map_err(storage_failed)?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut transaction = pool.begin().await.map_err(storage_failed)?;
    for (id, title, description) in rows {
        sqlx::query("UPDATE issues SET search_text = ? WHERE id = ? AND search_text IS NULL")
            .bind(search_text(&title, &description))
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(storage_failed)?;
    }
    transaction.commit().await.map_err(storage_failed)
}

/// Finds issues in one workspace that match the filter, one page at a time.
pub async fn query(
    pool: &SqlitePool,
    workspace: &str,
    query: IssueQuery,
) -> Result<IssuePage, IssueError> {
    let query = validate(query)?;
    index_missing(pool, workspace).await?;

    let mut counts = QueryBuilder::new(
        "SELECT count(*), coalesce(sum(closed = 0), 0), coalesce(sum(closed = 1), 0) FROM issues",
    );
    push_filters(&mut counts, workspace, &query, false);
    let (all, open, closed): (i64, i64, i64) = counts
        .build_query_as()
        .fetch_one(pool)
        .await
        .map_err(storage_failed)?;
    let total = match query.closed {
        None => all,
        Some(false) => open,
        Some(true) => closed,
    };

    let mut page = QueryBuilder::new(format!("SELECT {SUMMARY_FIELDS} FROM issues"));
    push_filters(&mut page, workspace, &query, true);
    page.push(format!(" ORDER BY {} LIMIT ", query.order))
        .push_bind(i64::from(query.limit))
        .push(" OFFSET ")
        .push_bind(i64::from(query.offset));
    let issues = page
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(storage_failed)?;
    Ok(IssuePage {
        issues,
        total,
        open,
        closed,
    })
}

#[cfg(test)]
mod tests;
