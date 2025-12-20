// src/workshop/cs2-blog-watcher.plugin.js
// Counter-Strike 2 Blog Post Watcher Plugin
// Runs independently (setInterval), outside XFeeder queue.
// 
// Logic:
// - GET categories?post={id}, if text contains "rest_forbidden_context" → exists
// - GET posts/{id}, if text contains "rest_forbidden" → NEW, otherwise UPDATED
// - Sends Components V2 notification to Discord webhook

"use strict";

const axios = require("axios");

// API endpoints and detection strings
const BLOG_URL = "https://blog.counter-strike.net/index.php/wp-json/wp/v2/categories?post=";
const VALID_STRING = "rest_forbidden_context";
const NEW_POST_URL = "https://blog.counter-strike.net/wp-json/wp/v2/posts/";
const NEW_BLOG_STRING = "rest_forbidden";

// HTTP options - don't throw on 401/400 (like Python requests)
const HTTP_OPTS = {
  validateStatus: () => true,
  headers: {
    Accept: "application/json,*/*",
    "User-Agent": "Mozilla/5.0 (XFeeder-CS2-Blog-Plugin)"
  },
  timeout: 15000
};

// Configuration (can be overridden in config.json)
let CURRENT_INDEX = 41413;
let SLEEP_TIME = 5; // seconds
let WEBHOOK_URL = "";
let THREAD_ID = "";

let TIMER = null;
let RUNNING = false;

module.exports = {
  id: "cs2-blog-watcher",
  enabled: true,

  init(api) {
    // Read settings from Workshop.Plugins.cs2-blog-watcher or root config
    const p = api?.config?.Workshop?.Plugins?.["cs2-blog-watcher"] || {};
    CURRENT_INDEX = toInt(p.start_index) ?? toInt(api?.config?.start_index) ?? CURRENT_INDEX;
    SLEEP_TIME = toInt(p.sleep_time) ?? toInt(api?.config?.sleep_time) ?? SLEEP_TIME;
    WEBHOOK_URL = p.webhook_url || api?.config?.webhook_url || WEBHOOK_URL;
    THREAD_ID = p.thread_id || api?.config?.thread_id || THREAD_ID;

    if (!WEBHOOK_URL) {
      console.error("[cs2-blog-watcher] Missing webhook_url in Workshop.Plugins.cs2-blog-watcher.webhook_url (or root).");
      return;
    }

    console.log("Welcome to CS2 Blog Checker");
    console.log("Credits: @aquaismissing on Twitter");
    console.log(`Starting with blog number ${CURRENT_INDEX}, will keep checking for new posts.`);
    console.log(`Check interval: ${SLEEP_TIME} seconds`);
    console.log("");

    // Start immediately and set interval
    tick().catch(() => {});
    TIMER = setInterval(() => tick().catch(() => {}), Math.max(1000, SLEEP_TIME * 1000));
  }
};

/**
 * Converts value to integer, returns undefined if invalid
 */
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Main check loop - direct port of original Python logic
 */
async function tick() {
  if (RUNNING) return;
  RUNNING = true;

  try {
    const req = await axios.get(BLOG_URL + String(CURRENT_INDEX), HTTP_OPTS);
    const body1 = asText(req.data);

    if (body1.includes(VALID_STRING)) {
      // Post exists: check if NEW or UPDATED
      console.log("!!----------" + tzName() + " Time------------!!");

      const reqNew = await axios.get(NEW_POST_URL + String(CURRENT_INDEX), HTTP_OPTS);
      const body2 = asText(reqNew.data);

      const isNew = body2.includes(NEW_BLOG_STRING);
      if (isNew) {
        console.log(`NEW CS2 Blog Post! ID: ${CURRENT_INDEX}`);
      } else {
        console.log(`CS2 Blog Post Updated! ID: ${CURRENT_INDEX}`);
      }

      console.log(`Time: ${nowFormatted()}`);
      console.log("----------------------");
      console.log("");

      // Send Components V2 notification
      const postLink = `https://blog.counter-strike.net/index.php/${CURRENT_INDEX}/`;
      await sendComponentsV2(WEBHOOK_URL, THREAD_ID, CURRENT_INDEX, isNew, postLink);

      // Beep 5 times (0.5s intervals)
      beep();

      // Increment after finding post
      CURRENT_INDEX = CURRENT_INDEX + 1;
    } else {
      console.log("No new post found, checking...");
      console.log(body1.substring(0, 100) + "...");
    }
  } catch (e) {
    console.log("❌ Tick error:", e?.message || e);
  } finally {
    RUNNING = false;
  }
}

/**
 * Sends Components V2 notification to Discord webhook
 */
async function sendComponentsV2(webhookUrl, threadId, postId, isNew, link) {
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    console.error("❌ Invalid webhook_url:", webhookUrl);
    return;
  }
  
  url.searchParams.set("with_components", "true");
  url.searchParams.set("wait", "true");
  if (threadId) url.searchParams.set("thread_id", threadId);

  const title = isNew
    ? `🆕 NEW CS2 Blog Post! ID: ${postId}`
    : `📝 CS2 Blog Post Updated! ID: ${postId}`;

  const container = { type: 17, components: [] };
  container.components.push({ type: 10, content: title });
  container.components.push({ type: 10, content: `🕒 Time: ${nowFormatted()}` });
  container.components.push({
    type: 1,
    components: [{ type: 2, style: 5, label: "Open Post", url: link }]
  });

  const payload = {
    username: "CS2 Blog Watcher",
    avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
    flags: 1 << 15,
    components: [container]
  };

  try {
    const res = await axios.post(url.toString(), payload, {
      headers: { "Content-Type": "application/json" }
    });
    if (res.status === 200 || res.status === 204) {
      console.log("✅ Discord notification sent!");
    } else {
      console.log(`❌ Discord error: ${res.status} | ${asText(res.data)}`);
    }
  } catch (e) {
    console.log(`❌ Discord send error: ${e?.response?.status || ""}`, asText(e?.response?.data) || e?.message);
  }
}

/**
 * System beep 5 times with 0.5s interval
 */
function beep() {
  for (let i = 0; i < 5; i++) {
    setTimeout(() => process.stdout.write("\x07"), i * 500);
  }
}

// Utility functions

/**
 * Converts data to string
 */
function asText(d) {
  if (typeof d === "string") return d;
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

/**
 * Returns formatted current date/time
 */
function nowFormatted() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Returns timezone name
 */
function tzName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    return "Local";
  }
}