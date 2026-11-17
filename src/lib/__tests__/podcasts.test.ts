import { describe, expect, it } from "vitest";
import {
  buildEpisodeFilename,
  mergeFeedEpisodes,
  podcastFromSavedState,
  withFeed
} from "../podcasts";
import { buildPersistedState, isPersistedState } from "../storage";
import type { Episode, ParsedFeed, Podcast } from "../types";

const episode = (id: string, extra: Partial<Episode> = {}): Episode => ({
  id,
  title: `Episode ${id}`,
  description: "",
  pubDate: `2026-01-0${id}T00:00:00Z`,
  audioUrl: `https://example.com/${id}.mp3`,
  status: "none",
  ...extra
});

const feed = (ids: string[], extra: Partial<ParsedFeed> = {}): ParsedFeed => ({
  title: "My Podcast",
  description: "About things",
  feedUrl: "https://example.com/feed",
  episodes: ids.map((id) => episode(id)),
  ...extra
});

const podcast = (episodes: Episode[], extra: Partial<Podcast> = {}): Podcast => ({
  id: "pod-1",
  title: "My Podcast",
  description: "",
  feedUrl: "https://example.com/feed",
  episodes,
  visibleCount: 20,
  ...extra
});

const savedEntry = {
  id: "pod-1",
  feedUrl: "https://example.com/feed",
  episodeStates: [
    { id: "1", status: "downloaded" as const },
    { id: "2", status: "skipped" as const },
    { id: "3", status: "downloading" as const }
  ]
};

describe("mergeFeedEpisodes", () => {
  it("keeps the status and the download path of known episodes", () => {
    const current = podcast([
      episode("1", { status: "downloaded", downloadPath: "/music/1.mp3" }),
      episode("2", { status: "skipped" })
    ]);
    const { episodes } = mergeFeedEpisodes(current, feed(["1", "2", "3"]));

    expect(episodes.map((item) => [item.id, item.status])).toEqual([
      ["3", "none"],
      ["2", "skipped"],
      ["1", "downloaded"]
    ]);
    expect(episodes.find((item) => item.id === "1")?.downloadPath).toBe("/music/1.mp3");
  });

  it("keeps episodes that are not in the feed page", () => {
    const current = podcast([episode("1", { status: "downloaded" })]);
    const { episodes } = mergeFeedEpisodes(current, feed(["2"]));
    expect(episodes.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("applies pending statuses and removes them from the pending list", () => {
    const current = podcast([], {
      pendingStates: [
        { id: "1", status: "downloaded" },
        { id: "9", status: "skipped" }
      ]
    });
    const merged = mergeFeedEpisodes(current, feed(["1", "2"]));
    expect(merged.episodes.find((item) => item.id === "1")?.status).toBe("downloaded");
    expect(merged.pendingStates).toEqual([{ id: "9", status: "skipped" }]);
  });
});

describe("podcastFromSavedState", () => {
  it("restores episodes from the cache without the network", () => {
    const cached = podcast([
      episode("1", { downloadPath: "/music/1.mp3" }),
      episode("2"),
      episode("3")
    ]);
    const restored = podcastFromSavedState(savedEntry, cached);

    expect(restored.title).toBe("My Podcast");
    expect(restored.episodes.map((item) => [item.id, item.status])).toEqual([
      ["3", "none"], // An interrupted download is not a downloaded episode.
      ["2", "skipped"],
      ["1", "downloaded"]
    ]);
    expect(restored.episodes.find((item) => item.id === "1")?.downloadPath).toBe(
      "/music/1.mp3"
    );
    expect(restored.pendingStates).toEqual([]);
  });

  it("does not lose statuses when the feed cannot be loaded", () => {
    // No cache and no network: the podcast is a placeholder.
    const restored = podcastFromSavedState(savedEntry);
    expect(restored.episodes).toEqual([]);
    expect(restored.title).toBe("example.com");

    // The next save must contain the same statuses.
    const saved = buildPersistedState([restored], "pod-1", "/music");
    expect(isPersistedState(saved)).toBe(true);
    expect(saved.podcasts[0].episodeStates).toEqual([
      { id: "1", status: "downloaded" },
      { id: "2", status: "skipped" },
      { id: "3", status: "none" }
    ]);
  });

  it("applies the saved statuses when the feed arrives later", () => {
    const restored = podcastFromSavedState(savedEntry);
    const loaded = withFeed(restored, feed(["1", "2", "4"], { title: "Loaded" }));

    expect(loaded.title).toBe("Loaded");
    expect(loaded.episodes.map((item) => [item.id, item.status])).toEqual([
      ["4", "none"],
      ["2", "skipped"],
      ["1", "downloaded"]
    ]);
    // Episode 3 is on a later feed page. Its status stays pending.
    expect(loaded.pendingStates).toEqual([{ id: "3", status: "none" }]);
  });
});

describe("download paths", () => {
  it("survive a save and a restart, also without the cache", () => {
    const before = podcast([
      episode("1", { status: "downloaded", downloadPath: "/music/1.mp3" }),
      episode("2")
    ]);
    const saved = buildPersistedState([before], "pod-1", "/music");
    expect(isPersistedState(JSON.parse(JSON.stringify(saved)))).toBe(true);

    const restored = withFeed(podcastFromSavedState(saved.podcasts[0]), feed(["1", "2"]));
    const first = restored.episodes.find((item) => item.id === "1");
    expect(first?.status).toBe("downloaded");
    expect(first?.downloadPath).toBe("/music/1.mp3");
  });
});

describe("withFeed", () => {
  it("keeps the next page URL when the feed has none", () => {
    const current = podcast([], { nextUrl: "https://example.com/feed?page=2" });
    expect(withFeed(current, feed(["1"])).nextUrl).toBe("https://example.com/feed?page=2");
  });
});

describe("buildEpisodeFilename", () => {
  it("is stable and different for each episode", () => {
    const first = buildEpisodeFilename("pod-1", "1", "Hello: World?", ".mp3");
    expect(first).toBe(buildEpisodeFilename("pod-1", "1", "Hello: World?", ".mp3"));
    expect(first).toMatch(/^Hello-World-[a-z0-9]{7}\.mp3$/);
    expect(first).not.toBe(buildEpisodeFilename("pod-1", "2", "Hello: World?", ".mp3"));
  });

  it("gives different names to episodes with the same title and similar IDs", () => {
    // Titles without ASCII characters all become "episode".
    const names = new Set(
      Array.from({ length: 200 }, (_, index) =>
        buildEpisodeFilename("pod-1", `https://example.com/feed::post-${1000 + index}`, "פרק", ".mp3")
      )
    );
    expect(names.size).toBe(200);
  });
});
