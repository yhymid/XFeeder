"use strict";

// Port oryginalnego checkera (requests.get + sprawdzanie substringów) → plugin.
// - pętla co sleep_time sekund (setInterval), poza kolejką XFeeder
// - logika 1:1: 
//   * GET categories?post={id}, jeśli tekst zawiera "rest_forbidden_context" → istnieje
//   * GET posts/{id}, jeśli tekst zawiera "rest_forbidden" → NEW, inaczej UPDATED
//   * w przeciwnym wypadku: "failed" + wypisz tekst
// - dodałem wysyłkę Components V2 na webhook
// - bez zapisu cache (jak w oryginalnym kodzie, który pokazałeś)

const axios = require("axios");

const BLOG_URL       = "https://blog.counter-strike.net/index.php/wp-json/wp/v2/categories?post=";
const VALID_STRING   = "rest_forbidden_context";
const NEW_POST_URL   = "https://blog.counter-strike.net/wp-json/wp/v2/posts/";
const NEW_BLOG_STRING= "rest_forbidden";

// requests nie rzucał na 401/400 – ustaw to samo w axios
const HTTP_OPTS = {
  validateStatus: () => true,
  headers: {
    Accept: "application/json,*/*",
    "User-Agent": "Mozilla/5.0 (XFeeder-CS2-Blog-Plugin)"
  },
  timeout: 15000
};

let CURRENT_INDEX = 41413;  // jak w oryginale (możesz nadpisać w configu)
let SLEEP_TIME = 5;         // sekundy (możesz nadpisać w configu)
let WEBHOOK_URL = "";
let THREAD_ID = "";

let TIMER = null;
let RUNNING = false;

module.exports = {
  id: "cs2-blog-watcher",
  enabled: true,

  init(api) {
    // Czytamy ustawienia z Workshop.Plugins.cs2-blog-watcher (lowercase) lub z root (fallback)
    const p = api?.config?.Workshop?.Plugins?.["cs2-blog-watcher"] || {};
    CURRENT_INDEX = toInt(p.start_index) ?? toInt(api?.config?.start_index) ?? CURRENT_INDEX;
    SLEEP_TIME    = toInt(p.sleep_time)  ?? toInt(api?.config?.sleep_time)  ?? SLEEP_TIME;
    WEBHOOK_URL   = p.webhook_url || api?.config?.webhook_url || WEBHOOK_URL;
    THREAD_ID     = p.thread_id   || api?.config?.thread_id   || THREAD_ID;

    if (!WEBHOOK_URL) {
      console.error("[cs2-blog-watcher] Brak webhook_url w Workshop.Plugins.cs2-blog-watcher.webhook_url (lub w root).");
      return;
    }

    console.log("Welcome to my CSGO Blog Checker, thanks to @aquaismissing on twitter");
    console.log("Starts with Blognumber " + String(CURRENT_INDEX) + " and will keep going untill the newest is found.");
    console.log("GET intervall is " + String(SLEEP_TIME) + " seconds");
    console.log("");

    // start natychmiast i interwał co SLEEP_TIME sekund (bokiem)
    tick().catch(()=>{});
    TIMER = setInterval(() => tick().catch(()=>{}), Math.max(1000, SLEEP_TIME * 1000));
  }
};

function toInt(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

// Główna pętla – port 1:1
async function tick() {
  if (RUNNING) return;
  RUNNING = true;

  try {
    const req = await axios.get(BLOG_URL + String(CURRENT_INDEX), HTTP_OPTS);
    const body1 = asText(req.data);

    if (body1.includes(VALID_STRING)) {
      // Istnieje: sprawdź NEW / UPDATED
      console.log("!!----------" + tzName() + " Time------------!!");

      const reqNew = await axios.get(NEW_POST_URL + String(CURRENT_INDEX), HTTP_OPTS);
      const body2 = asText(reqNew.data);

      const isNew = body2.includes(NEW_BLOG_STRING);
      if (isNew) {
        console.log("NEW CSGO Blog Post! (New Post)! ID: " + String(CURRENT_INDEX));
      } else {
        console.log("CSGO Blog Post Updated! ID: " + String(CURRENT_INDEX));
      }

      console.log("Time: " + nowPL());
      console.log("----------------------");
      console.log("");

      // Wyślij Components V2
      const postLink = `https://blog.counter-strike.net/index.php/${CURRENT_INDEX}/`;
      await sendComponentsV2(WEBHOOK_URL, THREAD_ID, CURRENT_INDEX, isNew, postLink);

      // Beep x5 co 0.5s (jak w oryginale)
      beep();

      // inkrement po trafieniu
      CURRENT_INDEX = CURRENT_INDEX + 1;
    } else {
      console.log("failed");
      console.log(body1);
      // "sleep" ogarnia setInterval
    }
  } catch (e) {
    console.log("❌ Błąd tick:", e?.message || e);
  } finally {
    RUNNING = false;
  }
}

// Wysyłka Components V2 – prosta karta z danymi jak w printach
async function sendComponentsV2(webhookUrl, threadId, postId, isNew, link) {
  let url;
  try { url = new URL(webhookUrl); } catch { console.error("❌ Nieprawidłowy webhook_url:", webhookUrl); return; }
  url.searchParams.set("with_components", "true");
  url.searchParams.set("wait", "true");
  if (threadId) url.searchParams.set("thread_id", threadId);

  const title = isNew
    ? `NEW CSGO Blog Post! (New Post)! ID: ${postId}`
    : `CSGO Blog Post Updated! ID: ${postId}`;

  const container = { type: 17, components: [] };
  container.components.push({ type: 10, content: title });
  container.components.push({ type: 10, content: `Time: ${nowPL()}` });
  container.components.push({
    type: 1,
    components: [{ type: 2, style: 5, label: "Open", url: link }]
  });

  const payload = {
    username: "CS2 Blog Watcher",
    avatar_url: "https://cdn.discordapp.com/attachments/1303199426407436298/1408825354520494222/90eb6aa1-1bd2-4b26-aba1-9356d0b64f5e-7.jpg",
    flags: 1 << 15,
    components: [container]
  };

  try {
    const res = await axios.post(url.toString(), payload, { headers: { "Content-Type": "application/json" } });
    if (res.status === 200 || res.status === 204) {
      console.log("✅ Powiadomienie wysłane na Discord!");
    } else {
      console.log(`❌ Błąd Discord: ${res.status} | ${asText(res.data)}`);
    }
  } catch (e) {
    console.log(`❌ Błąd wysyłania do Discord: ${e?.response?.status || ""}`, asText(e?.response?.data) || e?.message);
  }
}

// Beep x5 co 0.5s
function beep() {
  for (let i = 0; i < 5; i++) setTimeout(() => process.stdout.write("\x07"), i * 500);
}

// Utils
function asText(d) { if (typeof d === "string") return d; try { return JSON.stringify(d); } catch { return String(d); } }
function nowPL() {
  const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function tzName() {
  // zbliżone do time.tzname[time.daylight]
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local"; } catch { return "Local"; }
}