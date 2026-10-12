"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseXML } = require("../src/parsers/xml");
const { parseRSS } = require("../src/parsers/rss");
const { parseAtom } = require("../src/parsers/atom");
const { parseJSON } = require("../src/parsers/json");
const { parseYouTube } = require("../src/parsers/youtube");
const { parseDate } = require("../src/parsers/utils");
const { detectFeedFormat } = require("../src/extensions/Scrapling/utils");

const baseUrl = "https://feeds.example.invalid/";
const youtubeUrl = "https://www.youtube.com/feeds/videos.xml?channel_id=fixture-channel";
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures/feed-pipeline", name), "utf8");

async function parseFixture(parser, name, url = `${baseUrl}${name}`) {
  const body = fixture(name);
  let requests = 0;
  const items = await parser(url, {
    async get(requestedUrl) {
      assert.equal(requestedUrl, url);
      requests++;
      return { status: 200, data: name.endsWith(".json") ? JSON.parse(body) : body };
    },
  });
  assert.equal(requests, 1, "The injected client serves the fixture without provider access");
  return items;
}

const expectedRss = [
  {
    title: "First RSS article", link: `${baseUrl}articles/first`,
    contentSnippet: "Full article text.", isoDate: "2026-01-01T10:30:00.000Z",
    enclosure: `${baseUrl}media/first.png`, author: "Fixture author",
    guid: "rss-first", categories: ["news", "testing"],
  },
  {
    title: "Second RSS article", link: `${baseUrl}articles/second`,
    contentSnippet: "Second article text.", isoDate: "2026-01-02T10:00:00.000Z",
    enclosure: `${baseUrl}media/inline.png`, author: null,
    guid: `${baseUrl}articles/second`, categories: [],
  },
];

test("RSS 2.0 XML parsing preserves content, GUID, author, images, categories and timezone", async () => {
  assert.deepEqual(await parseFixture(parseXML, "rss.xml"), expectedRss);
});

test("RSS regex fallback preserves entries with its existing category and missing-author defaults", async () => {
  const expected = expectedRss.map((entry) => ({ ...entry, author: entry.author || "", categories: [] }));
  assert.deepEqual(await parseFixture(parseRSS, "rss.xml"), expected);
});

test("Atom selects the alternate link, updated date, enclosure and entry or feed author", async () => {
  assert.deepEqual(await parseFixture(parseAtom, "atom.xml"), [
    {
      title: "First Atom article", link: `${baseUrl}articles/atom-first`,
      contentSnippet: "Atom summary.", isoDate: "2026-01-02T10:00:00.000Z",
      enclosure: `${baseUrl}media/atom.png`, author: "Entry author",
      guid: "urn:fixture:atom:first", categories: [{ ATTR: { term: "updates" } }],
    },
    {
      title: "Second Atom article", link: `${baseUrl}articles/atom-second`,
      contentSnippet: "Atom content.", isoDate: "2026-01-02T12:00:00.000Z",
      enclosure: null, author: "Feed author", guid: "urn:fixture:atom:second", categories: [],
    },
  ]);
});

test("JSON Feed preserves text precedence, URL aliases, tags and author or image fallbacks", async () => {
  assert.deepEqual(await parseFixture(parseJSON, "json-feed.json"), [
    {
      title: "First JSON article", link: `${baseUrl}articles/json-first`,
      contentSnippet: "First JSON article text.", isoDate: "2026-01-01T08:30:00.000Z",
      enclosure: `${baseUrl}media/json-first.png`, author: "Entry author",
      guid: "json-first", categories: ["news", "testing"],
    },
    {
      title: "Second JSON article", link: `${baseUrl}articles/json-second`,
      contentSnippet: "Second JSON article.", isoDate: "2026-01-02T12:00:00.000Z",
      enclosure: `${baseUrl}media/json-banner.png`, author: "Feed author",
      guid: "json-second", categories: [],
    },
  ]);
});

