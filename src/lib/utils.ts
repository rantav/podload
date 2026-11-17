export const DEFAULT_PAGE_SIZE = 20;

export const ensureHttpUrl = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const resolveUrl = (baseUrl: string, href?: string | null): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”"
};

/** Decodes HTML entities such as `&amp;`, `&#39;` and `&#x27;`. */
export const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const isHex = code[1].toLowerCase() === "x";
      const point = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });

/** Returns plain text. The result is text, not HTML: show it only as text. */
export const stripHtml = (value: string): string => {
  if (!value) return "";
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
};

export const formatDate = (value?: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric"
  });
};

export const formatDuration = (value?: string): string => {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const totalSeconds = Number(trimmed);
    if (Number.isNaN(totalSeconds)) return "";
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const parts = [hours, minutes, seconds]
      .filter((part, index) => index > 0 || part > 0)
      .map((part) => String(part).padStart(2, "0"));
    return parts.join(":");
  }
  const parts = trimmed.split(":").map((part) => part.trim());
  if (parts.length === 2) {
    return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
  }
  if (parts.length === 3) {
    return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}:${parts[2].padStart(2, "0")}`;
  }
  return trimmed;
};

export const sanitizeFilename = (value: string): string => {
  const trimmed = value.trim() || "episode";
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120) || "episode";
};

/**
 * Builds an ID that stays the same when the feed changes. The position in the
 * feed is the last resort, because it moves when a new episode is added.
 */
export const buildEpisodeId = (
  feedUrl: string,
  source: {
    guid?: string;
    link?: string;
    audioUrl?: string;
    title?: string;
    pubDate?: string;
  },
  index: number
): string => {
  const seed =
    source.guid ||
    source.link ||
    source.audioUrl ||
    [source.title, source.pubDate].filter(Boolean).join("-") ||
    `item-${index}`;
  return `${feedUrl}::${seed}`;
};

export const guessExtension = (url?: string, fallback = ".mp3"): string => {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const last = path.split("/").pop();
    if (!last || !last.includes(".")) return fallback;
    const ext = `.${last.split(".").pop()}`;
    return ext.length <= 6 ? ext : fallback;
  } catch {
    return fallback;
  }
};

export const shortenUrl = (value?: string): string => {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
};
