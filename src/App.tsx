import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  IconCheck,
  IconCheckSquare,
  IconChevronDown,
  IconDownload,
  IconFolder,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSkip,
  IconSquare,
  IconTrash
} from "./components/Icons";
import { discoverFeedUrl, fetchFeed } from "./lib/feed";
import { canUseTauriApis, safeFetch } from "./lib/http";
import { loadStoredState, saveStoredState } from "./lib/storage";
import type { Episode, EpisodeStatus, Podcast } from "./lib/types";
import {
  DEFAULT_PAGE_SIZE,
  formatDate,
  formatDuration,
  guessExtension,
  sanitizeFilename,
  shortenUrl
} from "./lib/utils";
import "./App.css";

type ExportEpisodeState = { id: string; status: EpisodeStatus };
type ExportPodcastState = { id: string; feedUrl: string; episodeStates: ExportEpisodeState[] };
type ExportState = {
  version: 1;
  podcasts: ExportPodcastState[];
  activePodcastId?: string | null;
};

const exportStatusSet: Set<EpisodeStatus> = new Set([
  "none",
  "downloading",
  "downloaded",
  "skipped",
  "error"
]);

const isExportState = (value: unknown): value is ExportState => {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { version?: unknown; podcasts?: unknown };
  if (maybe.version !== 1 || !Array.isArray(maybe.podcasts)) return false;
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

const createPodcastId = (feedUrl: string) => {
  let hash = 5381;
  for (let i = 0; i < feedUrl.length; i += 1) {
    hash = (hash * 33) ^ feedUrl.charCodeAt(i);
  }
  return `pod-${Math.abs(hash)}`;
};

const joinPath = (dir: string, file: string) => `${dir.replace(/\/+$/g, "")}/${file}`;

const shortHash = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 5).padEnd(5, "0");
};

const buildEpisodeFilename = (podcastId: string, episodeId: string, title: string, ext: string) => {
  const safeTitle = sanitizeFilename(title).slice(0, 60);
  const suffix = shortHash(`${podcastId}-${episodeId}`);
  return `${safeTitle}-${suffix}${ext}`;
};

const mergeEpisodes = (existing: Episode[], incoming: Episode[]): Episode[] => {
  const existingById = new Map(existing.map((episode) => [episode.id, episode]));
  const incomingIds = new Set(incoming.map((episode) => episode.id));

  const merged = incoming.map((episode) => {
    const previous = existingById.get(episode.id);
    return {
      ...episode,
      status: previous?.status ?? "none",
      downloadPath: previous?.downloadPath
    };
  });

  const extras = existing.filter((episode) => !incomingIds.has(episode.id));
  return [...merged, ...extras];
};

const updateEpisodeStatus = (
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

const sortEpisodes = (episodes: Episode[]): Episode[] =>
  [...episodes].sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return dateB - dateA;
  });

const ensureStatusForDownload = (status: EpisodeStatus): EpisodeStatus =>
  status === "downloaded" ? "downloaded" : "downloading";

