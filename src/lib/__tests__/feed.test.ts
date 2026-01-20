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
