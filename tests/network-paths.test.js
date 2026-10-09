"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const {
  config,
  offline,
  serve,
  readBody,
  holdDelay,
  mockScraplingDetector,
} = require("./fixtures/network.cjs");
const feeds = require("./fixtures/feeds.cjs");
const {
  getWithFallback,
  postWithFallback,
  getHttpClient,
} = require("../src/client");
const { download } = require("../src/parsers/downloader");
const { createFeedPipeline } = require("../src/core/feed-pipeline");
const { parseRSS } = require("../src/parsers/rss");
const { parseAtom } = require("../src/parsers/atom");
const { parseJSON } = require("../src/parsers/json");
const { parseYouTube } = require("../src/parsers/youtube");
const { parseDiscord } = require("../src/parsers/discord");
const { sendMessage } = require("../src/message");
const { sendTelegramMessage } = require("../src/telegram");

beforeEach((t) => {
  offline(t);
  mockScraplingDetector(t);
});
const bounded = { timeout: 10000 };

for (const [format, parser, type] of [
  ["rss", parseRSS, "application/rss+xml"],
  ["atom", parseAtom, "application/atom+xml"],
  ["json", parseJSON, "application/feed+json"],
  ["youtube", parseYouTube, "application/atom+xml"],
]) {
  test(
    `${format}: pipeline downloads once across parser attempts and replays cached 304`,
    bounded,
    async (t) => {
      const lastModified = "Thu, 01 Jan 2026 00:00:00 GMT";
      const server = await serve(t, (req, res) => {
        if (req.headers["if-none-match"] === '"fixture-v1"') {
          res.writeHead(304);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": type,
          ETag: '"fixture-v1"',
          "Last-Modified": lastModified,
        });
        res.end(
          typeof feeds[format] === "string"
            ? feeds[format]
            : JSON.stringify(feeds[format]),
        );
      });
      let snapshot;
      let parserCalls = 0;
      let parserResult;
      let saves = 0;
      const pipeline = createFeedPipeline({
        config,
        download,
        getWithFallback,
        postWithFallback,
        getFeedValidator: () => snapshot?.validator,
        getFeedItems: () => snapshot?.items || [],
        setFeedSnapshot: (_url, validator, items) => {
          snapshot = { validator, items };
          saves++;
        },
        builtInParsers: [
          async (url, client) => {
            parserCalls++;
            await client.get(url);
            return [];
          },
          async (url, client) => {
            parserCalls++;
            parserResult = await parser(url, client);
            return parserResult;
          },
        ],
      });
      const url = `${server.url}/${format}`;
      const items = await pipeline.fetchFeed(url);
      assert.deepEqual(
        items,
        parserResult,
        "The selected parser must succeed without falling through to another parser",
      );
      assert.equal(items.length, 1);
      assert.equal(items[0].title, feeds.entry.title);
      assert.equal(
        items[0].guid,
        format === "youtube" ? "yt:video:fixture" : feeds.entry.guid,
      );
      assert.equal(
        server.requests.length,
        1,
        "Parser attempts must reuse the download",
      );
      assert.equal(parserCalls, 2);
      assert.deepEqual(await pipeline.fetchFeed(url), items);
      assert.equal(server.requests.length, 2);
      assert.equal(server.requests[1].headers["if-none-match"], '"fixture-v1"');
      assert.equal(
        server.requests[1].headers["if-modified-since"],
        lastModified,
      );
      assert.equal(parserCalls, 2, "304 must not invoke parsers");
      assert.equal(saves, 1, "304 must not replace the cached snapshot");
    },
  );
}

test(
  "downloader preserves structured 403 failure with Scrapling disabled",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    const result = await download(server.url, { config });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "HTTP_ERROR");
    assert.equal(result.status, 403);
    assert.equal(result.data, "forbidden");
    assert.equal(server.requests.length, 1);
  },
);

test(
  "downloader propagates a pre-aborted signal without network access",
  bounded,
  async (t) => {
    const server = await serve(t, (_req, res) => res.end(feeds.rss));
    await assert.rejects(download(server.url, {
      config,
      signal: AbortSignal.abort(),
    }), { name: "AbortError" });
    assert.equal(server.requests.length, 0);
  },
);