function App() {
  const stored = loadStoredState();
  const [podcasts, setPodcasts] = useState<Podcast[]>(stored?.podcasts ?? []);
  const [activePodcastId, setActivePodcastId] = useState<string | null>(
    stored?.activePodcastId ?? stored?.podcasts?.[0]?.id ?? null
  );
  const [downloadDir, setDownloadDir] = useState(stored?.downloadDir ?? "");
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "downloaded">("all");
  const [search, setSearch] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [playingEpisodeId, setPlayingEpisodeId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    saveStoredState({ podcasts, activePodcastId, downloadDir });
  }, [podcasts, activePodcastId, downloadDir]);

  useEffect(() => {
    setSelectedEpisodeIds(new Set());
    setSearch("");
    setFilter("all");
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setPlayingEpisodeId(null);
  }, [activePodcastId]);

  useEffect(() => {
    if (!statusMessage) return undefined;
    const timeout = setTimeout(() => setStatusMessage(null), 5000);
    return () => clearTimeout(timeout);
  }, [statusMessage]);

  const activePodcast = useMemo(
    () => podcasts.find((podcast) => podcast.id === activePodcastId) ?? null,
    [podcasts, activePodcastId]
  );

  const filteredEpisodes = useMemo(() => {
    if (!activePodcast) return [];
    return activePodcast.episodes
      .filter((episode) =>
        filter === "downloaded" ? episode.status === "downloaded" : true
      )
      .filter((episode) => {
        const term = search.trim().toLowerCase();
        if (!term) return true;
        return (
          episode.title.toLowerCase().includes(term) ||
          (episode.description ?? "").toLowerCase().includes(term)
        );
      });
  }, [activePodcast, filter, search]);

  const visibleCount = activePodcast?.visibleCount ?? DEFAULT_PAGE_SIZE;
  const visibleEpisodes = filteredEpisodes.slice(0, visibleCount);
  const canLoadMore =
    Boolean(activePodcast?.nextUrl) || filteredEpisodes.length > visibleCount;

  const allVisibleSelected =
    visibleEpisodes.length > 0 &&
    visibleEpisodes.every((episode) => selectedEpisodeIds.has(episode.id));

  const pickDownloadDir = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: "Choose a download folder"
    });

    if (typeof selection === "string") {
      setDownloadDir(selection);
      return selection;
    }

    return "";
  };

  const ensureDownloadDir = async () => {
    if (downloadDir) return downloadDir;
    return pickDownloadDir();
  };

  const setEpisodeStatuses = (episodeIds: string[], status: EpisodeStatus) => {
    if (!activePodcast) return;
    setPodcasts((current) =>
      updateEpisodeStatus(current, activePodcast.id, episodeIds, (episode) => ({
        ...episode,
        status
      }))
    );
  };

  const handleAddPodcast = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!newUrl.trim() || isFetching) return;
    setIsFetching(true);
    setStatusMessage(null);

    try {
      const feedUrl = await discoverFeedUrl(newUrl);
      const feed = await fetchFeed(feedUrl);
      const podcastId = createPodcastId(feedUrl);

      setPodcasts((current) => {
        const existing = current.find((podcast) => podcast.id === podcastId);
        const mergedEpisodes = mergeEpisodes(
          existing?.episodes ?? [],
          feed.episodes.map((episode) => ({ ...episode, status: "none" }))
        );

        const nextPodcast: Podcast = {
          id: podcastId,
          title: feed.title,
          description: feed.description,
          imageUrl: feed.imageUrl,
          siteUrl: feed.siteUrl,
          feedUrl: feed.feedUrl,
          episodes: sortEpisodes(mergedEpisodes),
          nextUrl: feed.nextUrl,
          visibleCount: existing?.visibleCount ?? DEFAULT_PAGE_SIZE
        };

        const others = current.filter((podcast) => podcast.id !== podcastId);
        return [nextPodcast, ...others];
      });

      setActivePodcastId(podcastId);
      setNewUrl("");
      setIsAdding(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to add podcast"
      );
    } finally {
      setIsFetching(false);
    }
  };

  const handleRemovePodcast = (podcastId: string) => {
    setPodcasts((current) => {
      const updated = current.filter((podcast) => podcast.id !== podcastId);
      if (activePodcastId === podcastId) {
        setActivePodcastId(updated[0]?.id ?? null);
      }
      return updated;
    });
  };

  const handleRefreshPodcast = async () => {
    if (!activePodcast || isFetching) return;
    setIsFetching(true);
    setStatusMessage(null);

    try {
      const feed = await fetchFeed(activePodcast.feedUrl);
      setPodcasts((current) =>
        current.map((podcast) => {
          if (podcast.id !== activePodcast.id) return podcast;
          const mergedEpisodes = mergeEpisodes(
            podcast.episodes,
            feed.episodes.map((episode) => ({ ...episode, status: "none" }))
          );
          return {
            ...podcast,
            title: feed.title,
            description: feed.description,
            imageUrl: feed.imageUrl,
            siteUrl: feed.siteUrl,
            episodes: sortEpisodes(mergedEpisodes),
            nextUrl: feed.nextUrl ?? podcast.nextUrl
          };
        })
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Refresh failed"
      );
    } finally {
      setIsFetching(false);
    }
  };

  const handleExportState = async () => {
    if (!canUseTauriApis()) {
      setStatusMessage("Export is available in the desktop app runtime.");
      return;
    }
    const destination = await save({
      title: "Save Podload state",
      defaultPath: "podload-state.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (!destination) return;
    try {
      const exportState: ExportState = {
        version: 1,
        activePodcastId,
        podcasts: podcasts.map((podcast) => ({
          id: podcast.id,
          feedUrl: podcast.feedUrl,
          episodeStates: podcast.episodes.map((episode) => ({
            id: episode.id,
            status: episode.status
          }))
        }))
      };
      const payload = JSON.stringify(exportState, null, 2);
      await writeTextFile(destination, payload);
      setStatusMessage("State exported.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Export failed"
      );
    }
  };

  const handleImportState = async () => {
    if (!canUseTauriApis()) {
      setStatusMessage("Import is available in the desktop app runtime.");
      return;
    }
    const selection = await open({
      title: "Import Podload state",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (typeof selection !== "string") return;
    try {
      const raw = await readTextFile(selection);
      const parsed = JSON.parse(raw) as unknown;
      if (!isExportState(parsed)) {
        setStatusMessage("Invalid state file.");
        return;
      }
      setIsFetching(true);
      const importedPodcasts: Podcast[] = [];
      for (const entry of parsed.podcasts) {
        try {
          const feed = await fetchFeed(entry.feedUrl);
          const statusMap = new Map(
            entry.episodeStates.map((episodeState) => [
              episodeState.id,
              episodeState.status === "downloading" ? "none" : episodeState.status
            ])
          );
          const episodes = sortEpisodes(
            feed.episodes.map((episode) => ({
              ...episode,
              status: statusMap.get(episode.id) ?? "none"
            }))
          );
          importedPodcasts.push({
            id: entry.id,
            title: feed.title,
            description: feed.description,
            imageUrl: feed.imageUrl,
            siteUrl: feed.siteUrl,
            feedUrl: feed.feedUrl,
            episodes,
            nextUrl: feed.nextUrl,
            visibleCount: DEFAULT_PAGE_SIZE
          });
        } catch {
          setStatusMessage(`Failed to refresh ${entry.feedUrl}`);
        }
      }
      if (importedPodcasts.length === 0) {
        setStatusMessage("No podcasts could be imported.");
        return;
      }
      setPodcasts(importedPodcasts);
      const nextActive =
        parsed.activePodcastId &&
        importedPodcasts.some((podcast) => podcast.id === parsed.activePodcastId)
          ? parsed.activePodcastId
          : importedPodcasts[0].id;
      setActivePodcastId(nextActive);
      setStatusMessage("State imported.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Import failed"
      );
    } finally {
      setIsFetching(false);
    }
  };

  const handleLoadMore = async () => {
    if (!activePodcast || isLoadingMore) return;
    setIsLoadingMore(true);

    try {
      if (activePodcast.nextUrl) {
        const feed = await fetchFeed(activePodcast.nextUrl);
        setPodcasts((current) =>
          current.map((podcast) => {
            if (podcast.id !== activePodcast.id) return podcast;
            const mergedEpisodes = mergeEpisodes(
              podcast.episodes,
              feed.episodes.map((episode) => ({ ...episode, status: "none" }))
            );
            return {
              ...podcast,
              episodes: sortEpisodes(mergedEpisodes),
              nextUrl: feed.nextUrl,
              visibleCount: podcast.visibleCount + DEFAULT_PAGE_SIZE
            };
          })
        );
      } else {
        setPodcasts((current) =>
          current.map((podcast) =>
            podcast.id === activePodcast.id
              ? { ...podcast, visibleCount: podcast.visibleCount + DEFAULT_PAGE_SIZE }
              : podcast
          )
        );
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not load more episodes"
      );
    } finally {
      setIsLoadingMore(false);
    }
  };

  const toggleSelection = (episodeId: string) => {
    setSelectedEpisodeIds((current) => {
      const next = new Set(current);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedEpisodeIds(new Set());
      return;
    }
    setSelectedEpisodeIds(new Set(visibleEpisodes.map((episode) => episode.id)));
  };

  const handleSkip = (episodeId: string) => {
    if (!activePodcast) return;
    setPodcasts((current) =>
      updateEpisodeStatus(current, activePodcast.id, [episodeId], (episode) => ({
        ...episode,
        status: episode.status === "skipped" ? "none" : "skipped"
      }))
    );
  };

  const handleBatchSkip = () => {
    if (selectedEpisodeIds.size === 0) return;
    setEpisodeStatuses(Array.from(selectedEpisodeIds), "skipped");
    setSelectedEpisodeIds(new Set());
  };

  const handlePlay = (episode: Episode) => {
    if (!audioRef.current) return;
    if (playingEpisodeId === episode.id) {
      audioRef.current.pause();
      setPlayingEpisodeId(null);
      return;
    }

    const source = episode.downloadPath
      ? convertFileSrc(episode.downloadPath)
      : episode.audioUrl;
    if (!source) {
      setStatusMessage("This episode has no audio file to play.");
      return;
    }
    audioRef.current.src = source;
    void audioRef.current.play();
    setPlayingEpisodeId(episode.id);
  };

  const downloadEpisode = async (episodeId: string, forcedDir?: string) => {
    if (!activePodcast) return;
    if (!canUseTauriApis()) {
      setStatusMessage("Downloads require the desktop app runtime.");
      return;
    }
    const episode = activePodcast.episodes.find((item) => item.id === episodeId);
    if (!episode) return;
    if (!episode.audioUrl) {
      setStatusMessage("No audio URL found for this episode.");
      return;
    }

    const destinationDir = forcedDir || (await ensureDownloadDir());
    if (!destinationDir) return;

    setPodcasts((current) =>
      updateEpisodeStatus(current, activePodcast.id, [episodeId], (currentEpisode) => ({
        ...currentEpisode,
        status: ensureStatusForDownload(currentEpisode.status)
      }))
    );

    try {
      const response = await safeFetch(episode.audioUrl, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const filename = buildEpisodeFilename(
        activePodcast.id,
        episode.id,
        episode.title,
        guessExtension(episode.audioUrl)
      );
      const filePath = joinPath(destinationDir, filename);
      await writeFile(filePath, bytes);

      setPodcasts((current) =>
        updateEpisodeStatus(current, activePodcast.id, [episodeId], (currentEpisode) => ({
          ...currentEpisode,
          status: "downloaded",
          downloadPath: filePath
        }))
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Episode download failed"
      );
      setPodcasts((current) =>
        updateEpisodeStatus(current, activePodcast.id, [episodeId], (currentEpisode) => ({
          ...currentEpisode,
          status: "error"
        }))
      );
    }
  };

  const handleBatchDownload = async () => {
    if (selectedEpisodeIds.size === 0) return;
    const destinationDir = await ensureDownloadDir();
    if (!destinationDir) return;

    const ids = Array.from(selectedEpisodeIds);
    await Promise.all(ids.map((id) => downloadEpisode(id, destinationDir)));
    setSelectedEpisodeIds(new Set());
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="sidebar-title">Podload</p>
            <p className="sidebar-subtitle">Podcast downloads, kept tidy.</p>
            <div className="sidebar-exports">
              <button type="button" className="ghost inline" onClick={handleImportState}>
                Import state
              </button>
              <button type="button" className="ghost inline" onClick={handleExportState}>
                Export state
              </button>
            </div>
          </div>
        </div>

        <div className="sidebar-footer">
          {isAdding ? (
            <form className="add-form" onSubmit={handleAddPodcast}>
              <input
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="Paste podcast site or RSS URL"
              />
              <div className="add-actions">
                <button type="submit" className="primary" disabled={isFetching}>
                  {isFetching ? "Finding feed..." : "Add podcast"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setIsAdding(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="ghost add-button" onClick={() => setIsAdding(true)}>
              <IconPlus />
              Add podcast
            </button>
          )}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Podcasts</span>
            <span className="sidebar-count">{podcasts.length}</span>
          </div>
          <div className="podcast-list">
            {podcasts.map((podcast) => (
              <div
                key={podcast.id}
                role="button"
                tabIndex={0}
                className={`podcast-item ${
                  activePodcastId === podcast.id ? "active" : ""
                }`}
                onClick={() => setActivePodcastId(podcast.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActivePodcastId(podcast.id);
                  }
                }}
              >
                <span className="podcast-avatar">
                  {podcast.imageUrl ? (
                    <img src={podcast.imageUrl} alt="" />
                  ) : (
                    podcast.title.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span className="podcast-meta">
                  <span className="podcast-name">{podcast.title}</span>
                  <span className="podcast-host">
                    {shortenUrl(podcast.siteUrl ?? podcast.feedUrl)}
                  </span>
                </span>
                <span className="podcast-actions">
                  {activePodcastId === podcast.id && (
                    <button
                      type="button"
                      className="icon-button ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemovePodcast(podcast.id);
                      }}
                      aria-label={`Remove ${podcast.title}`}
                    >
                      <IconTrash />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

      </aside>

      <main className="main">
        {activePodcast ? (
          <>
            <header className="hero">
              <div className="hero-art">
                {activePodcast.imageUrl ? (
                  <img src={activePodcast.imageUrl} alt="" />
                ) : (
                  <div className="hero-fallback">
                    {activePodcast.title.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="hero-content">
                <p className="hero-kicker">Podcast</p>
                <h1>{activePodcast.title}</h1>
                <p className="hero-description">
                  {activePodcast.description || "No description provided."}
                </p>
                <div className="hero-meta">
                  <span>{activePodcast.episodes.length} episodes</span>
                  <span>{shortenUrl(activePodcast.siteUrl ?? activePodcast.feedUrl)}</span>
                  <button
                    type="button"
                    className="ghost inline"
                    onClick={handleRefreshPodcast}
                    disabled={isFetching}
                  >
                    <IconRefresh />
                    Refresh
                  </button>
                </div>
              </div>
              <div className="hero-actions">
                <div className="download-location">
                  <div>
                    <span className="label">Download folder</span>
                    <span className="value">
                      {downloadDir ? downloadDir : "Choose a folder"}
                    </span>
                  </div>
                  <button type="button" className="primary" onClick={pickDownloadDir}>
                    <IconFolder />
                    Set location
                  </button>
                </div>
              </div>
            </header>

            <section className="toolbar">
              <div className="toolbar-left">
                <div className="segmented">
                  <button
                    type="button"
                    className={filter === "all" ? "active" : ""}
                    onClick={() => setFilter("all")}
                  >
                    All episodes
                  </button>
                  <button
                    type="button"
                    className={filter === "downloaded" ? "active" : ""}
                    onClick={() => setFilter("downloaded")}
                  >
                    Downloaded
                  </button>
                </div>
                {selectedEpisodeIds.size > 0 && (
                  <div className="batch-actions">
                    <span>{selectedEpisodeIds.size} selected</span>
                    <button type="button" className="primary" onClick={handleBatchDownload}>
                      <IconDownload />
                      Download
                    </button>
                    <button type="button" className="ghost" onClick={handleBatchSkip}>
                      <IconSkip />
                      Skip
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setSelectedEpisodeIds(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div className="toolbar-right">
                <div className="search">
                  <IconSearch />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search episodes"
                  />
                </div>
              </div>
            </section>

            <section className="episodes">
              <div className="episodes-header">
                <button type="button" className="checkbox" onClick={toggleSelectAll}>
                  {allVisibleSelected ? <IconCheckSquare /> : <IconSquare />}
                </button>
                <span>Episode</span>
                <span>Actions</span>
              </div>

              {visibleEpisodes.map((episode) => {
                const isSelected = selectedEpisodeIds.has(episode.id);
                const isDownloading = episode.status === "downloading";
                const isDownloaded = episode.status === "downloaded";
                const isSkipped = episode.status === "skipped";
                const isPlaying = playingEpisodeId === episode.id;
                const dateLabel = formatDate(episode.pubDate);
                const durationLabel = formatDuration(episode.duration);
                const metaLabel = [dateLabel, durationLabel].filter(Boolean).join(" • ");

                return (
                  <article
                    key={episode.id}
                    className={`episode ${
                      isSelected ? "selected" : ""
                    } ${isSkipped ? "skipped" : ""}`}
                  >
                    <button type="button" className="checkbox" onClick={() => toggleSelection(episode.id)}>
                      {isSelected ? <IconCheckSquare /> : <IconSquare />}
                    </button>
                    <div className="episode-body">
                      <div className="episode-title">
                        <h3>{episode.title}</h3>
                        <span className="episode-meta">
                          {metaLabel}
                        </span>
                      </div>
                      <p className="episode-description">
                        {episode.description || "No summary available."}
                      </p>
                      <div className="episode-tags">
                        {isDownloaded && (
                          <span className="tag downloaded">
                            <IconCheck /> Downloaded
                          </span>
                        )}
                        {isSkipped && <span className="tag skipped">Skipped</span>}
                        {episode.status === "error" && (
                          <span className="tag error">Download failed</span>
                        )}
                      </div>
                    </div>
                    <div className="episode-actions">
                      <button
                        type="button"
                        className={`icon-button ${isPlaying ? "active" : ""}`}
                        onClick={() => handlePlay(episode)}
                        title={isPlaying ? "Pause" : "Play"}
                      >
                        {isPlaying ? <IconPause /> : <IconPlay />}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => downloadEpisode(episode.id)}
                        disabled={isDownloading || isDownloaded || isSkipped}
                        title="Download"
                      >
                        {isDownloading ? <span className="spinner" /> : <IconDownload />}
                      </button>
                      <button
                        type="button"
                        className={`icon-button ${isSkipped ? "warn" : ""}`}
                        onClick={() => handleSkip(episode.id)}
                        title={isSkipped ? "Unskip" : "Skip"}
                      >
                        <IconSkip />
                      </button>
                    </div>
                  </article>
                );
              })}

              {visibleEpisodes.length === 0 && (
                <div className="empty-state">
                  <p>No episodes match this view yet.</p>
                </div>
              )}

              {canLoadMore && (
                <div className="load-more">
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleLoadMore}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? "Loading..." : "Load more episodes"}
                    <IconChevronDown />
                  </button>
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="empty-screen">
            <h2>Add your first podcast</h2>
            <p>Paste any podcast home page or RSS URL to start downloading.</p>
            <button type="button" className="primary" onClick={() => setIsAdding(true)}>
              <IconPlus />
              Add a podcast
            </button>
          </div>
        )}

        {statusMessage && <div className="status-banner">{statusMessage}</div>}
      </main>

      <audio
        ref={audioRef}
        onEnded={() => setPlayingEpisodeId(null)}
        onPause={() => setPlayingEpisodeId(null)}
        className="sr-only"
      />
    </div>
  );
}

export default App;
