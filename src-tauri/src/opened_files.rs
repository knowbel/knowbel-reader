use std::{collections::VecDeque, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
pub struct OpenedFile {
    id: u64,
    name: String,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Default)]
struct Queue {
    next_id: u64,
    files: VecDeque<OpenedFile>,
}

#[derive(Default)]
pub struct OpenedFiles(Mutex<Queue>);

impl OpenedFiles {
    fn enqueue(&self, urls: Vec<tauri::Url>) {
        let mut queue = self.0.lock().unwrap();
        for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            queue.next_id += 1;
            let id = queue.next_id;
            queue.files.push_back(OpenedFile { id, name, path });
        }
    }

    fn pending(&self) -> Vec<OpenedFile> {
        self.0.lock().unwrap().files.iter().cloned().collect()
    }

    fn take(&self, id: u64) -> Result<PathBuf, String> {
        let mut queue = self.0.lock().map_err(|e| e.to_string())?;
        let index = queue
            .files
            .iter()
            .position(|file| file.id == id)
            .ok_or("This file-open request is no longer available.")?;
        Ok(queue.files.remove(index).unwrap().path)
    }
}

// Keep requests until the frontend reads them: Finder can send the initial
// Apple event before React, its listener, or the library has initialized.
pub fn receive(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    app.state::<OpenedFiles>().enqueue(urls);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("knowbel-opened-files", ());
    }
}

#[tauri::command]
pub fn pending_opened_files(
    window: tauri::Webview,
    state: tauri::State<'_, OpenedFiles>,
) -> Result<Vec<OpenedFile>, String> {
    crate::browser::trusted(&window)?;
    Ok(state.pending())
}

// Only OS-delivered paths may be read. This does not expand the frontend's
// filesystem scope or accept an arbitrary path supplied by a document page.
#[tauri::command]
pub async fn read_opened_file(
    window: tauri::Webview,
    state: tauri::State<'_, OpenedFiles>,
    id: u64,
) -> Result<tauri::ipc::Response, String> {
    crate::browser::trusted(&window)?;
    let path = state.take(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_file() {
            return Err("The document is not a readable file.".into());
        }
        std::fs::read(path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_cold_opens_and_decodes_file_urls_without_accepting_web_urls() {
        let state = OpenedFiles::default();
        let path = PathBuf::from("/tmp/Power and Desire #1 日本語.HTML");
        state.enqueue(vec![
            tauri::Url::from_file_path(&path).unwrap(),
            "https://example.com/file.pdf".parse().unwrap(),
        ]);
        let pending = state.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].name, "Power and Desire #1 日本語.HTML");
        assert_eq!(state.pending().len(), 1);
        assert_eq!(state.take(pending[0].id).unwrap(), path);
        assert!(state.take(pending[0].id).is_err());
    }

    #[test]
    fn new_requests_survive_a_snapshot_being_processed() {
        let state = OpenedFiles::default();
        let url = tauri::Url::from_file_path("/tmp/paper.pdf").unwrap();
        state.enqueue(vec![url.clone(), url.clone()]);
        let pending = state.pending();
        assert_ne!(pending[0].id, pending[1].id);
        state.enqueue(vec![url]);
        for file in pending {
            state.take(file.id).unwrap();
        }
        assert_eq!(state.pending().len(), 1);
    }
}
