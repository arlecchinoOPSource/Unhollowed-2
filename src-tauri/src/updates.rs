//! On-demand update check (U2-P7-02). It runs only when the person asks:
//! nothing here is called at startup, on a timer, or in the background, and the
//! rest of the app never needs the network. See docs/UPDATER.md.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// Targets with published updater packages (docs/UPDATER_COMPATIBILITY.md).
const SUPPORTED_TARGETS: [&str; 2] = ["darwin-aarch64", "windows-x86_64"];
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The typed result of one check. The webview decides what to show from
/// `status` and, for failures, `reason`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateCheck {
    Available {
        current_version: String,
        version: String,
        date: Option<String>,
        notes: Option<String>,
    },
    Current {
        current_version: String,
    },
    /// This platform has no updater packages, or the channel has none for it.
    Unsupported {
        target: String,
    },
    /// Another check is already running; this request did nothing.
    Busy,
    Failed {
        reason: FailureReason,
        detail: String,
    },
}

/// Every failure is recoverable: nothing was downloaded or changed, and the
/// person can try again.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureReason {
    /// No connection, or the server did not answer in time.
    Offline,
    /// The channel answered with metadata that is not a valid release.
    InvalidMetadata,
    /// The channel answered with an error status or could not be used.
    Server,
}

/// Keeps one check in flight. A second request while one runs gets `Busy`.
#[derive(Default)]
pub struct UpdateLock(AtomicBool);

struct Held<'a>(&'a AtomicBool);

impl UpdateLock {
    fn try_hold(&self) -> Option<Held<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Held(&self.0))
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, UpdateLock>,
) -> Result<UpdateCheck, ()> {
    Ok(check(&app, &lock, None).await)
}

/// `target` overrides the platform key, for tests only. Without it the plugin
/// prefers the installer-specific key (for example `windows-x86_64-msi`), so an
/// install only receives updates of its own installer family.
async fn check<R: Runtime>(
    app: &AppHandle<R>,
    lock: &UpdateLock,
    target: Option<&str>,
) -> UpdateCheck {
    let Some(_held) = lock.try_hold() else {
        return UpdateCheck::Busy;
    };
    let platform = target
        .map(str::to_owned)
        .or_else(tauri_plugin_updater::target)
        .unwrap_or_else(|| "unknown".into());
    if !SUPPORTED_TARGETS.contains(&platform.as_str()) {
        return UpdateCheck::Unsupported { target: platform };
    }
    let current = app.package_info().version.to_string();
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    if let Some(target) = target {
        builder = builder.target(target);
    }
    let result = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    classify(result, current, platform)
}

fn classify(result: Result<Option<Update>, Error>, current: String, target: String) -> UpdateCheck {
    match result {
        // No newer release, including a channel that still announces an older
        // one: the plugin only accepts a strictly greater SemVer version.
        Ok(None) => UpdateCheck::Current {
            current_version: current,
        },
        Ok(Some(update)) if update.download_url.scheme() != "https" => failed(
            FailureReason::InvalidMetadata,
            format!(
                "the package address {} does not use HTTPS",
                update.download_url
            ),
        ),
        Ok(Some(update)) => UpdateCheck::Available {
            current_version: current,
            date: update.raw_json["pub_date"].as_str().map(str::to_owned),
            version: update.version,
            notes: update.body,
        },
        Err(
            Error::UnsupportedOs
            | Error::UnsupportedArch
            | Error::TargetNotFound(_)
            | Error::TargetsNotFound(_),
        ) => UpdateCheck::Unsupported { target },
        Err(Error::Reqwest(error)) if error.is_connect() || error.is_timeout() => {
            failed(FailureReason::Offline, error.to_string())
        }
        Err(Error::Reqwest(error)) if error.is_decode() => {
            failed(FailureReason::InvalidMetadata, error.to_string())
        }
        Err(error @ (Error::Serialization(_) | Error::Semver(_) | Error::UrlParse(_))) => {
            failed(FailureReason::InvalidMetadata, error.to_string())
        }
        Err(error) => failed(FailureReason::Server, error.to_string()),
    }
}

