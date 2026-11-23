// Run through scripts/test-macos-file-open.mjs. Uses a temporary .app and
// library to exercise real LaunchServices cold and warm document events.
#[path = "../src/browser.rs"]
mod browser;
#[path = "../src/opened_files.rs"]
mod opened_files;
use std::{path::Path, process::Command, time::Duration};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn get_api_key() -> Option<String> {
    None
}

async fn eval(main: &Webview, code: &str) -> Result<serde_json::Value, String> {
    browser::evaluate(main, format!("(() => {{ window.__advanceTestFrames?.(); const value=({code}); return value===undefined?null:value; }})()")).await
        .map_err(|error| format!("{error}; evaluating {code}"))
}
async fn wait(main: &Webview, condition: &str) -> Result<(), String> {
    for _ in 0..200 {
        if eval(main, condition).await?.as_bool() == Some(true) {
            return Ok(());
        }
        pause().await;
    }
    Err(format!(
        "Timed out: {condition}; reader: {}",
        eval(main, "document.body.innerText.slice(0, 1600)").await?
    ))
}
async fn pause() {
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
        .await
        .unwrap();
}
fn open(bundle: &Path, files: &[&Path]) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-g")
        .arg("-a")
        .arg(bundle)
        .args(files)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open failed: {status}"))
    }
}
fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("Pass the temporary fixture directory");
    let root = std::path::PathBuf::from(root);
    let bundle = root.join("File Open Smoke.app");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.knowbelreader.file-open-smoke".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.join("data")),
    );
    context.config_mut().build.dev_url = Some("http://127.0.0.1:5178".parse().unwrap());
    tauri::Builder::default()
        .manage(browser::PageState::default())
        .manage(opened_files::OpenedFiles::default())
        .plugin(tauri_plugin_fs::init()).plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_api_key, opened_files::pending_opened_files, opened_files::read_opened_file,
            browser::open_import_browser, browser::position_import_browser, browser::import_browser_action,
            browser::capture_import_browser, browser::read_page_selection, browser::read_page_interaction,
            browser::decorate_page, browser::print_reader, browser::save_page_archive, browser::load_page_archive])
        .setup(move |app| {
            let loaded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let load_flag = loaded.clone();
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("http://127.0.0.1:5178".parse().unwrap()))
                .incognito(true).position(20000., 20000.).inner_size(1440., 1000.)
                .on_page_load(move |_, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        load_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                })
                .initialization_script(r#"
                    window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
                    const frames=new Map();let fid=0;requestAnimationFrame=f=>{frames.set(++fid,f);return fid};cancelAnimationFrame=id=>frames.delete(id);
                    window.__advanceTestFrames=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(f=>f(performance.now()))};
                "#).build()?;
            let main: Webview = main.as_ref().clone();
            let handle = app.handle().clone();
            let library = app.path().app_data_dir()?.join("library");
            tauri::async_runtime::spawn(async move {
                let result: Result<(), String> = async {
                    for _ in 0..200 {
                        if loaded.load(std::sync::atomic::Ordering::SeqCst) { break; }
                        pause().await;
                    }
                    if !loaded.load(std::sync::atomic::Ordering::SeqCst) { return Err("The fixture reader did not load from Vite on port 5178".into()); }
                    wait(&main, "document.querySelector('.native-reader')?.textContent.includes('Cold launch document')").await?;
                    println!("Cold LaunchServices open reached the native reader.");
                    // Enter writing, then immediately open another document without
                    // blurring or waiting for the debounced save.
                    wait(&main, "!!document.querySelector('.notebook-dock')").await?;
                    eval(&main, "(() => {if(document.querySelector('.notebook-dock').hidden)document.querySelector('button[aria-label=\"Notebook\"]').click();return true})()").await?;
                    eval(&main, "document.querySelector('button[aria-label=\"New note\"]').click()").await?;
                    wait(&main, "!!document.querySelector('.nb-rich-editor')").await?;
                    eval(&main, r#"(() => {const e=document.querySelector('.nb-rich-editor');e.focus();document.execCommand('insertText',false,'Saved before external switch');return true})()"#).await?;
                    open(&bundle, &[&root.join("Warm document.HTML")])?;
                    wait(&main, "document.querySelector('.native-reader')?.textContent.includes('Warm HTML document')").await?;
                    let mut notes = false;
                    for entry in std::fs::read_dir(&library).map_err(|e| e.to_string())?.flatten() {
                        if std::fs::read_to_string(entry.path().join("notebook.json")).unwrap_or_default().contains("Saved before external switch") { notes = true; }
                    }
                    if !notes { return Err("External open lost the active notebook edit".into()); }
                    open(&bundle, &[&root.join("Cold #1 日本語.md")])?;
                    wait(&main, "document.querySelector('.native-reader')?.textContent.includes('Cold launch document') && document.querySelector('.notebook-dock')?.textContent.includes('Saved before external switch')").await?;
                    let count = std::fs::read_dir(&library).map_err(|e| e.to_string())?.flatten().filter(|e| e.path().is_dir()).count();
                    if count != 2 { return Err(format!("Reopening created a duplicate: {count} library entries")); }
                    println!("Warm opens save active writing and restore the deduplicated notebook.");
                    open(&bundle, &[&root.join("Broken.pdf"), &root.join("Paper.pdf")])?;
                    wait(&main, "!!document.querySelector('.pdfViewer canvas') && document.querySelector('.textLayer')?.textContent.includes('File association PDF')").await?;
                    wait(&main, "document.querySelector('.notice-host')?.textContent.includes('Broken.pdf')").await?;
                    println!("Multiple-file delivery recovers from a damaged file and renders PDF.");
                    let errors = eval(&main, "window.__errors").await?;
                    if errors.as_array().is_some_and(|e| !e.is_empty()) { return Err(format!("Frontend errors: {errors}")); }
                    Ok(())
                }.await;
                let message = match &result { Ok(()) => "PASS".to_string(), Err(error) => format!("FAIL: {error}") };
                println!("{message}");
                let _ = std::fs::write(root.join("result.txt"), &message);
                handle.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context).expect("build file-open smoke app")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event { opened_files::receive(app, urls); }
        });
}
