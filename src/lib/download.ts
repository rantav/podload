import { Channel, invoke } from "@tauri-apps/api/core";

export type DownloadProgress = { received: number; total: number | null };

/**
 * Downloads a file in the Rust process, into the download folder. The data
 * does not pass through the webview. The promise resolves with the path of the
 * file, and only after the full file is on disk.
 */
export const downloadFile = (
  url: string,
  fileName: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> => {
  const channel = new Channel<DownloadProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<string>("download_file", { url, fileName, onProgress: channel });
};

/** The download folder. Only the native folder dialog can change it. */
export const getDownloadDir = async (): Promise<string> =>
  (await invoke<string | null>("get_download_dir")) ?? "";

/** Opens the folder dialog. Returns "" when the user cancels. */
export const pickDownloadDir = async (): Promise<string> =>
  (await invoke<string | null>("pick_download_dir")) ?? "";