test(
  "Discord source uses configured headers and returns other channels after a failure",
  bounded,
  async (t) => {
    const server = await serve(t, (req, res) => {
      const failed = req.url.includes("/failed/");
      res.writeHead(failed ? 503 : 200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(failed ? { message: "unavailable" } : feeds.discord),
      );
    });
    const client = getHttpClient("unused", config);
    const requested = [];
    const items = await parseDiscord(
      {
        Token: "fixture-token",
        ChannelIDs: ["failed", "channel-1"],
        GuildID: "guild-1",
        Limit: 2,
        Timeout: 1234,
      },
      {
        get(url, options) {
          requested.push(url);
          assert.equal(new URL(url).origin, "https://discord.com");
          assert.equal(options.timeout, 1234);
          return client.get(
            `${server.url}${new URL(url).pathname}${new URL(url).search}`,
            { ...options, proxy: false },
          );
        },
      },
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].guid, "message-1");
    assert.equal(items[0].enclosure, "https://example.invalid/image.png");
    assert.deepEqual(
      requested.map((url) => new URL(url).pathname),
      [
        "/api/v9/channels/failed/messages",
        "/api/v9/channels/channel-1/messages",
      ],
    );
    assert.equal(
      server.requests.length,
      2,
      "Discord source currently has no shared GET retry",
    );
    assert.equal(server.requests[1].headers.authorization, "fixture-token");
    assert.equal(
      new URL(server.requests[1].url, server.url).searchParams.get("limit"),
      "2",
    );
  },
);

test(
  "Discord delivery serializes Components V2 and retries identical payload after 429",
  bounded,
  async (t) => {
    const delay = holdDelay(t, 2000);
    const bodies = [];
    const server = await serve(t, async (req, res) => {
      bodies.push(JSON.parse((await readBody(req)).toString()));
      res.writeHead(bodies.length === 1 ? 429 : 204, {
        "Content-Type": "application/json",
        "Retry-After": "2",
      });
      res.end(
        bodies.length === 1
          ? JSON.stringify({ message: "rate limited" })
          : undefined,
      );
    });
    const pending = sendMessage(
      `${server.url}/webhook`,
      "thread-1",
      feeds.entry,
    );
    await delay.scheduled;
    assert.equal(server.requests.length, 1);
    delay.release();
    await pending;
    assert.equal(server.requests.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].flags, 1 << 15);
    assert.equal(bodies[0].components[0].type, 17);
    const url = new URL(server.requests[0].url, server.url);
    assert.equal(url.searchParams.get("with_components"), "true");
    assert.equal(url.searchParams.get("thread_id"), "thread-1");
  },
);

test("Discord delivery does not retry 5xx", bounded, async (t) => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await assert.rejects(
    sendMessage(server.url, null, feeds.entry),
    (error) => error.response.status === 503,
  );
  assert.equal(server.requests.length, 1);
});

test(
  "Telegram sends JSON with target/thread options through its existing direct Axios path",
  bounded,
  async (t) => {
    let body;
    const server = await serve(t, async (req, res) => {
      body = JSON.parse((await readBody(req)).toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 17 } }));
    });
    const post = axios.post.bind(axios);
    t.mock.method(axios, "post", (url, payload, options) => {
      assert.equal(
        url,
        "https://api.telegram.org/botfixture-token/sendMessage",
      );
      assert.equal(options.timeout, 1234);
      return post(server.url, payload, { ...options, proxy: false });
    });
    const result = await sendTelegramMessage(
      {
        BotToken: "fixture-token",
        ChatID: "chat-1",
        MessageThreadID: 5,
        DisableWebPagePreview: true,
        TimeoutMs: 1234,
      },
      feeds.entry,
    );
    assert.deepEqual(result, { message_id: 17 });
    assert.equal(body.chat_id, "chat-1");
    assert.equal(body.message_thread_id, 5);
    assert.equal(body.parse_mode, "HTML");
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.match(body.text, /Fixture entry/);
    assert.equal(server.requests.length, 1);
  },
);

for (const status of [200, 429, 503]) {
  test(
    `Telegram surfaces API errors at HTTP ${status} without retry`,
    bounded,
    async (t) => {
      const server = await serve(t, (_req, res) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Retry-After": "2",
        });
        res.end(
          JSON.stringify({ ok: false, description: "fixture rejection" }),
        );
      });
      const post = axios.post.bind(axios);
      t.mock.method(axios, "post", (url, payload, options) => {
        assert.equal(
          url,
          "https://api.telegram.org/botfixture-token/sendMessage",
        );
        return post(server.url, payload, { ...options, proxy: false });
      });
      await assert.rejects(
        sendTelegramMessage(
          { BotToken: "fixture-token", ChatID: "chat-1" },
          feeds.entry,
        ),
        /Telegram API error: fixture rejection/,
      );
      assert.equal(server.requests.length, 1);
    },
  );
}
