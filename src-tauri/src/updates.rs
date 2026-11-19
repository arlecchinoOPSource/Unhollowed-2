//! On-demand update check (U2-P7-02). It runs only when the person asks:
//! nothing here is called at startup, on a timer, or in the background, and the
//! rest of the app never needs the network. See docs/UPDATER.md.
//! The download (U2-P7-05) runs only after the person chooses to install.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
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

/// The update the last check found, if any. Only it can be downloaded, so the
/// webview cannot choose a package or address.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// The downloaded package after its signature verified, kept for installation
/// (U2-P7-06). Never written to disk here.
#[derive(Default)]
pub struct VerifiedPackage(pub Mutex<Option<(String, Vec<u8>)>>);

/// Progress sent to the webview while downloading. Byte counts come from the
/// download itself; `total` is null when the server did not give a size.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DownloadEvent {
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// Every byte arrived; the signature is being checked.
    Finished,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DownloadResult {
    /// Downloaded, and the signature matched the embedded key and version.
    Verified,
    /// Another update operation is running; this request did nothing.
    Busy,
    /// No update was found by a check first.
    NothingToDownload,
    Failed {
        reason: DownloadFailure,
        detail: String,
    },
}

/// Nothing was installed or changed in any of these cases.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadFailure {
    Offline,
    Download,
    Verification,
}

/// At most this often per second does progress reach the webview, so assistive
/// technology and rendering are not flooded with per-chunk events.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// The installed version, shown in Settings → About.
#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.package_info().version.to_string()
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
    // Remember only an update the person could be offered, and forget any
    // package downloaded for an earlier check.
    if let Some(pending) = app.try_state::<PendingUpdate>() {
        *pending.0.lock().unwrap() = match &result {
            Ok(Some(update)) if update.download_url.scheme() == "https" => Some(update.clone()),
            _ => None,
        };
    }
    if let Some(verified) = app.try_state::<VerifiedPackage>() {
        *verified.0.lock().unwrap() = None;
    }
    classify(result, current, platform)
}

#[tauri::command]
pub async fn download_update(
    lock: State<'_, UpdateLock>,
    pending: State<'_, PendingUpdate>,
    verified: State<'_, VerifiedPackage>,
    on_event: Channel<DownloadEvent>,
) -> Result<DownloadResult, ()> {
    Ok(download(&lock, &pending, &verified, &on_event).await)
}

/// Downloads the pending update and verifies it. The plugin checks the
/// signature before returning the bytes, so a package that does not verify is
/// never kept.
async fn download(
    lock: &UpdateLock,
    pending: &PendingUpdate,
    verified: &VerifiedPackage,
    events: &Channel<DownloadEvent>,
) -> DownloadResult {
    let Some(_held) = lock.try_hold() else {
        return DownloadResult::Busy;
    };
    let Some(update) = pending.0.lock().unwrap().clone() else {
        return DownloadResult::NothingToDownload;
    };
    let downloaded = AtomicU64::new(0);
    // 0 means unknown: a missing or zero Content-Length gives no usable total.
    let total = AtomicU64::new(0);
    let last = Mutex::new(None::<Instant>);
    let progress = || DownloadEvent::Progress {
        downloaded: downloaded.load(Ordering::Relaxed),
        total: Some(total.load(Ordering::Relaxed)).filter(|bytes| *bytes > 0),
    };
    let result = update
        .download(
            |chunk, length| {
                downloaded.fetch_add(chunk as u64, Ordering::Relaxed);
                total.store(length.unwrap_or(0), Ordering::Relaxed);
                let mut last = last.lock().unwrap();
                if last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
                    *last = Some(Instant::now());
                    let _ = events.send(progress());
                }
            },
            || {
                let _ = events.send(progress());
                let _ = events.send(DownloadEvent::Finished);
            },
        )
        .await;
    match result {
        Ok(bytes) => {
            *verified.0.lock().unwrap() = Some((update.version, bytes));
            DownloadResult::Verified
        }
        Err(error) => DownloadResult::Failed {
            reason: download_failure(&error),
            detail: error.to_string(),
        },
    }
}

