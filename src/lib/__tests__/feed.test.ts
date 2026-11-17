import { describe, expect, it } from "vitest";
import { parseFeed } from "../feed";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Sample Cast</title>
    <description>A sample RSS feed</description>
    <link>https://example.com</link>
    <image>
      <url>https://example.com/image.png</url>
    </image>
    <item>
      <title>Episode One</title>
      <guid>ep-1</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <description>First episode</description>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" />
      <itunes:duration>42:10</itunes:duration>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Cast</title>
  <subtitle>A sample Atom feed</subtitle>
  <link rel="alternate" href="https://atom.example.com" />
  <link rel="next" href="https://atom.example.com/page2" />
  <entry>
    <id>tag:example.com,2024:1</id>
    <title>Entry One</title>
    <summary>Summary text</summary>
    <published>2024-01-02T00:00:00Z</published>
    <link rel="enclosure" href="https://example.com/atom1.mp3" type="audio/mpeg" />
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS feeds", () => {
    const parsed = parseFeed(RSS_SAMPLE, "https://example.com/rss");
    expect(parsed.title).toBe("Sample Cast");
    expect(parsed.episodes).toHaveLength(1);
    expect(parsed.episodes[0].title).toBe("Episode One");
    expect(parsed.episodes[0].audioUrl).toBe("https://example.com/ep1.mp3");
    expect(parsed.imageUrl).toBe("https://example.com/image.png");
  });

  it("parses Atom feeds", () => {
    const parsed = parseFeed(ATOM_SAMPLE, "https://atom.example.com/feed");
    expect(parsed.title).toBe("Atom Cast");
    expect(parsed.episodes).toHaveLength(1);
    expect(parsed.episodes[0].title).toBe("Entry One");
    expect(parsed.episodes[0].audioUrl).toBe("https://example.com/atom1.mp3");
    expect(parsed.nextUrl).toBe("https://atom.example.com/page2");
  });
});

describe("episode IDs", () => {
  const feedWith = (items: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
  const item = (n: number) =>
    `<item><title>Episode ${n}</title><enclosure url="https://example.com/${n}.mp3" /></item>`;

  it("do not change when a new episode is added to a feed without GUIDs", () => {
    const before = parseFeed(feedWith(item(1) + item(2)), "https://example.com/rss");
    const after = parseFeed(feedWith(item(3) + item(1) + item(2)), "https://example.com/rss");
    const idsBefore = before.episodes.map((episode) => episode.id);
    const idsAfter = after.episodes.map((episode) => episode.id);
    expect(idsAfter.slice(1)).toEqual(idsBefore);
    expect(new Set(idsAfter).size).toBe(3);
  });
});

describe("descriptions", () => {
  const feedWithDescription = (description: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>E</title><guid>1</guid><description>${description}</description></item>
    </channel></rss>`;

  it("remove tags and decode entities", () => {
    const parsed = parseFeed(
      feedWithDescription("<![CDATA[<p>Tom&nbsp;&amp; Jerry&#39;s</p><p>show &#x263A;</p>]]>"),
      "https://example.com/rss"
    );
    expect(parsed.episodes[0].description).toBe("Tom & Jerry's show ☺");
  });

  it("are shortened when they are very long", () => {
    const parsed = parseFeed(
      feedWithDescription("word ".repeat(1000)),
      "https://example.com/rss"
    );
    expect(parsed.episodes[0].description.length).toBeLessThanOrEqual(601);
    expect(parsed.episodes[0].description.endsWith("…")).toBe(true);
  });
});

describe("parseFeedAsync", () => {
  it("gives the same result as parseFeed for a large feed", async () => {
    const items = Array.from(
      { length: 120 },
      (_, n) => `<item><title>Episode ${n}</title><guid>g-${n}</guid></item>`
    ).join("");
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`;
    const { parseFeedAsync } = await import("../feed");
    expect(await parseFeedAsync(xml, "https://example.com/rss")).toEqual(
      parseFeed(xml, "https://example.com/rss")
    );
  });
});
