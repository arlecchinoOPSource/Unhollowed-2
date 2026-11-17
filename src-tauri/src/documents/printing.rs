use super::DocumentError;
use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    A4,
    Letter,
    Legal,
}

#[derive(Deserialize)]
pub struct PrintSettings {
    paper: Paper,
    landscape: bool,
    margin: f64,
}

#[tauri::command]
pub async fn print_document(
    webview: WebviewWindow,
    settings: PrintSettings,
) -> Result<bool, DocumentError> {
    // The editor's own range, from `readLayout` in pageLayout.ts.
    if !(10.0..=50.0).contains(&settings.margin) {
        return Err(DocumentError::InvalidPrintSettings);
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        webview
            .with_webview(move |webview| {
                let _ = tx.try_send(macos::show_panel(webview, settings));
            })
            .map_err(|error| {
                eprintln!("Could not open document print panel: {error}");
                DocumentError::PrintUnavailable
            })?;
        rx.recv().await.ok_or(DocumentError::PrintUnavailable)??;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, settings.paper, settings.landscape);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{DocumentError, Paper, PrintSettings};
    use objc2::runtime::NSObjectProtocol;
    use objc2_app_kit::{NSPaperOrientation, NSPrintInfo};
    use objc2_foundation::NSSize;
    use objc2_web_kit::WKWebView;
    use tauri::webview::PlatformWebview;

    pub fn show_panel(
        webview: PlatformWebview,
        settings: PrintSettings,
    ) -> Result<(), DocumentError> {
        let (width, height) = match settings.paper {
            Paper::A4 => (210.0, 297.0),
            Paper::Letter => (215.9, 279.4),
            Paper::Legal => (215.9, 355.6),
        };
        let points = |mm: f64| mm * 72.0 / 25.4;
        let margin = points(settings.margin);
        // Tauri runs this callback on the UI thread and keeps its WKWebView alive
        // while the raw handle is borrowed.
        let view = unsafe { &*webview.inner().cast::<WKWebView>() };
        if !view.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
            return Err(DocumentError::PrintUnavailable);
        }
        let window = view.window().ok_or(DocumentError::PrintUnavailable)?;
        // A print sheet is already open, for example after a repeated request.
        // Starting another would stack a second operation on the window.
        if window.attachedSheet().is_some() {
            return Ok(());
        }
        // Give each request its own print settings so they cannot leak to later dialogs.
        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(points(width), points(height)));
        if settings.landscape {
            info.setOrientation(NSPaperOrientation::Landscape);
        }
        // When the page has CSS `@page` margins, as every document does,
        // WebKit uses them and ignores these. Measured with a WKWebView
        // print-to-PDF harness: 40 mm CSS with 10 mm here printed at 40 mm,
        // and the reverse at 10 mm. These only apply if the CSS has none.
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);

        // The selector exists, and the operation is presented with its live window
        // on the UI thread. AppKit manages the modal operation until it closes.
        // It stays on the UI thread: WebKit views expect to be drawn there.
        unsafe {
            let operation = view.printOperationWithPrintInfo(&info);
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }
}
