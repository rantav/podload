mod download;
mod settings;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use tokio::{fs, sync::Mutex};

/// Files that the frontend can read and write in the app data directory.
const APP_FILES: [&str; 2] = ["podload-state.json", "podload-cache.json"];

/// Serializes writes, so two writes of the same file cannot mix.
struct AppFiles(Mutex<()>);

fn app_file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !APP_FILES.contains(&name) {
        return Err(format!("Unknown app file: {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
async fn read_app_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = app_file_path(&app, &name)?;
    match fs::read_to_string(&path).await {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the file atomically: a crash during the write keeps the old file.
#[tauri::command]
async fn write_app_file(
    app: AppHandle,
    files: State<'_, AppFiles>,
    name: String,
    contents: String,
) -> Result<(), String> {
    let path = app_file_path(&app, &name)?;
    let _guard = files.0.lock().await;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).await.map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(download::Downloader::new())
        .manage(AppFiles(Mutex::new(())))
        .setup(|app| {
            let settings = settings::load(app.handle());
            app.manage(settings);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            download::download_file,
            settings::get_download_dir,
            settings::pick_download_dir,
            read_app_file,
            write_app_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
