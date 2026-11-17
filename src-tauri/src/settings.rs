//! Settings that only the Rust side can change.
//!
//! The download folder is here, and not in the frontend state, so the webview
//! cannot point downloads at an arbitrary directory. Only the native folder
//! dialog changes it.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::download::remove_partial_files;

const SETTINGS_FILENAME: &str = "podload-settings.json";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    download_dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct Settings {
    download_dir: Mutex<Option<PathBuf>>,
}

impl Settings {
    pub fn download_dir(&self) -> Option<PathBuf> {
        self.download_dir.lock().unwrap().clone()
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(SETTINGS_FILENAME))
}

/// Lets the webview play the files in the download folder.
fn allow_playback(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

/// Loads the settings at startup.
pub fn load(app: &AppHandle) -> Settings {
    let file: SettingsFile = settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Some(dir) = &file.download_dir {
        allow_playback(app, dir);
        // No download runs at startup, so all partial files are leftovers.
        remove_partial_files(dir);
    }
    Settings {
        download_dir: Mutex::new(file.download_dir),
    }
}

fn save(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let path = settings_path(app).ok_or("No app data directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::to_string(&SettingsFile {
        download_dir: Some(dir.to_path_buf()),
    })
    .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_download_dir(settings: State<'_, Settings>) -> Option<String> {
    settings
        .download_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
}

/// Opens the native folder dialog. Returns the new folder, or `None` when the
/// user cancels.
#[tauri::command]
pub async fn pick_download_dir(
    app: AppHandle,
    settings: State<'_, Settings>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a download folder")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let dir = folder.into_path().map_err(|e| e.to_string())?;

    save(&app, &dir)?;
    allow_playback(&app, &dir);
    *settings.download_dir.lock().unwrap() = Some(dir.clone());
    Ok(Some(dir.to_string_lossy().into_owned()))
}
