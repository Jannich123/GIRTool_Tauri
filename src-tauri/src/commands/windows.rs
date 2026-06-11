// Multi-window support — open a specific page in its own Tauri window.
//
// The frontend uses URL query parameters to know which page to show first
// (e.g. /?page=charts).  Each pop-out window gets a unique label of the form
// `popout-{page}` so calling open_window twice for the same page focuses the
// existing window instead of stacking duplicates.
//
// All windows share the same AppState (database connection, output folder,
// selection, etc.) since Tauri runs one backend process for the whole app.
// Cross-window data sync (e.g. boundaries edits → live chart refresh) is
// handled via Tauri events emitted from the affected command handlers; the
// point/project selection is mirrored window-to-window by frontend-emitted
// `selection:*` events (AppContext, #203).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open the named page in a new top-level window, or focus the existing one
/// if a window for that page is already open.
///
/// `page` is a sidebar nav key (`charts`, `boundaries`, `map`, `data`, …).
/// `title` is shown in the new window's title bar; defaults to "GIRTool — {page}".
#[tauri::command]
pub async fn open_window(
    app:   AppHandle,
    page:  String,
    title: Option<String>,
) -> Result<(), String> {
    let label = format!("popout-{page}");

    // Already open?  Focus + unminimise and return.
    if let Some(existing) = app.get_webview_window(&label) {
        existing.unminimize().ok();
        existing.set_focus().ok();
        return Ok(());
    }

    // Encode the page key into a query string so App.jsx can pick it up on mount.
    let url = WebviewUrl::App(format!("index.html?page={page}").into());

    let resolved_title = title.unwrap_or_else(|| format!("GIRTool — {page}"));

    WebviewWindowBuilder::new(&app, &label, url)
        .title(resolved_title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("Failed to open window: {e}"))?;

    Ok(())
}
