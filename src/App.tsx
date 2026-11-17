import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { downloadFile, getDownloadDir, pickDownloadDir as pickNativeDownloadDir } from "./lib/download";
import { discoverFeedUrl, fetchFeed } from "./lib/feed";
import {
  buildEpisodeFilename,
  createPodcastId,
  errorMessage,
  mergeFeedEpisodes,
  podcastFromSavedState,
  updateEpisodeStatus,
  withFeed
} from "./lib/podcasts";
import { canUseTauriApis } from "./lib/http";
import {
  buildPersistedState,
  isPersistedState,
  loadPodcastCache,
  loadStoredState,
  loadStoredStateFromFile,
  savePodcastCache,
  saveStoredState,
  saveStoredStateToFile,
  type PersistedState
} from "./lib/storage";
import type { Episode, EpisodeStatus, Podcast } from "./lib/types";
import {
  DEFAULT_PAGE_SIZE,
  formatDate,
  formatDuration,
  guessExtension,
  shortenUrl
} from "./lib/utils";
import "./App.css";

const SAVE_DELAY_MS = 400;
// The cache is large. Write it only when feed data changes, and not often.
const CACHE_SAVE_DELAY_MS = 1500;
const CLOSE_FLUSH_LIMIT_MS = 2000;

function App() {
  const storedRef = useRef(loadStoredState());
  const stored = storedRef.current;
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [activePodcastId, setActivePodcastId] = useState<string | null>(
    stored?.activePodcastId ?? null
  );
  // The Rust side owns the download folder. This is a copy for the UI.
  const [downloadDir, setDownloadDir] = useState("");
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "downloaded">("all");
  const [search, setSearch] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [playingEpisodeId, setPlayingEpisodeId] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Download progress per episode: a fraction (0-1), or null when not known.
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number | null>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const deferredSearch = useDeferredValue(search);
  // Changes when feed data changes. Status changes do not change it.
  const [feedRevision, setFeedRevision] = useState(0);
  const markFeedDataChanged = useCallback(() => setFeedRevision((value) => value + 1), []);
  const podcastsRef = useRef(podcasts);
  const pendingSavesRef = useRef(new Map<string, () => Promise<void>>());

  useEffect(() => {
    podcastsRef.current = podcasts;
  }, [podcasts]);

  // Save the state after a short delay, so a burst of changes causes one write.
  useEffect(() => {
    if (!hasHydrated) return undefined;
    const pending = pendingSavesRef.current;
    const save = async () => {
      pending.delete("state");
      const nextState = buildPersistedState(podcasts, activePodcastId, downloadDir);
      saveStoredState(nextState);
      if (canUseTauriApis()) await saveStoredStateToFile(nextState);
    };
    pending.set("state", save);
    const timeout = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [podcasts, activePodcastId, downloadDir, hasHydrated]);

  // Save the feed cache only when feed data changed.
  useEffect(() => {
    if (!hasHydrated || feedRevision === 0 || !canUseTauriApis()) return undefined;
    const pending = pendingSavesRef.current;
    const save = async () => {
      pending.delete("cache");
      await savePodcastCache(podcastsRef.current);
    };
    pending.set("cache", save);
    const timeout = setTimeout(() => void save(), CACHE_SAVE_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [feedRevision, hasHydrated]);

  // Do not lose the last change when the window closes.
  useEffect(() => {
    const flushSaves = () =>
      Promise.all(Array.from(pendingSavesRef.current.values()).map((save) => save()));
    const flush = () => void flushSaves();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (canUseTauriApis()) {
      // The window closes after this handler completes.
      void getCurrentWindow()
        .onCloseRequested(async () => {
          await Promise.race([
            flushSaves(),
            new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_LIMIT_MS))
          ]);
        })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  /** Loads the feeds in parallel and merges each one when it arrives. */
  const refreshFeeds = useCallback(async (targets: Pick<Podcast, "id" | "feedUrl">[]) => {
    if (targets.length === 0) return;
    setIsRefreshing(true);
    const failed: string[] = [];
    await Promise.all(
      targets.map(async (target) => {
        try {
          const feed = await fetchFeed(target.feedUrl);
          setPodcasts((current) =>
            current.map((podcast) =>
              podcast.id === target.id ? withFeed(podcast, feed) : podcast
            )
          );
          markFeedDataChanged();
        } catch {
          failed.push(shortenUrl(target.feedUrl));
        }
      })
    );
    setIsRefreshing(false);
    if (failed.length > 0) {
      setStatusMessage(`Could not refresh: ${failed.join(", ")}`);
    }
  }, [markFeedDataChanged]);

  /**
   * Shows the saved podcasts immediately, then refreshes the feeds in the
   * background. A feed that fails keeps its podcast and its statuses.
   */
  const applyPersistedState = useCallback(
    (state: PersistedState, cache: Podcast[]) => {
      const cachedById = new Map(cache.map((podcast) => [podcast.id, podcast]));
      const restored = state.podcasts.map((entry) =>
        podcastFromSavedState(entry, cachedById.get(entry.id))
      );
      setPodcasts(restored);
      setActivePodcastId(
        state.activePodcastId &&
          restored.some((podcast) => podcast.id === state.activePodcastId)
          ? state.activePodcastId
          : (restored[0]?.id ?? null)
      );
      markFeedDataChanged();
      void refreshFeeds(restored);
    },
    [refreshFeeds, markFeedDataChanged]
  );

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const local = loadStoredState();
      let persisted = local;
      let cache: Podcast[] = [];
      if (canUseTauriApis()) {
        const [fromFile, cached, savedDir] = await Promise.all([
          loadStoredStateFromFile(),
          loadPodcastCache(),
          getDownloadDir().catch(() => "")
        ]);
        cache = cached;
        if (!cancelled) setDownloadDir(savedDir);
        // Use the newest copy. The file is the default.
        if (fromFile && (!local || (fromFile.savedAt ?? 0) >= (local.savedAt ?? 0))) {
          persisted = fromFile;
        }
      }
      if (cancelled) return;
      if (persisted?.podcasts?.length) {
        applyPersistedState(persisted, cache);
      }
      setHasHydrated(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [applyPersistedState]);

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
        const term = deferredSearch.trim().toLowerCase();
        if (!term) return true;
        return (
          episode.title.toLowerCase().includes(term) ||
          (episode.description ?? "").toLowerCase().includes(term)
        );
      });
  }, [activePodcast, filter, deferredSearch]);

  // Show the loading screen only when there is nothing to show yet.
  const isHydrating =
    !hasHydrated ||
    (isRefreshing && activePodcast !== null && activePodcast.episodes.length === 0);

  const visibleCount = activePodcast?.visibleCount ?? DEFAULT_PAGE_SIZE;
  const visibleEpisodes = filteredEpisodes.slice(0, visibleCount);
  const canLoadMore =
    Boolean(activePodcast?.nextUrl) || filteredEpisodes.length > visibleCount;

  const allVisibleSelected =
    visibleEpisodes.length > 0 &&
    visibleEpisodes.every((episode) => selectedEpisodeIds.has(episode.id));

  const pickDownloadDir = async () => {
    if (!canUseTauriApis()) {
      setStatusMessage("Downloads require the desktop app runtime.");
      return "";
    }
    try {
      const selection = await pickNativeDownloadDir();
      if (selection) setDownloadDir(selection);
      return selection;
    } catch (error) {
      setStatusMessage(errorMessage(error, "Could not set the download folder"));
      return "";
    }
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
        const nextPodcast = withFeed(
          existing ?? {
            id: podcastId,
            title: feed.title,
            description: feed.description,
            feedUrl: feed.feedUrl,
            episodes: [],
            visibleCount: DEFAULT_PAGE_SIZE
          },
          feed
        );

        const others = current.filter((podcast) => podcast.id !== podcastId);
        return [nextPodcast, ...others];
      });

      markFeedDataChanged();
      setActivePodcastId(podcastId);
      setNewUrl("");
      setIsAdding(false);
    } catch (error) {
      setStatusMessage(errorMessage(error, "Failed to add podcast"));
    } finally {
      setIsFetching(false);
    }
  };

  const handleRemovePodcast = (podcastId: string) => {
    const remaining = podcasts.filter((podcast) => podcast.id !== podcastId);
    setPodcasts((current) => current.filter((podcast) => podcast.id !== podcastId));
    if (activePodcastId === podcastId) {
      setActivePodcastId(remaining[0]?.id ?? null);
    }
    markFeedDataChanged();
  };

  const handleRefreshPodcast = async () => {
    if (!activePodcast || isFetching) return;
    setIsFetching(true);
    setStatusMessage(null);

    try {
      const feed = await fetchFeed(activePodcast.feedUrl);
      setPodcasts((current) =>
        current.map((podcast) =>
          podcast.id === activePodcast.id ? withFeed(podcast, feed) : podcast
        )
      );
      markFeedDataChanged();
    } catch (error) {
      setStatusMessage(errorMessage(error, "Refresh failed"));
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
      const payload = JSON.stringify(
        buildPersistedState(podcasts, activePodcastId, downloadDir),
        null,
        2
      );
      await writeTextFile(destination, payload);
      setStatusMessage("State exported.");
    } catch (error) {
      setStatusMessage(errorMessage(error, "Export failed"));
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
      if (!isPersistedState(parsed)) {
        setStatusMessage("Invalid state file.");
        return;
      }
      if (parsed.podcasts.length === 0) {
        setStatusMessage("The state file contains no podcasts.");
        return;
      }
      // Keep the feed data of podcasts that are already loaded.
      applyPersistedState(parsed, podcasts);
      setStatusMessage("State imported.");
    } catch (error) {
      setStatusMessage(errorMessage(error, "Import failed"));
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
            return {
              ...podcast,
              ...mergeFeedEpisodes(podcast, feed),
              nextUrl: feed.nextUrl,
              visibleCount: podcast.visibleCount + DEFAULT_PAGE_SIZE
            };
          })
        );
        markFeedDataChanged();
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
      setStatusMessage(errorMessage(error, "Could not load more episodes"));
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
    setPlayingEpisodeId(episode.id);
    audioRef.current.play().catch(() => {
      setPlayingEpisodeId((current) => (current === episode.id ? null : current));
      setStatusMessage(
        episode.downloadPath
          ? "Could not play the downloaded file. Download the episode again."
          : "Could not play this episode."
      );
    });
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

    if (episode.status === "downloading") return;

    const destinationDir = forcedDir || (await ensureDownloadDir());
    if (!destinationDir) return;

    const podcastId = activePodcast.id;
    const setStatus = (status: EpisodeStatus, downloadPath?: string) =>
      setPodcasts((current) =>
        updateEpisodeStatus(current, podcastId, [episodeId], (currentEpisode) => ({
          ...currentEpisode,
          status,
          downloadPath: downloadPath ?? currentEpisode.downloadPath
        }))
      );

    setStatus("downloading");

    try {
      const filename = buildEpisodeFilename(
        podcastId,
        episode.id,
        episode.title,
        guessExtension(episode.audioUrl)
      );
      // The Rust side writes to a partial file in the download folder, verifies
      // the size, then renames the file.
      const filePath = await downloadFile(episode.audioUrl, filename, ({ received, total }) => {
        setDownloadProgress((current) => ({
          ...current,
          [episodeId]: total ? received / total : null
        }));
      });
      setStatus("downloaded", filePath);
    } catch (error) {
      setStatusMessage(`${episode.title}: ${errorMessage(error, "Episode download failed")}`);
      setStatus("error");
    } finally {
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[episodeId];
        return next;
      });
    }
  };

  const handleBatchDownload = async () => {
    if (selectedEpisodeIds.size === 0) return;
    const destinationDir = await ensureDownloadDir();
    if (!destinationDir) return;

    const ids = Array.from(selectedEpisodeIds);
    setSelectedEpisodeIds(new Set());
    // The Rust side limits the number of parallel downloads.
    await Promise.all(ids.map((id) => downloadEpisode(id, destinationDir)));
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
        {isHydrating ? (
          <div className="loading-screen">
            <span className="spinner large" aria-hidden="true" />
            <p>Loading your podcasts…</p>
          </div>
        ) : activePodcast ? (
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
                const progress = downloadProgress[episode.id];
                const progressLabel =
                  typeof progress === "number"
                    ? `Downloading ${Math.floor(progress * 100)}%`
                    : episode.id in downloadProgress
                      ? "Downloading…"
                      : "Waiting to download…";
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
                        {isDownloading && <span className="tag">{progressLabel}</span>}
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
                        disabled={isDownloading || isSkipped}
                        title={isDownloaded ? "Download again" : "Download"}
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
