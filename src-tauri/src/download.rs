//! Episode downloads.
//!
//! The download runs fully in Rust. The data goes from the network to the disk
//! and never passes through the webview. The file is written to
//! `<dest>.podload-part` and renamed only after the size is verified, so a
//! partial file never looks like a complete episode.
//!
//! The webview supplies only a filename. The directory is the download folder
//! that the user selected in a native dialog (see `settings`).

use std::{
    ffi::OsString,
    io::SeekFrom,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{ipc::Channel, State};

use crate::settings::Settings;
use tauri_plugin_http::reqwest::{
    self,
    header::{HeaderMap, HeaderValue, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE},
    StatusCode,
};
use tokio::{
    fs::{self, File},
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::Semaphore,
};

const MAX_PARALLEL_DOWNLOADS: usize = 3;
/// Attempts in sequence that receive no data before the download fails.
const MAX_STALLED_ATTEMPTS: u32 = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Maximum time without data on an open connection.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub struct Downloader {
    client: reqwest::Client,
    slots: Semaphore,
}

impl Downloader {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent("Podload/0.1")
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("failed to build the HTTP client");
        Self {
            client,
            slots: Semaphore::new(MAX_PARALLEL_DOWNLOADS),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

enum AttemptError {
    /// The same request can succeed later (network error, server error).
    Retry(String),
    /// A new attempt cannot help (bad URL, disk error).
    Fatal(String),
}

struct Transfer<'a> {
    client: &'a reqwest::Client,
    url: &'a str,
    file: File,
    received: u64,
    total: Option<u64>,
    /// Strong ETag or Last-Modified. Resume is safe only with a validator.
    validator: Option<HeaderValue>,
    on_progress: &'a Channel<DownloadProgress>,
    last_progress: Instant,
}

fn resume_validator(headers: &HeaderMap) -> Option<HeaderValue> {
    if let Some(etag) = headers.get(ETAG) {
        if !etag.as_bytes().starts_with(b"W/") {
            return Some(etag.clone());
        }
    }
    headers.get(LAST_MODIFIED).cloned()
}

/// Parses `bytes START-END/TOTAL` into `(START, TOTAL)`.
fn parse_content_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()))
}

impl Transfer<'_> {
    async fn restart(&mut self) -> Result<(), AttemptError> {
        let io = |e: std::io::Error| AttemptError::Fatal(format!("Could not write the file: {e}"));
        self.file.set_len(0).await.map_err(io)?;
        self.file.seek(SeekFrom::Start(0)).await.map_err(io)?;
        self.received = 0;
        self.total = None;
        self.validator = None;
        Ok(())
    }

    fn report(&mut self, force: bool) {
        if force || self.last_progress.elapsed() >= PROGRESS_INTERVAL {
            self.last_progress = Instant::now();
            let _ = self.on_progress.send(DownloadProgress {
                received: self.received,
                total: self.total,
            });
        }
    }

    async fn attempt(&mut self) -> Result<(), AttemptError> {
        // Without a validator the server can send a different file (for
        // example, with other ads). In that case start from byte zero.
        if self.received > 0 && self.validator.is_none() {
            self.restart().await?;
        }

        let mut request = self.client.get(self.url);
        if self.received > 0 {
            request = request.header(RANGE, format!("bytes={}-", self.received));
            if let Some(validator) = &self.validator {
                request = request.header(IF_RANGE, validator.clone());
            }
        }

        let mut response = request
            .send()
            .await
            .map_err(|e| AttemptError::Retry(format!("Connection failed: {e}")))?;
        let status = response.status();

        if status == StatusCode::PARTIAL_CONTENT && self.received > 0 {
            let range = parse_content_range(response.headers());
            let start_ok = matches!(range, Some((start, _)) if start == self.received);
            let total_ok = match (range.and_then(|(_, total)| total), self.total) {
                (Some(new), Some(known)) => new == known,
                _ => true,
            };
            if !start_ok || !total_ok {
                self.restart().await?;
                return Err(AttemptError::Retry(
                    "The server sent an unexpected byte range".into(),
                ));
            }
        } else if status == StatusCode::OK {
            // Full body. This is also the answer when the file changed.
            if self.received > 0 {
                self.restart().await?;
            }
            self.total = response.content_length();
            self.validator = resume_validator(response.headers());
        } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
            self.restart().await?;
            return Err(AttemptError::Retry("The server refused the resume".into()));
        } else if status.is_server_error()
            || status == StatusCode::REQUEST_TIMEOUT
            || status == StatusCode::TOO_MANY_REQUESTS
        {
            return Err(AttemptError::Retry(format!("Download failed ({status})")));
        } else {
            return Err(AttemptError::Fatal(format!("Download failed ({status})")));
        }

        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|e| AttemptError::Retry(format!("Connection lost: {e}")))?;
            let Some(chunk) = chunk else { break };
            self.file
                .write_all(&chunk)
                .await
                .map_err(|e| AttemptError::Fatal(format!("Could not write the file: {e}")))?;
            self.received += chunk.len() as u64;
            self.report(false);
        }

        match self.total {
            Some(total) if self.received != total => Err(AttemptError::Retry(format!(
                "Incomplete download: {} of {} bytes",
                self.received, total
            ))),
            _ => Ok(()),
        }
    }

    async fn run(&mut self) -> Result<(), String> {
        let mut stalled_attempts = 0;
        loop {
            let before = self.received;
            match self.attempt().await {
                Ok(()) => return Ok(()),
                Err(AttemptError::Fatal(message)) => return Err(message),
                Err(AttemptError::Retry(message)) => {
                    if self.received > before {
                        stalled_attempts = 0;
                    }
                    stalled_attempts += 1;
                    if stalled_attempts >= MAX_STALLED_ATTEMPTS {
                        return Err(message);
                    }
                    tokio::time::sleep(Duration::from_secs(1 << stalled_attempts)).await;
                }
            }
        }
    }
}