fn download_failure(error: &Error) -> DownloadFailure {
    match error {
        Error::Minisign(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion
        | Error::Base64(_)
        | Error::SignatureUtf8(_) => DownloadFailure::Verification,
        Error::Reqwest(error) if error.is_connect() || error.is_timeout() => {
            DownloadFailure::Offline
        }
        _ => DownloadFailure::Download,
    }
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

/// U2-P7-03: the maintained verifier accepts only a package signed by the
/// embedded key for the announced version. The fixtures in
/// `src-tauri/fixtures/updater` were signed with throwaway test keys whose
/// private halves were never committed (docs/UPDATER_SIGNING.md).
#[cfg(test)]
mod signing_tests {
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri_plugin_updater::{Error, Update, UpdaterExt};

    const TARGET: &str = "darwin-aarch64";
    const PACKAGE: &[u8] = include_bytes!("../fixtures/updater/package.bin");
    const TEST_KEY: &str = include_str!("../fixtures/updater/test-key.pub");
    const GOOD: &str = include_str!("../fixtures/updater/good.sig");
    const OTHER_VERSION: &str = include_str!("../fixtures/updater/other-version.sig");
    const WRONG_KEY: &str = include_str!("../fixtures/updater/wrong-key.sig");

    /// Serves the manifest at `/latest.json` and `package` (or a 404 when it is
    /// `None`) at `/package`, like the channel and its release asset.
    fn serve(signature: &str, package: Option<&'static [u8]>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let manifest = json!({
            "version": "0.2.0",
            "platforms": { TARGET: { "url": format!("{base}/package"), "signature": signature } }
        })
        .to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2).flatten() {
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                let (status, body) = match (line.contains("/latest.json"), package) {
                    (true, _) => ("200 OK", manifest.as_bytes().to_vec()),
                    (false, Some(bytes)) => ("200 OK", bytes.to_vec()),
                    (false, None) => ("404 Not Found", b"Not Found".to_vec()),
                };
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("{base}/latest.json")
    }

    /// Checks the feed with the embedded test key and signed versions required,
    /// as the production configuration does.
    fn update(endpoint: &str) -> Update {
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": TEST_KEY.trim(),
                "endpoints": [endpoint],
                "requireSignedVersion": true,
                "dangerousInsecureTransportProtocol": true
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app.updater_builder().target(TARGET).build().unwrap();
        tauri::async_runtime::block_on(updater.check())
            .unwrap()
            .expect("the fixture feed announces 0.2.0 to the 0.1.0 mock app")
    }

    fn download(signature: &str, package: Option<&'static [u8]>) -> Result<Vec<u8>, Error> {
        let update = update(&serve(signature, package));
        tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
    }

    #[test]
    fn a_package_signed_by_the_embedded_key_for_the_announced_version_verifies() {
        assert_eq!(download(GOOD.trim(), Some(PACKAGE)).unwrap(), PACKAGE);
    }

    #[test]
    fn a_package_signed_by_another_key_is_rejected() {
        assert!(matches!(
            download(WRONG_KEY.trim(), Some(PACKAGE)),
            Err(Error::Minisign(_))
        ));
    }

    #[test]
    fn a_changed_package_is_rejected() {
        assert!(matches!(
            download(GOOD.trim(), Some(b"a different package")),
            Err(Error::Minisign(_))
        ));
    }

    #[test]
    fn a_signature_for_another_version_is_rejected() {
        let result = download(OTHER_VERSION.trim(), Some(PACKAGE));
        assert!(
            matches!(&result, Err(Error::SignedVersionMismatch { signed, announced }) if signed == "0.1.5" && announced == "0.2.0"),
            "{result:?}"
        );
    }

    #[test]
    fn a_missing_or_malformed_signature_is_rejected() {
        for signature in ["", "not a signature", "dW50cnVzdGVkIGNvbW1lbnQ6IA=="] {
            assert!(download(signature, Some(PACKAGE)).is_err(), "{signature:?}");
        }
    }

    #[test]
    fn a_missing_package_is_a_download_failure() {
        assert!(matches!(
            download(GOOD.trim(), None),
            Err(Error::Network(message)) if message.contains("404")
        ));
    }

    // `install` verifies before it touches anything, so a package that fails
    // verification never reaches the platform installer.
    #[test]
    fn installation_refuses_a_package_that_does_not_verify() {
        let update = update(&serve(WRONG_KEY.trim(), Some(PACKAGE)));
        assert!(matches!(update.install(PACKAGE), Err(Error::Minisign(_))));
        let update = update_with(GOOD);
        assert!(matches!(
            update.install(b"a different package"),
            Err(Error::Minisign(_))
        ));
    }

    fn update_with(signature: &str) -> Update {
        update(&serve(signature.trim(), Some(PACKAGE)))
    }

    // U2-P7-05: the download command, with the events the webview receives.
    use super::{
        download as download_command, DownloadEvent, DownloadFailure, DownloadResult,
        PendingUpdate, UpdateLock, VerifiedPackage,
    };
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};

    fn events() -> (Channel<DownloadEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, seen)
    }

    fn fetch(
        update: Option<Update>,
    ) -> (
        DownloadResult,
        Vec<serde_json::Value>,
        Option<(String, Vec<u8>)>,
    ) {
        let pending = PendingUpdate(Mutex::new(update));
        let verified = VerifiedPackage::default();
        let (channel, seen) = events();
        let result = tauri::async_runtime::block_on(download_command(
            &UpdateLock::default(),
            &pending,
            &verified,
            &channel,
        ));
        let package = verified.0.lock().unwrap().take();
        let seen = seen.lock().unwrap().clone();
        (result, seen, package)
    }

    #[test]
    fn a_verified_download_reports_real_bytes_and_keeps_the_package() {
        let (result, seen, package) = fetch(Some(update_with(GOOD)));
        assert_eq!(result, DownloadResult::Verified);
        let length = PACKAGE.len() as u64;
        assert_eq!(seen.last().unwrap(), &json!({ "event": "finished" }));
        assert_eq!(
            seen[seen.len() - 2],
            json!({ "event": "progress", "downloaded": length, "total": length })
        );
        let counts: Vec<u64> = seen
            .iter()
            .filter_map(|event| event["downloaded"].as_u64())
            .collect();
        assert!(
            counts.windows(2).all(|pair| pair[0] <= pair[1]),
            "{counts:?}"
        );
        assert_eq!(package, Some(("0.2.0".into(), PACKAGE.to_vec())));
    }

    #[test]
    fn a_package_that_does_not_verify_is_reported_and_not_kept() {
        let (result, _, package) = fetch(Some(update_with(WRONG_KEY)));
        assert!(matches!(
            result,
            DownloadResult::Failed {
                reason: DownloadFailure::Verification,
                ..
            }
        ));
        assert_eq!(package, None);
    }

    #[test]
    fn a_missing_package_fails_the_download_command() {
        let (result, seen, package) = fetch(Some(update(&serve(GOOD.trim(), None))));
        assert!(matches!(
            result,
            DownloadResult::Failed {
                reason: DownloadFailure::Download,
                ..
            }
        ));
        assert!(seen.is_empty());
        assert_eq!(package, None);
    }

    #[test]
    fn nothing_downloads_without_a_checked_update_or_while_busy() {
        assert_eq!(fetch(None).0, DownloadResult::NothingToDownload);
        let lock = UpdateLock::default();
        let _held = lock.try_hold().unwrap();
        let (channel, _) = events();
        let result = tauri::async_runtime::block_on(download_command(
            &lock,
            &PendingUpdate(Mutex::new(Some(update_with(GOOD)))),
            &VerifiedPackage::default(),
            &channel,
        ));
        assert_eq!(result, DownloadResult::Busy);
    }
}
