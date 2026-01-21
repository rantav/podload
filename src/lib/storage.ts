import type { Episode, StoredState } from "./types";

export const STORAGE_KEY = "podload_state";

const normalizeEpisode = (episode: Episode): Episode => {
  if (episode.status === "downloading") {
    return { ...episode, status: "none" };
  }
  return episode;
};

export const loadStoredState = (): StoredState | null => {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredState;
    return {
      ...parsed,
      podcasts: parsed.podcasts?.map((podcast) => ({
        ...podcast,
        episodes: podcast.episodes.map(normalizeEpisode)
      })) ?? []
    };
  } catch {
    return null;
  }
};

export const saveStoredState = (state: StoredState): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const isStoredState = (value: unknown): value is StoredState => {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { podcasts?: unknown };
  return Array.isArray(maybe.podcasts);
};