/// The suffix is specific to this app. Other apps (for example browsers) use
/// `.part`, and the cleanup must not delete their files.
const PART_SUFFIX: &str = ".podload-part";

fn part_path(dest: &Path) -> PathBuf {
    let mut name = OsString::from(dest.as_os_str());
    name.push(PART_SUFFIX);
    PathBuf::from(name)
}

/// Removes partial files that a previous run left in `dir`. Call this only
/// when no download is in progress.
pub fn remove_partial_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let is_partial = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(PART_SUFFIX));
        if is_partial {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Accepts a plain filename only: no directories and no `..`.
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
}

/// Forces the data of `file` to the device.
///
/// On macOS, `sync_all` uses `F_FULLFSYNC`, which also empties the cache of the
/// device. Some filesystems and devices do not support that command. In that
/// case use a plain `fsync`, so a download to such a device does not fail.
async fn sync_to_device(file: &File) -> std::io::Result<()> {
    match file.sync_all().await {
        Ok(()) => Ok(()),
        Err(full_sync_error) => plain_fsync(file).await.map_err(|_| full_sync_error),
    }
}

#[cfg(unix)]
async fn plain_fsync(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // The file stays open until this function returns, so the descriptor is valid.
    let fd = file.as_raw_fd();
    tokio::task::spawn_blocking(move || {
        if unsafe { libc::fsync(fd) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(not(unix))]
async fn plain_fsync(_file: &File) -> std::io::Result<()> {
    Err(std::io::Error::other("no fallback"))
}

/// Makes the rename durable: without this, a sudden disconnect immediately
/// after the download can keep the old (partial) filename. A failure here is
/// not an error, because the file itself is complete and synced.
async fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(dir) = File::open(dir).await {
            let _ = sync_to_device(&dir).await;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Downloads `url` to `dest`. Returns the size of the file in bytes.
async fn download_to(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    on_progress: &Channel<DownloadProgress>,
) -> Result<u64, String> {
    let part = part_path(dest);
    let file = File::create(&part)
        .await
        .map_err(|e| format!("Could not create the file: {e}"))?;

    let mut transfer = Transfer {
        client,
        url,
        file,
        received: 0,
        total: None,
        validator: None,
        on_progress,
        last_progress: Instant::now(),
    };

    let mut result = transfer.run().await;
    if result.is_ok() {
        result = async {
            transfer.file.flush().await?;
            sync_to_device(&transfer.file).await
        }
        .await
        .map_err(|e| format!("Could not write the file: {e}"));
    }

    let received = transfer.received;
    transfer.report(true);
    drop(transfer);

    if result.is_ok() {
        result = fs::rename(&part, dest)
            .await
            .map_err(|e| format!("Could not save the file: {e}"));
    }
    if let Err(message) = result {
        let _ = fs::remove_file(&part).await;
        return Err(message);
    }
    sync_parent_dir(dest).await;
    Ok(received)
}

/// Downloads `url` into the download folder. Returns the path of the file.
#[tauri::command]
pub async fn download_file(
    state: State<'_, Downloader>,
    settings: State<'_, Settings>,
    url: String,
    file_name: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("The episode URL is not an HTTP URL".into());
    }
    if !is_plain_file_name(&file_name) {
        return Err(format!("Invalid file name: {file_name}"));
    }
    let dir = settings
        .download_dir()
        .ok_or("Choose a download folder first")?;
    let dest = dir.join(&file_name);

    // Too many parallel connections make servers slow down or close them.
    let _slot = state
        .slots
        .acquire()
        .await
        .map_err(|e| format!("Download queue closed: {e}"))?;
    download_to(&state.client, &url, &dest, &on_progress).await?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn body() -> Vec<u8> {
        (0..300_000u32).map(|i| (i % 251) as u8).collect()
    }

    /// Serves `body()`. Each connection sends at most `limit` body bytes and
    /// then closes, to simulate a connection that drops.
    async fn flaky_server(limit: usize, etag: bool) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut head = Vec::new();
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        head.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&head).to_lowercase();
                    let start: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("range: bytes="))
                        .map(|r| r.trim_end_matches('-').trim().parse().unwrap())
                        .unwrap_or(0);
                    let data = body();
                    let rest = &data[start..];
                    let validator = if etag { "ETag: \"v1\"\r\n" } else { "" };
                    let status = if start > 0 {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\n",
                            start,
                            data.len() - 1,
                            data.len()
                        )
                    } else {
                        "HTTP/1.1 200 OK\r\n".to_string()
                    };
                    let header = format!(
                        "{status}{validator}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        rest.len()
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                    let _ = socket.write_all(&rest[..rest.len().min(limit)]).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (format!("http://{addr}/episode.mp3"), requests)
    }

    async fn run(limit: usize, etag: bool) -> (Result<u64, String>, usize, PathBuf) {
        let (url, requests) = flaky_server(limit, etag).await;
        let dest = std::env::temp_dir().join(format!(
            "podload-test-{}-{limit}-{etag}.mp3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&dest);
        let client = Downloader::new().client;
        let channel = Channel::new(|_| Ok(()));
        let result = download_to(&client, &url, &dest, &channel).await;
        (result, requests.load(Ordering::SeqCst), dest)
    }

    #[tokio::test]
    async fn downloads_a_full_file() {
        let (result, requests, dest) = run(usize::MAX, true).await;
        assert_eq!(result, Ok(300_000));
        assert_eq!(requests, 1);
        assert_eq!(std::fs::read(&dest).unwrap(), body());
        assert!(!part_path(&dest).exists());
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    async fn resumes_when_the_connection_drops() {
        let (result, requests, dest) = run(120_000, true).await;
        assert_eq!(result, Ok(300_000));
        assert_eq!(requests, 3);
        assert_eq!(std::fs::read(&dest).unwrap(), body());
        std::fs::remove_file(&dest).unwrap();
    }

    #[test]
    fn accepts_plain_file_names_only() {
        assert!(is_plain_file_name("Episode-1-abc1234.mp3"));
        for bad in ["", ".", "..", "../a.mp3", "a/b.mp3", "/etc/passwd", "a\\b.mp3"] {
            assert!(!is_plain_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn cleanup_removes_only_our_partial_files() {
        let dir = std::env::temp_dir().join(format!("podload-cleanup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a.mp3", "b.mp3.podload-part", "browser.part"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        remove_partial_files(&dir);
        assert!(dir.join("a.mp3").exists());
        assert!(dir.join("browser.part").exists());
        assert!(!dir.join("b.mp3.podload-part").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn never_keeps_a_cut_file() {
        // No validator: resume is not safe, and each attempt is cut.
        let (result, _requests, dest) = run(120_000, false).await;
        assert!(result.is_err(), "{result:?}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }
}
