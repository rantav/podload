import { invoke } from "@tauri-apps/api/core";
import type { Episode, EpisodeStatus, Podcast, StoredState } from "./types";

export const STORAGE_KEY = "podload_state";
export const STORAGE_VERSION = 1;
const STATE_FILENAME = "podload-state.json";
const CACHE_FILENAME = "podload-cache.json";
const CACHE_VERSION = 1;

export type PersistedEpisodeState = {
  id: string;
  status: EpisodeStatus;
  /** Path of the downloaded file. */
  downloadPath?: string;
};
export type PersistedPodcastState = {
  id: string;
  feedUrl: string;
  episodeStates: PersistedEpisodeState[];
};
export type PersistedState = {
  version: 1;
  podcasts: PersistedPodcastState[];
  activePodcastId?: string | null;
  downloadDir?: string;
  /** Time of the save, in milliseconds. Used to find the newest copy. */
  savedAt?: number;
};

const exportStatusSet: Set<EpisodeStatus> = new Set([
  "none",
  "downloading",
  "downloaded",
  "skipped",
  "error"
]);

const normalizeEpisode = (episode: Episode): Episode => {
  if (episode.status === "downloading") {
    return { ...episode, status: "none" };
  }
  return episode;
};

export const isPersistedState = (value: unknown): value is PersistedState => {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { version?: unknown; podcasts?: unknown };
  if (maybe.version !== STORAGE_VERSION || !Array.isArray(maybe.podcasts)) return false;
  return maybe.podcasts.every((podcast) => {
    if (!podcast || typeof podcast !== "object") return false;
    const entry = podcast as {
      id?: unknown;
      feedUrl?: unknown;
      episodeStates?: unknown;
    };
    if (typeof entry.id !== "string" || typeof entry.feedUrl !== "string") return false;
    if (!Array.isArray(entry.episodeStates)) return false;
    return entry.episodeStates.every((episode) => {
      if (!episode || typeof episode !== "object") return false;
      const state = episode as { id?: unknown; status?: unknown; downloadPath?: unknown };
      return (
        typeof state.id === "string" &&
        (state.downloadPath === undefined || typeof state.downloadPath === "string") &&
        typeof state.status === "string" &&
        exportStatusSet.has(state.status as EpisodeStatus)
      );
    });
  });
};

export const buildPersistedState = (
  podcasts: Podcast[],
  activePodcastId?: string | null,
  downloadDir?: string
): PersistedState => ({
  version: STORAGE_VERSION,
  savedAt: Date.now(),
  activePodcastId,
  downloadDir,
  podcasts: podcasts.map((podcast) => ({
    id: podcast.id,
    feedUrl: podcast.feedUrl,
    episodeStates: [
      ...podcast.episodes.map((episode) => ({
        id: episode.id,
        status: episode.status,
        ...(episode.downloadPath ? { downloadPath: episode.downloadPath } : {})
      })),
      // Statuses of episodes that are not loaded yet must not be lost.
      ...(podcast.pendingStates ?? [])
    ]
  }))
});

const parsePersistedState = (raw: string): PersistedState | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isPersistedState(parsed)) return parsed;

    const legacy = parsed as StoredState | null;
    if (!legacy || !Array.isArray(legacy.podcasts)) return null;
    return buildPersistedState(
      legacy.podcasts.map((podcast) => ({
        ...podcast,
        episodes: podcast.episodes.map(normalizeEpisode)
      })),
      legacy.activePodcastId ?? null,
      legacy.downloadDir ?? ""
    );
  } catch {
    return null;
  }
};

export const loadStoredState = (): PersistedState | null => {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return parsePersistedState(raw);
};

export const loadStoredStateFromFile = async (): Promise<PersistedState | null> => {
  try {
    const raw = await invoke<string | null>("read_app_file", { name: STATE_FILENAME });
    return raw ? parsePersistedState(raw) : null;
  } catch {
    return null;
  }
};

export const saveStoredState = (state: PersistedState): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore persistence failures to avoid crashing the UI.
  }
};

export const saveStoredStateToFile = async (state: PersistedState): Promise<void> => {
  try {
    await invoke("write_app_file", {
      name: STATE_FILENAME,
      contents: JSON.stringify(state)
    });
  } catch {
    // Ignore persistence failures to avoid crashing the UI.
  }
};

/**
 * The cache holds the feed data of each podcast. The statuses and the download
 * paths are in the state file, which is the source of truth. With the cache, the app
 * shows the podcasts immediately at startup, also when the network is slow or
 * not available.
 */
export const loadPodcastCache = async (): Promise<Podcast[]> => {
  try {
    const raw = await invoke<string | null>("read_app_file", { name: CACHE_FILENAME });
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; podcasts?: unknown };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.podcasts)) return [];
    return (parsed.podcasts as Podcast[]).filter(
      (podcast) =>
        podcast &&
        typeof podcast.id === "string" &&
        typeof podcast.feedUrl === "string" &&
        Array.isArray(podcast.episodes)
    );
  } catch {
    return [];
  }
};

export const savePodcastCache = async (podcasts: Podcast[]): Promise<void> => {
  try {
    await invoke("write_app_file", {
      name: CACHE_FILENAME,
      contents: JSON.stringify({ version: CACHE_VERSION, podcasts })
    });
  } catch {
    // Ignore persistence failures to avoid crashing the UI.
  }
};
