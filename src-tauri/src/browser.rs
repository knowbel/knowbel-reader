use std::{
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

pub const LABEL: &str = "knowbel-document-page";
const MAX_CAPTURE: usize = 24 * 1024 * 1024;
const MAX_ARCHIVE: usize = 128 * 1024 * 1024;
#[derive(Default)]
pub struct PageState {
    owner: Mutex<Option<String>>,
    // WebKit won't navigate a view showing a web archive to the network,
    // so leaving one replaces the view.
    archived: Mutex<bool>,
}
#[derive(Clone, serde::Deserialize)]
pub struct PageBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl PageBounds {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|n| !n.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 1.0
            || self.height < 1.0
            || self.width > 20000.0
            || self.height > 20000.0
        {
            return Err("Invalid document pane bounds.".into());
        }
        Ok(())
    }
}
pub(crate) fn trusted(view: &Webview) -> Result<(), String> {
    if view.label() != "main" {
        return Err("Only the reader can control a document page.".into());
    }
    Ok(())
}
fn browser(app: &tauri::AppHandle, owner: &str) -> Result<Webview, String> {
    if app
        .state::<PageState>()
        .owner
        .lock()
        .map_err(|e| e.to_string())?
        .as_deref()
        != Some(owner)
    {
        return Err("This document page is no longer active.".into());
    }
    app.get_webview(LABEL)
        .ok_or_else(|| "The document page was closed.".into())
}
fn page_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Enter a valid web address.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP and HTTPS pages without embedded credentials can be opened.".into());
    }
    Ok(url)
}
pub async fn evaluate(view: &Webview, script: String) -> Result<serde_json::Value, String> {
    let (send, receive) = mpsc::sync_channel(1);
    view.eval_with_callback(script, move |result| {
        let _ = send.try_send(result);
    })
    .map_err(|e| e.to_string())?;
    let raw =
        tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(15)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "The page did not respond. Wait for it to finish loading and retry.")?;
    if raw.len() > MAX_CAPTURE {
        return Err("This page is too large to capture.".into());
    }
    let result: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "The page returned unreadable content.")?;
    if let Some(error) = result.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_owned());
    }
    Ok(result)
}
fn set_bounds(view: &Webview, bounds: &PageBounds) -> Result<(), String> {
    bounds.validate()?;
    view.set_bounds(tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    })
    .map_err(|e| e.to_string())
}
// Remote content is a child view in the existing reader window. Capabilities
// are restricted to the main webview, not every view in the parent window.
#[tauri::command]
pub async fn open_import_browser(
    window: Webview,
    app: tauri::AppHandle,
    url: String,
    owner: String,
    bounds: PageBounds,
    archive: Option<bool>,
) -> Result<bool, String> {
    trusted(&window)?;
    bounds.validate()?;
    let url = page_url(&url)?;
    // A saved archive replaces the live load, so the view starts blank and
    // never contacts the site.
    let archive = archive.unwrap_or(false);
    if owner.is_empty() || owner.len() > 200 {
        return Err("Invalid document owner.".into());
    }
    *app.state::<PageState>()
        .owner
        .lock()
        .map_err(|e| e.to_string())? = Some(owner);
    let archived = std::mem::replace(&mut *app.state::<PageState>().archived.lock().map_err(|e| e.to_string())?, false);
    if let Some(existing) = app.get_webview(LABEL).filter(|existing| {
        let keep = !archive && !archived;
        if !keep { let _ = existing.close(); }
        keep
    }) {
        set_bounds(&existing, &bounds)?;
        let reused = existing.url().map_err(|e| e.to_string())? == url;
        if !reused {
            existing.navigate(url).map_err(|e| e.to_string())?;
        }
        existing.show().map_err(|e| e.to_string())?;
        return Ok(reused);
    }
    let popup_app = app.clone();
    let interaction_app = app.clone();
    let initial = if archive { tauri::Url::parse("about:blank").map_err(|e| e.to_string())? } else { url };
    let view = window.window().add_child(tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(initial))
        .incognito(true)
        .initialization_script(include_str!("page_bridge.js"))
        .on_navigation(move |url| {
            if url.as_str() == "https://knowbel.invalid/__reader_event" {
                let owner = interaction_app.state::<PageState>().owner.lock().ok().and_then(|owner|owner.clone());
                let _ = interaction_app.emit_to("main", "knowbel-page-interaction", serde_json::json!({"owner":owner}));
                return false;
            }
            page_url(url.as_str()).is_ok() || url.as_str() == "about:blank"
        })
        .on_new_window(move |url, _| {
            if page_url(url.as_str()).is_ok() { if let Some(view) = popup_app.get_webview(LABEL) { let _ = view.navigate(url); } }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|view, payload| {
            let app = view.app_handle();
            let owner = app.state::<PageState>().owner.lock().ok().and_then(|owner| owner.clone());
            let phase = match payload.event() { tauri::webview::PageLoadEvent::Started => "loading", tauri::webview::PageLoadEvent::Finished => "ready" };
            let _ = app.emit_to("main", "knowbel-page-load", serde_json::json!({"owner":owner,"phase":phase,"url":payload.url().as_str()}));
        }), LogicalPosition::new(bounds.x,bounds.y), LogicalSize::new(bounds.width,bounds.height)).map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    Ok(false)
}
#[tauri::command]
pub async fn position_import_browser(
    window: Webview,
    app: tauri::AppHandle,
    owner: String,
    bounds: PageBounds,
    visible: bool,
) -> Result<(), String> {
    trusted(&window)?;
    let view = browser(&app, &owner)?;
    if visible {
        set_bounds(&view, &bounds)?;
        view.show()
    } else {
        view.hide()
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn import_browser_action(
    window: Webview,
    app: tauri::AppHandle,
    owner: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    trusted(&window)?;
    let view = browser(&app, &owner)?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        "zoom" => {
            let scale: f64 = url
                .as_deref()
                .unwrap_or("")
                .parse()
                .map_err(|_| "Invalid page zoom.")?;
            if !scale.is_finite() || !(0.5..=3.0).contains(&scale) {
                return Err("Invalid page zoom.".into());
            }
            view.set_zoom(scale)
        }
        "scroll" => {
            let top: f64 = url
                .as_deref()
                .unwrap_or("")
                .parse()
                .map_err(|_| "Invalid page position.")?;
            if !top.is_finite() || !(0.0..=10000000.0).contains(&top) {
                return Err("Invalid page position.".into());
            }
            view.eval(format!("scrollTo(0,{top})"))
        }
        "navigate" => view.navigate(page_url(url.as_deref().unwrap_or(""))?),
        "focus" => view.set_focus(),
        "reader-focus" => app.get_webview("main").ok_or("The reader is closed.")?.set_focus(),
        "hide" => view.hide(),
        "show" => view.show(),
        "print" => view.print(),
        "close" => {
            view.close().map_err(|e| e.to_string())?;
            *app.state::<PageState>()
                .owner
                .lock()
                .map_err(|e| e.to_string())? = None;
            return Ok(());
        }
        _ => return Err("Unknown page action.".into()),
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn print_reader(window: Webview) -> Result<(), String> {
    trusted(&window)?;
    window.print().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn capture_import_browser(
    window: Webview,
    app: tauri::AppHandle,
    owner: String,
) -> Result<serde_json::Value, String> {
    trusted(&window)?;
    let view = browser(&app, &owner)?;
    let result = evaluate(&view, include_str!("browser_capture.js").into()).await?;
    let captured = result
        .get("url")
        .and_then(|value| value.as_str())
        .ok_or("The page has no web address.")?;
    if page_url(captured)? != view.url().map_err(|e| e.to_string())? {
        return Err(
            "The page changed during capture. Read it again when navigation finishes.".into(),
        );
    }
    browser(&app, &owner)?;
    Ok(result)
}
#[tauri::command]
pub async fn read_page_selection(
    window: Webview,
    app: tauri::AppHandle,
    owner: String,
) -> Result<serde_json::Value, String> {
    trusted(&window)?;
    let view = browser(&app, &owner)?;
    let result = evaluate(&view, "window.__knowbelPage?.read() || {text:'',prefix:'',suffix:'',url:location.href,scrollY}".into()).await?;
    browser(&app, &owner)?;
    Ok(result)
}
#[tauri::command]
pub async fn read_page_interaction(window: Webview, app: tauri::AppHandle, owner: String) -> Result<serde_json::Value, String> {
    trusted(&window)?;
    let view=browser(&app,&owner)?;
    let result=evaluate(&view,"window.__knowbelPage?.consume() || null".into()).await?;
    browser(&app,&owner)?;
    Ok(result)
}
#[tauri::command]
pub async fn decorate_page(
    window: Webview,
    app: tauri::AppHandle,
    owner: String,
    marks: serde_json::Value,
    focus: Option<serde_json::Value>,
    settings: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    trusted(&window)?;
    let view = browser(&app, &owner)?;
    let focus = focus.unwrap_or(serde_json::Value::Null);
    let settings = settings.unwrap_or(serde_json::Value::Null);
    if marks.to_string().len() > 1024 * 1024
        || focus.to_string().len() > 64000
        || settings.to_string().len() > 4096
    {
        return Err("Too many page marks.".into());
    }
    evaluate(
        &view,
        format!(
            "({})({},{},{})",
            include_str!("page_marks.js"),
            marks,
            focus,
            settings
        ),
    )
    .await
}
// The original page as WebKit loaded it (main document plus scripts,
// stylesheets, images and other subresources), for offline replay in the
// same restricted child view. Runtime network requests still need a connection.
#[cfg(target_os = "macos")]
mod archive {
    use objc2_foundation::{NSData, NSError, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc::SyncSender;

    pub fn create(view: &tauri::Webview, send: SyncSender<Result<Vec<u8>, String>>) -> tauri::Result<()> {
        view.with_webview(move |platform| unsafe {
            let web_view = &*platform.inner().cast::<WKWebView>();
            let done = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = match data.as_ref() {
                    Some(data) if error.is_null() && data.len() <= super::MAX_ARCHIVE => Ok(data.to_vec()),
                    Some(_) if error.is_null() => Err("This page is too large to save for offline reading.".into()),
                    _ => Err("The page couldn't be saved for offline reading.".into()),
                };
                let _ = send.try_send(result);
            });
            web_view.createWebArchiveDataWithCompletionHandler(&done);
        })
    }

    pub fn load(view: &tauri::Webview, bytes: Vec<u8>, base: tauri::Url) -> tauri::Result<()> {
        view.with_webview(move |platform| unsafe {
            let web_view = &*platform.inner().cast::<WKWebView>();
            let Some(url) = NSURL::URLWithString(&NSString::from_str(base.as_str())) else { return };
            web_view.loadData_MIMEType_characterEncodingName_baseURL(&NSData::with_bytes(&bytes),
                &NSString::from_str("application/x-webarchive"), &NSString::from_str("utf-8"), &url);
        })
    }
}
// WebKit archives the live DOM, which already contains everything the
// page's scripts added. The server's original document replaces it, so the
// scripts replay from a fresh start instead of repeating their changes.
#[cfg(target_os = "macos")]
async fn original_document(view: &Webview) -> Result<Vec<u8>, String> {
    use base64::Engine;
    for _ in 0..100 {
        let state = evaluate(view, "window.__knowbelPage?.original() || {error:'The page is not ready.'}".into()).await?;
        if let Some(data) = state.get("data").and_then(|value| value.as_str()) {
            return base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "The page's original document is unreadable.".into());
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(200))).await.map_err(|e| e.to_string())?;
    }
    Err("The page's original document took too long to read.".into())
}
#[cfg(target_os = "macos")]
fn with_original(archive: Vec<u8>, original: Vec<u8>) -> Result<Vec<u8>, String> {
    let unreadable = || "The page couldn't be saved for offline reading.".to_string();
    let mut value = plist::Value::from_reader(std::io::Cursor::new(archive)).map_err(|_| unreadable())?;
    value.as_dictionary_mut().and_then(|root| root.get_mut("WebMainResource")).and_then(|main| main.as_dictionary_mut())
        .ok_or_else(unreadable)?.insert("WebResourceData".into(), plist::Value::Data(original));
    let mut bytes = Vec::new();
    value.to_writer_binary(&mut bytes).map_err(|_| unreadable())?;
    Ok(bytes)
}
pub async fn page_archive(app: &tauri::AppHandle, owner: &str) -> Result<Vec<u8>, String> {
    let view = browser(app, owner)?;
    let before = view.url().map_err(|e| e.to_string())?;
    page_url(before.as_str())?;
    #[cfg(target_os = "macos")]
    let bytes = {
        let original = original_document(&view).await?;
        let (send, receive) = mpsc::sync_channel(1);
        archive::create(&view, send).map_err(|e| e.to_string())?;
        let archive = tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(30)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "The page took too long to save for offline reading.".to_string())??;
        with_original(archive, original)?
    };
    #[cfg(not(target_os = "macos"))]
    let bytes: Vec<u8> = return Err("Saving the original page is only available on macOS.".into());
    if view.url().map_err(|e| e.to_string())? != before {
        return Err("The page changed while it was being saved.".into());
    }
    browser(app, owner)?;
    Ok(bytes)
}
pub fn replay_archive(app: &tauri::AppHandle, owner: &str, url: &str, bytes: Vec<u8>) -> Result<(), String> {
    let url = page_url(url)?;
    // Web archives are binary property lists.
    if bytes.len() > MAX_ARCHIVE || !bytes.starts_with(b"bplist00") {
        return Err("The saved page is unreadable.".into());
    }
    let view = browser(app, owner)?;
    *app.state::<PageState>().archived.lock().map_err(|e| e.to_string())? = true;
    #[cfg(target_os = "macos")]
    return archive::load(&view, bytes, url).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    { let _ = (view, url); Err("Saved pages are only available on macOS.".into()) }
}
#[tauri::command]
pub async fn save_page_archive(window: Webview, app: tauri::AppHandle, owner: String) -> Result<tauri::ipc::Response, String> {
    trusted(&window)?;
    Ok(tauri::ipc::Response::new(page_archive(&app, &owner).await?))
}
// The archive is sent as the raw request body; owner and address are headers.
#[tauri::command]
pub fn load_page_archive(window: Webview, app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    trusted(&window)?;
    let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned).ok_or_else(|| format!("Missing {name}."));
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("The saved page is unreadable.".into()) };
    replay_archive(&app, &header("x-knowbel-owner")?, &header("x-knowbel-url")?, bytes.clone())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_web_pages_are_allowed() {
        for value in [
            "file:///etc/passwd",
            "tauri://localhost",
            "javascript:alert(1)",
            "https://user:password@example.org",
        ] {
            assert!(page_url(value).is_err());
        }
        assert!(page_url("https://openai.com/index/example").is_ok());
        assert!(page_url("http://localhost:8000/article").is_ok());
    }
    #[test]
    fn bounds_are_finite_and_positive() {
        assert!(PageBounds {
            x: 0.,
            y: 50.,
            width: 800.,
            height: 600.
        }
        .validate()
        .is_ok());
        for n in [f64::NAN, f64::INFINITY, -1., 0.] {
            assert!(PageBounds {
                x: 0.,
                y: 0.,
                width: n,
                height: 600.
            }
            .validate()
            .is_err());
        }
    }
}