fn failed(reason: FailureReason, detail: String) -> UpdateCheck {
    UpdateCheck::Failed { reason, detail }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    // The mock app reports version 0.1.0.
    const TARGET: &str = "darwin-aarch64";

    /// Answers one request on a local port, like a channel endpoint would.
    fn serve(status: &'static str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.read(&mut [0; 4096]);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        format!("http://{address}/beta/latest.json")
    }

    fn manifest(version: &str, url: &str) -> String {
        json!({
            "version": version,
            "notes": "Fixes",
            "pub_date": "2026-11-20T10:00:00Z",
            "platforms": { TARGET: { "url": url, "signature": "c2lnbmF0dXJl" } }
        })
        .to_string()
    }

    // A test feed: plain HTTP is allowed here and nowhere else.
    fn app(endpoint: &str) -> tauri::App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": "test-key-not-used-by-a-check",
                "endpoints": [endpoint],
                "dangerousInsecureTransportProtocol": true
            }),
        );
        mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    fn run(endpoint: &str) -> UpdateCheck {
        let app = app(endpoint);
        tauri::async_runtime::block_on(check(app.handle(), &UpdateLock::default(), Some(TARGET)))
    }

    fn reason(result: UpdateCheck) -> FailureReason {
        match result {
            UpdateCheck::Failed { reason, .. } => reason,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_newer_release_is_available_with_its_metadata() {
        let feed = serve(
            "200 OK",
            manifest("0.2.0", "https://example.invalid/u.tar.gz"),
        );
        assert_eq!(
            run(&feed),
            UpdateCheck::Available {
                current_version: "0.1.0".into(),
                version: "0.2.0".into(),
                date: Some("2026-11-20T10:00:00Z".into()),
                notes: Some("Fixes".into()),
            }
        );
    }

    #[test]
    fn the_same_or_an_older_release_reports_current() {
        for version in ["0.1.0", "0.0.9", "0.1.0-beta.9"] {
            let feed = serve(
                "200 OK",
                manifest(version, "https://example.invalid/u.tar.gz"),
            );
            assert_eq!(
                run(&feed),
                UpdateCheck::Current {
                    current_version: "0.1.0".into()
                },
                "{version}"
            );
        }
    }

    #[test]
    fn malformed_or_incomplete_metadata_is_rejected() {
        let invalid = [
            "{not json".to_string(),
            json!({ "version": "0.2.0" }).to_string(),
            manifest("next", "https://example.invalid/u.tar.gz"),
            manifest("0.2.0", "http://example.invalid/u.tar.gz"),
        ];
        for body in invalid {
            let feed = serve("200 OK", body.clone());
            assert_eq!(reason(run(&feed)), FailureReason::InvalidMetadata, "{body}");
        }
    }

    #[test]
    fn a_channel_without_this_platform_is_unsupported() {
        let body = json!({
            "version": "0.2.0",
            "platforms": { "windows-x86_64": { "url": "https://example.invalid/u.exe", "signature": "c2ln" } }
        });
        let feed = serve("200 OK", body.to_string());
        assert_eq!(
            run(&feed),
            UpdateCheck::Unsupported {
                target: TARGET.into()
            }
        );
    }

    #[test]
    fn an_unpublished_platform_never_contacts_the_channel() {
        // No server listens on this endpoint: a request would fail as offline.
        let app = app("http://127.0.0.1:9/beta/latest.json");
        let result = tauri::async_runtime::block_on(check(
            app.handle(),
            &UpdateLock::default(),
            Some("linux-x86_64"),
        ));
        assert_eq!(
            result,
            UpdateCheck::Unsupported {
                target: "linux-x86_64".into()
            }
        );
    }

    #[test]
    fn an_unreachable_channel_is_a_recoverable_offline_failure() {
        let address = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        assert_eq!(
            reason(run(&format!("http://{address}/beta/latest.json"))),
            FailureReason::Offline
        );
    }

    #[test]
    fn an_error_status_is_a_server_failure() {
        let feed = serve("404 Not Found", "Not Found".into());
        assert_eq!(reason(run(&feed)), FailureReason::Server);
    }

    #[test]
    fn a_second_check_while_one_runs_is_busy_and_the_lock_is_released() {
        let app = app("http://127.0.0.1:9/beta/latest.json");
        let lock = UpdateLock::default();
        let held = lock.try_hold().unwrap();
        let busy = tauri::async_runtime::block_on(check(app.handle(), &lock, Some(TARGET)));
        assert_eq!(busy, UpdateCheck::Busy);
        drop(held);
        assert!(lock.try_hold().is_some());
    }

    #[test]
    fn results_serialize_with_a_status_tag_for_the_webview() {
        let value =
            serde_json::to_value(failed(FailureReason::InvalidMetadata, "x".into())).unwrap();
        assert_eq!(
            value,
            json!({ "status": "failed", "reason": "invalidMetadata", "detail": "x" })
        );
        let value = serde_json::to_value(UpdateCheck::Current {
            current_version: "1.1.0-beta.1".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            json!({ "status": "current", "currentVersion": "1.1.0-beta.1" })
        );
    }
}
