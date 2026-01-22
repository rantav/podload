import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Episode, EpisodeStatus, Podcast, StoredState } from "./types";

export const STORAGE_KEY = "podload_state";
export const STORAGE_VERSION = 1;
const STATE_FILENAME = "podload-state.json";

export type PersistedEpisodeState = { id: string; status: EpisodeStatus };
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
      const state = episode as { id?: unknown; status?: unknown };
      return (
        typeof state.id === "string" &&
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
  activePodcastId,
  downloadDir,
  podcasts: podcasts.map((podcast) => ({
    id: podcast.id,
    feedUrl: podcast.feedUrl,
    episodeStates: podcast.episodes.map((episode) => ({
      id: episode.id,
      status: episode.status
    }))
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
    const raw = await readTextFile(STATE_FILENAME, { baseDir: BaseDirectory.AppData });
    return parsePersistedState(raw);
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
    await writeTextFile(STATE_FILENAME, JSON.stringify(state), {
      baseDir: BaseDirectory.AppData
    });
  } catch {
    // Ignore persistence failures to avoid crashing the UI.
  }
};
