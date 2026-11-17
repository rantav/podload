import { safeFetch } from "./http";
import { buildEpisodeId, ensureHttpUrl, resolveUrl, shortenUrl, stripHtml } from "./utils";
import type { ParsedFeed } from "./types";

const FEED_MIME_RE = /(rss|atom|xml)/i;

const getText = (scope: ParentNode, selector: string): string | undefined => {
  const node = scope.querySelector(selector);
  return node?.textContent?.trim() || undefined;
};

const getAttr = (scope: ParentNode, selector: string, attr: string): string | undefined => {
  const node = scope.querySelector(selector);
  const value = node?.getAttribute(attr);
  return value?.trim() || undefined;
};

const findNextLink = (doc: Document): string | undefined => {
  const candidates = Array.from(doc.querySelectorAll("link[rel='next'], atom\\:link[rel='next']"));
  for (const link of candidates) {
    const href = link.getAttribute("href");
    if (href) return href;
  }
  return undefined;
};

const looksLikeFeed = (doc: Document): boolean => {
  return Boolean(doc.querySelector("rss, feed, rdf\\:RDF"));
};

// The UI shows three lines of the description. A full blog post for each
// episode makes the memory, the cache file and the search much larger.
const MAX_DESCRIPTION_LENGTH = 600;

const shorten = (text: string): string =>
  text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}…`
    : text;

type FeedHead = Omit<ParsedFeed, "episodes"> & { entries: Element[] };

const parseFeedHead = (xml: string, feedUrl: string): FeedHead => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("Invalid RSS/Atom XML");
  }

  const rssChannel = doc.querySelector("rss > channel, channel");
  const atomFeed = doc.querySelector("feed");
  const isAtom = Boolean(atomFeed && !rssChannel);
  const root = rssChannel ?? atomFeed;

  if (!root) {
    throw new Error("Unsupported feed format");
  }

  const title = getText(root, "title") ?? "Untitled Podcast";
  const description = stripHtml(
    getText(root, "description") ?? getText(root, "subtitle") ?? ""
  );

  const imageUrl =
    getAttr(root, "itunes\\:image", "href") ||
    getText(root, "image > url") ||
    getText(root, "logo") ||
    getText(root, "icon") ||
    undefined;

  const siteUrl =
    getAttr(root, "link[rel='alternate']", "href") ||
    getText(root, "link") ||
    undefined;

  const nextUrl = findNextLink(doc);

  return {
    title,
    description,
    imageUrl: imageUrl ? resolveUrl(feedUrl, imageUrl) : undefined,
    siteUrl: siteUrl ? resolveUrl(feedUrl, siteUrl) : undefined,
    feedUrl,
    nextUrl: nextUrl ? resolveUrl(feedUrl, nextUrl) : undefined,
    entries: Array.from(root.querySelectorAll(isAtom ? "entry" : "item"))
  };
};

const parseEntry = (
  entry: Element,
  index: number,
  feedUrl: string
): ParsedFeed["episodes"][number] => {
  const title = getText(entry, "title") ?? "Untitled Episode";
  const description = shorten(
    stripHtml(
      getText(entry, "description") ||
        getText(entry, "summary") ||
        getText(entry, "content") ||
        getText(entry, "itunes\\:summary") ||
        ""
    )
  );

  const guid = getText(entry, "guid") || getText(entry, "id");
  const link =
    getAttr(entry, "link[rel='alternate']", "href") ||
    getText(entry, "link") ||
    getAttr(entry, "link", "href");

  const pubDate =
    getText(entry, "pubDate") ||
    getText(entry, "published") ||
    getText(entry, "updated") ||
    undefined;

  const duration = getText(entry, "itunes\\:duration") || undefined;

  const enclosureUrl =
    getAttr(entry, "enclosure", "url") ||
    getAttr(entry, "link[rel='enclosure']", "href") ||
    getAttr(entry, "media\\:content", "url") ||
    undefined;
  const audioUrl = enclosureUrl ? resolveUrl(feedUrl, enclosureUrl) : undefined;

  return {
    id: buildEpisodeId(feedUrl, { guid, link, audioUrl, title, pubDate }, index),
    title,
    description,
    pubDate,
    duration,
    audioUrl
  };
};

export const parseFeed = (xml: string, feedUrl: string): ParsedFeed => {
  const { entries, ...head } = parseFeedHead(xml, feedUrl);
  return {
    ...head,
    episodes: entries.map((entry, index) => parseEntry(entry, index, feedUrl))
  };
};

const PARSE_CHUNK_SIZE = 25;

/**
 * Same result as `parseFeed`, but it gives control back to the UI between
 * groups of entries. A feed with hundreds of episodes does not freeze the UI.
 */
export const parseFeedAsync = async (xml: string, feedUrl: string): Promise<ParsedFeed> => {
  const { entries, ...head } = parseFeedHead(xml, feedUrl);
  const episodes: ParsedFeed["episodes"] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && index % PARSE_CHUNK_SIZE === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    episodes.push(parseEntry(entries[index], index, feedUrl));
  }
  return { ...head, episodes };
};

const FETCH_TIMEOUT_MS = 45_000;

const fetchText = async (url: string): Promise<string> => {
  // Without a time limit, a server that does not answer blocks the UI state.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await safeFetch(url, {
      method: "GET",
      maxRedirections: 10,
      signal: controller.signal,
      headers: {
        "User-Agent": "Podload/0.1",
        Accept: "application/rss+xml, application/atom+xml, text/xml, application/xml, text/html"
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    return await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`The request timed out (${shortenUrl(url)})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const discoverFeedUrl = async (input: string): Promise<string> => {
  const normalized = ensureHttpUrl(input);
  if (!normalized) throw new Error("Enter a podcast URL");

  const firstText = await fetchText(normalized);
  const parser = new DOMParser();
  const doc = parser.parseFromString(firstText, "text/xml");

  if (looksLikeFeed(doc)) {
    return normalized;
  }

  const htmlDoc = parser.parseFromString(firstText, "text/html");
  const links = Array.from(htmlDoc.querySelectorAll("link[rel~='alternate']"));
  const candidate = links.find((link) => {
    const type = link.getAttribute("type") ?? "";
    return FEED_MIME_RE.test(type);
  });

  const href = candidate?.getAttribute("href");
  if (href) {
    const resolved = resolveUrl(normalized, href);
    if (resolved) return resolved;
  }

  const anchors = Array.from(htmlDoc.querySelectorAll("a[href]"));
  const rssAnchor = anchors.find((anchor) => FEED_MIME_RE.test(anchor.getAttribute("href") ?? ""));
  const anchorHref = rssAnchor?.getAttribute("href");
  if (anchorHref) {
    const resolved = resolveUrl(normalized, anchorHref);
    if (resolved) return resolved;
  }

  throw new Error("Could not find an RSS or Atom feed on that page.");
};

export const fetchFeed = async (feedUrl: string): Promise<ParsedFeed> => {
  const xml = await fetchText(feedUrl);
  return parseFeedAsync(xml, feedUrl);
};
