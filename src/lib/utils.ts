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

export const stripHtml = (value: string): string => {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

export const buildEpisodeId = (
  feedUrl: string,
  guid?: string,
  link?: string,
  title?: string,
  pubDate?: string,
  fallbackKey?: string
): string => {
  const seed = guid || link || [title, pubDate, fallbackKey].filter(Boolean).join("-");
  const basis = seed || `${feedUrl}-item-${fallbackKey ?? "0"}`;
  return `${feedUrl}::${basis}`;
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
