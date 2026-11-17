import type { PersistedPodcastState } from "./storage";
import type { Episode, EpisodeStatus, ParsedFeed, Podcast } from "./types";
import { DEFAULT_PAGE_SIZE, sanitizeFilename, shortenUrl } from "./utils";

export const createPodcastId = (feedUrl: string) => {
  let hash = 5381;
  for (let i = 0; i < feedUrl.length; i += 1) {
    hash = (hash * 33) ^ feedUrl.charCodeAt(i);
  }
  return `pod-${Math.abs(hash)}`;
};

export const shortHash = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  // Keep all digits. The low digits are the ones that change between IDs that
  // are almost the same, so a cut hash gives two episodes the same filename.
  return hash.toString(36).padStart(7, "0");
};

export const buildEpisodeFilename = (podcastId: string, episodeId: string, title: string, ext: string) => {
  const safeTitle = sanitizeFilename(title).slice(0, 60);
  const suffix = shortHash(`${podcastId}-${episodeId}`);
  return `${safeTitle}-${suffix}${ext}`;
};

export const mergeEpisodes = (existing: Episode[], incoming: Episode[]): Episode[] => {
  const existingById = new Map(existing.map((episode) => [episode.id, episode]));
  const incomingIds = new Set(incoming.map((episode) => episode.id));

  const merged = incoming.map((episode) => {
    const previous = existingById.get(episode.id);
    return {
      ...episode,
      status: previous?.status ?? episode.status,
      downloadPath: previous?.downloadPath ?? episode.downloadPath
    };
  });

  const extras = existing.filter((episode) => !incomingIds.has(episode.id));
  return [...merged, ...extras];
};

export const sortEpisodes = (episodes: Episode[]): Episode[] =>
  [...episodes].sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return dateB - dateA;
  });

/**
 * Merges the episodes of a feed page into a podcast. Known episodes keep their
 * status. New episodes get their saved status from `pendingStates`, if any.
 */
export const mergeFeedEpisodes = (
  podcast: Podcast,
  feed: ParsedFeed
): Pick<Podcast, "episodes" | "pendingStates"> => {
  const pending = new Map((podcast.pendingStates ?? []).map((state) => [state.id, state]));
  const episodes = sortEpisodes(
    mergeEpisodes(
      podcast.episodes,
      feed.episodes.map((episode) => ({
        ...episode,
        status: pending.get(episode.id)?.status ?? "none",
        downloadPath: pending.get(episode.id)?.downloadPath
      }))
    )
  );
  const loadedIds = new Set(episodes.map((episode) => episode.id));
  const pendingStates = (podcast.pendingStates ?? []).filter(
    (state) => !loadedIds.has(state.id)
  );
  return { episodes, pendingStates };
};

/** Applies the first page of a feed to a podcast. */
export const withFeed = (podcast: Podcast, feed: ParsedFeed): Podcast => ({
  ...podcast,
  title: feed.title,
  description: feed.description,
  imageUrl: feed.imageUrl,
  siteUrl: feed.siteUrl,
  ...mergeFeedEpisodes(podcast, feed),
  nextUrl: feed.nextUrl ?? podcast.nextUrl
});

export const settledStatus = (status: EpisodeStatus): EpisodeStatus =>
  status === "downloading" ? "none" : status;

/**
 * Builds a podcast from the saved state and the cached feed data. This needs no
 * network. A podcast without cached data keeps its statuses in `pendingStates`
 * until its feed is loaded.
 */
export const podcastFromSavedState = (entry: PersistedPodcastState, cached?: Podcast): Podcast => {
  const savedById = new Map(entry.episodeStates.map((state) => [state.id, state]));
  const episodes = (cached?.episodes ?? []).map((episode) => {
    const saved = savedById.get(episode.id);
    return {
      ...episode,
      status: settledStatus(saved?.status ?? episode.status),
      downloadPath: saved?.downloadPath ?? episode.downloadPath
    };
  });
  const loadedIds = new Set(episodes.map((episode) => episode.id));
  return {
    id: entry.id,
    title: cached?.title || shortenUrl(entry.feedUrl),
    description: cached?.description ?? "",
    imageUrl: cached?.imageUrl,
    siteUrl: cached?.siteUrl,
    feedUrl: entry.feedUrl,
    episodes: sortEpisodes(episodes),
    nextUrl: cached?.nextUrl,
    visibleCount: DEFAULT_PAGE_SIZE,
    pendingStates: entry.episodeStates
      .filter((state) => !loadedIds.has(state.id))
      .map((state) => ({ ...state, status: settledStatus(state.status) }))
  };
};

export const errorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "string" && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

export const updateEpisodeStatus = (
  podcasts: Podcast[],
  podcastId: string,
  episodeIds: string[],
  updater: (episode: Episode) => Episode
): Podcast[] =>
  podcasts.map((podcast) => {
    if (podcast.id !== podcastId) return podcast;
    return {
      ...podcast,
      episodes: podcast.episodes.map((episode) =>
        episodeIds.includes(episode.id) ? updater(episode) : episode
      )
    };
  });
