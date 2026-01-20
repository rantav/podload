export type EpisodeStatus = "none" | "downloading" | "downloaded" | "skipped" | "error";

export type Episode = {
  id: string;
  title: string;
  description: string;
  pubDate?: string;
  duration?: string;
  audioUrl?: string;
  status: EpisodeStatus;
  downloadPath?: string;
};

export type Podcast = {
  id: string;
  title: string;
  description: string;
  imageUrl?: string;
  siteUrl?: string;
  feedUrl: string;
  episodes: Episode[];
  nextUrl?: string;
  visibleCount: number;
};

export type ParsedFeed = {
  title: string;
  description: string;
  imageUrl?: string;
  siteUrl?: string;
  feedUrl: string;
  episodes: Omit<Episode, "status">[];
  nextUrl?: string;
};

export type StoredState = {
  podcasts: Podcast[];
  activePodcastId?: string | null;
  downloadDir?: string;
};
