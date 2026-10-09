"use strict";

const entry = {
  title: "Fixture entry",
  link: "https://example.invalid/article",
  contentSnippet: "Local fixture",
  guid: "fixture-1",
  isoDate: "2026-01-01T00:00:00Z",
};
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://example.invalid/</link><description>Offline feed</description><item><title>${entry.title}</title><link>${entry.link}</link><guid>${entry.guid}</guid><description>${entry.contentSnippet}</description><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture</title><id>fixture</id><updated>${entry.isoDate}</updated><entry><id>${entry.guid}</id><title>${entry.title}</title><link href="${entry.link}"/><summary>${entry.contentSnippet}</summary><updated>${entry.isoDate}</updated></entry></feed>`;
const json = {
  version: "https://jsonfeed.org/version/1.1",
  title: "Fixture",
  items: [
    {
      id: entry.guid,
      title: entry.title,
      url: entry.link,
      content_text: entry.contentSnippet,
      date_published: entry.isoDate,
    },
  ],
};
const youtube = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><title>Fixture</title><entry><id>yt:video:fixture</id><yt:videoId>fixture</yt:videoId><title>${entry.title}</title><link href="https://www.youtube.com/watch?v=fixture"/><published>${entry.isoDate}</published><author><name>Fixture author</name></author><media:group><media:description>Local fixture</media:description><media:thumbnail url="https://example.invalid/thumb.jpg"/></media:group></entry></feed>`;
const discord = [
  {
    id: "message-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    content: "Fixture entry",
    timestamp: entry.isoDate,
    author: { id: "author-1", username: "Fixture author" },
    attachments: [
      { url: "https://example.invalid/image.png", content_type: "image/png" },
    ],
  },
];

module.exports = { entry, rss, atom, json, youtube, discord };