test("YouTube preserves published dates and builds missing video links and thumbnails locally", async () => {
  assert.deepEqual(await parseFixture(parseYouTube, "youtube.xml", youtubeUrl), [
    {
      title: "First fixture video", link: "https://www.youtube.com/watch?v=fixture-one",
      contentSnippet: "First fixture video description.", isoDate: "2026-01-01T10:30:00.000Z",
      enclosure: `${baseUrl}media/video-large.jpg`, author: "Fixture channel",
      guid: "yt:video:fixture-one", categories: [],
    },
    {
      title: "Second fixture video", link: "https://www.youtube.com/watch?v=fixture-two",
      contentSnippet: "Second video summary.", isoDate: "2026-01-02T12:00:00.000Z",
      enclosure: "https://i.ytimg.com/vi/fixture-two/maxresdefault.jpg", author: "Unknown author",
      guid: "yt:video:fixture-two", categories: [],
    },
  ]);
});

test("Atom and YouTube skip URLs outside their current parser responsibility without a request", async () => {
  let requests = 0;
  const client = { async get() { requests++; return { data: "" }; } };
  assert.deepEqual(await parseAtom(youtubeUrl, client), []);
  assert.deepEqual(await parseYouTube(`${baseUrl}atom.xml`, client), []);
  assert.equal(requests, 0, "Excluded URLs must not call the client");
});

for (const name of ["invalid.xml", "empty.xml", "html.html"]) {
  test(`${name}: XML, RSS and Atom parsers do not manufacture entries`, async () => {
    for (const parser of [parseXML, parseRSS, parseAtom]) {
      assert.deepEqual(await parseFixture(parser, name), [], parser.name);
    }
    assert.deepEqual(await parseFixture(parseYouTube, name, youtubeUrl), []);
  });
}

test("JSON parser returns no entries for empty, unsupported or undecoded response bodies", async () => {
  for (const data of [null, "", {}, [], { items: [] }, { version: "1.1", items: [] },
    fixture("json-feed.json"), fixture("html.html")]) {
    assert.deepEqual(await parseJSON(`${baseUrl}feed.json`, { async get() { return { data }; } }), []);
  }
});

test("malformed RSS dates remain null without discarding a valid sibling entry", async () => {
  for (const parser of [parseXML, parseRSS]) {
    const entries = await parseFixture(parser, "malformed-dates.xml");
    assert.deepEqual(entries.map(({ title, isoDate }) => ({ title, isoDate })), [
      { title: "Invalid date", isoDate: null },
      { title: "Valid date", isoDate: "2026-01-01T10:30:00.000Z" },
    ]);
  }
});

test("shared date parsing supports RFC, ISO, Date and Unix timestamps with null for invalid input", () => {
  const iso = "2026-01-01T10:30:00.000Z";
  const timestamp = Date.parse(iso);
  for (const input of [iso, "Thu, 01 Jan 2026 10:30:00 GMT", "2026-01-01T12:30:00+02:00",
    new Date(iso), timestamp, timestamp / 1000]) {
    assert.equal(parseDate(input), iso);
  }
  for (const input of [null, undefined, "", "definitely-not-a-date", new Date(NaN), {}, false]) {
    assert.equal(parseDate(input), null);
  }
});

test("format detection classifies fixtures and does not claim malformed XML has been validated", () => {
  for (const [name, format] of [
    ["rss.xml", "rss"], ["atom.xml", "atom"], ["youtube.xml", "atom"],
    ["json-feed.json", "json"], ["html.html", "html"],
    ["empty.xml", "rss"], ["invalid.xml", "rss"],
  ]) {
    assert.equal(detectFeedFormat(fixture(name)), format, name);
  }
  for (const body of [null, undefined, "", "  ", "ordinary text"]) {
    assert.equal(detectFeedFormat(body), "unknown");
  }
  assert.equal(detectFeedFormat(" \n []"), "json");
  assert.equal(detectFeedFormat("<RSS><CHANNEL/></RSS>"), "rss");
});
