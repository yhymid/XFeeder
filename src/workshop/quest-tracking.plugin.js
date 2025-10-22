// src/workshop/quest-tracking.plugin.js
// All-in-one: Quest Tracking (wysyła Components V2 bez zmian w core).
// Użycie: dodaj "quest://@me" do RSS w kanale. Ustaw Auth.Token (user token) w config.json.
// Uwaga: user token = self-bot (łamie ToS Discorda).

const axios = require("axios");

module.exports = {
  id: "quest-tracking",
  enabled: true,
  init(api) {
    const pluginCfg = api.config?.Workshop?.Plugins?.["quest-tracking"] || {};
    const endpointDefault = pluginCfg.Endpoint || "https://discord.com/api/v9/quests/@me";
    const locale = pluginCfg.Locale || "pl-PL";
    const timezone = pluginCfg.Timezone || "Europe/Warsaw";
    const CDN_ASSETS_BASE = (pluginCfg.CdnBase || "https://cdn.discordapp.com/quests/assets/").replace(/\/+$/, "") + "/";

    const FEATURES_MAP = {
      3: "QUEST_BAR_V2", 8: "FEATURE_8", 9: "REWARD_HIGHLIGHTING",
      13: "DISMISSAL_SURVEY", 14: "MOBILE_QUEST_DOCK", 15: "QUESTS_CDN",
      16: "PACING_CONTROLLER", 18: "VIDEO_QUEST_FORCE_HLS_VIDEO",
      19: "VIDEO_QUEST_FORCE_END_CARD_CTA_SWAP",
      23: "MOBILE_ONLY_QUEST_PUSH_TO_MOBILE", 26: "FEATURE_26"
    };
    // Dopasowane do Twojego “Raw”
    const REWARD_TYPE = { 1: "Reward Code", 3: "Collectible", 4: "Virtual Currency" };
    const PLATFORMS = { 0: "Cross Platform", 1: "PC", 2: "Xbox", 3: "PlayStation", 4: "Mobile" };
    const TASK_NAME = {
      WATCH_VIDEO: "Watch video",
      WATCH_VIDEO_ON_MOBILE: "Watch video on mobile",
      PLAY_ON_DESKTOP: "Play on desktop",
      PLAY_ON_XBOX: "Play on Xbox",
      PLAY_ON_PLAYSTATION: "Play on PlayStation",
      ACHIEVEMENT_IN_ACTIVITY: "Achievement in activity",
      PLAY_ACTIVITY: "Play activity"
    };

    api.registerParser({
      name: "quest-tracking",
      priority: 25,
      test: (url) => typeof url === "string" && url.startsWith("quest://"),
      parse: async (url /*, ctx */) => {
        const token = pluginCfg.Token || api.config?.Auth?.Token || null;
        const superProps = pluginCfg["x-super-properties"] || api.config?.Auth?.["x-super-properties"] || null;
        const cookie = pluginCfg.cookie || api.config?.Auth?.cookie || null;
        if (!token) { api.warn("[quest-tracking] Brak Auth.Token – pomijam."); return []; }

        let endpoint = endpointDefault;
        try {
          const u = new URL(url.replace("quest://", "https://placeholder/"));
          const ep = u.searchParams.get("endpoint");
          if (ep) endpoint = decodeURIComponent(ep);
        } catch {}

        const targets = findTargets(api.config, url);
        if (!targets.length) { api.warn("[quest-tracking] Brak kanału z tym feedem.", { feedUrl: url }); return []; }

        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
          "Authorization": token,
          "X-Discord-Locale": "en-US",
          "Accept": "application/json, text/plain, */*"
        };
        if (superProps) headers["X-Super-Properties"] = superProps;
        if (cookie) headers["cookie"] = cookie;

        let data;
        try {
          const res = await axios.get(endpoint, { headers, timeout: 15000 });
          data = res.data;
        } catch (err) {
          api.warn("[quest-tracking] Błąd pobrania", { status: err?.response?.status, msg: err?.message });
          return [];
        }

        const quests = Array.isArray(data) ? data : (Array.isArray(data?.quests) ? data.quests : []);
        if (!quests.length) return [];

        const sent = api.kv.get("sent", {}); // { targetKey: [ids] }
        let sentCount = 0;

        for (const q of quests) {
          const questId = q?.id || q?.config?.id;
          if (!questId) continue;

          const card = buildCard(q, questId);

          for (const t of targets) {
            const key = `${t.webhook}|${t.thread || "null"}`;
            const already = Array.isArray(sent[key]) && sent[key].includes(questId);
            if (already) continue;

            try {
              if (t.mentionRole) {
                await sendRoleMention(t.webhook, t.thread, t.mentionRole);
                await sleep(200);
              }

              await sendToWebhook(t.webhook, t.thread, card);
              if (!Array.isArray(sent[key])) sent[key] = [];
              sent[key].unshift(questId);
              if (sent[key].length > 2000) sent[key].length = 2000;
              api.kv.set("sent", sent);
              sentCount++;
            } catch (err) {
              api.error("[quest-tracking] Błąd wysyłki", {
                webhookTail: tail(t.webhook), thread: t.thread || null, questId,
                msg: err?.response?.data || err?.message
              });
            }
            await sleep(300);
          }
        }

        if (sentCount) api.log(`[quest-tracking] Wysłano ${sentCount} powiadomień.`);
        return []; // wysyłamy sami
      }
    });

    // =============== Helpers ===============

    function findTargets(cfg, feedUrl) {
      const out = [];
      for (const key of Object.keys(cfg || {})) {
        if (!key.toLowerCase().startsWith("channels")) continue;
        const arr = cfg[key];
        if (!Array.isArray(arr)) continue;
        for (const ch of arr) {
          const list = Array.isArray(ch?.RSS) ? ch.RSS : [];
          if (list.includes(feedUrl) && ch.Webhook) {
            out.push({
              webhook: ch.Webhook,
              thread: (ch.Thread && ch.Thread !== "null") ? ch.Thread : null,
              mentionRole: ch.MentionRole || ch.PingRole || pluginCfg.MentionRole || null
            });
          }
        }
      }
      return out;
    }

    function buildCard(q, questId) {
      const cfg = q?.config || {};
      const assets = cfg.assets || {};
      const app = cfg.application || {};
      const messages = cfg.messages || {};
      const rewardsCfg = cfg.rewards_config || {};
      const rewards = Array.isArray(rewardsCfg.rewards) ? rewardsCfg.rewards : [];
      const reward = rewards[0] || null;

      const features = Array.isArray(cfg.features)
        ? cfg.features.map(n => FEATURES_MAP[n] || `FEATURE_${n}`) : [];

      const tasks = extractTasks(cfg);

      const platforms = Array.isArray(rewardsCfg.platforms) && rewardsCfg.platforms.length
        ? rewardsCfg.platforms.map(p => PLATFORMS[p] || `Platform_${p}`) : ["Cross Platform"];

      const rewardType = reward ? (REWARD_TYPE[reward.type] || `Type_${reward.type}`) : null;
      const rewardSku = reward?.sku_id || null;
      const rewardName = reward?.messages?.name || reward?.name || null;
      const rewardExpiresIso = reward?.expires_at || rewardsCfg?.rewards_expire_at || null;
      const rewardCollectibleId =
        reward?.avatar_decoration_id || reward?.collectible_item_id || reward?.item_id || null;

      // Orbs kwota: orb_quantity (plus fallbacki)
      const rewardOrbsAmount =
        reward?.orb_quantity || reward?.orbs_amount || reward?.amount || reward?.quantity ||
        (typeof rewardName === "string" ? (rewardName.match(/\b(\d{1,6})\s*orbs?/i)?.[1] || null) : null);

      const rewardAssetCandidates = addMp4Guesses(expandHlsCandidates(resolveAssetMulti(reward?.asset, questId)));
      const rewardImage = firstMatch(rewardAssetCandidates, isImage);
      const rewardVideo = pickBestVideo(rewardAssetCandidates);

      // Promo video: hero/quest_bar/video_metadata + fallback z zadań
      const promoCandidates = addMp4Guesses(expandHlsCandidates([
        ...resolveAssetMulti(assets.hero_video, questId),
        ...resolveAssetMulti(assets.quest_bar_hero_video, questId),
        ...resolveAssetMulti(cfg?.video_metadata?.assets?.video_player_video, questId),
        ...resolveAssetMulti(cfg?.video_metadata?.assets?.video_player_video_hls, questId),
        ...collectTaskVideos(cfg, questId)
      ]));
      const promoVideo = pickBestVideo(promoCandidates);

      // Obrazy do galerii (tylko prawdziwe obrazki)
      const images = collectImages(cfg, questId, rewardImage);

      return {
        id: q?.id || cfg?.id,
        name: messages.quest_name || messages.game_title || app.name || `Quest ${q?.id || ""}`.trim(),
        application: {
          id: app.id || null,
          name: app.name || "Unknown",
          link: (app.link || "").trim() || null
        },
        game: { title: messages.game_title || null, publisher: messages.game_publisher || null },
        duration: {
          startIso: cfg.starts_at || null, endIso: cfg.expires_at || null,
          startEpoch: isoToEpoch(cfg.starts_at), endEpoch: isoToEpoch(cfg.expires_at)
        },
        features, tasks, platforms,
        reward: reward ? {
          typeLabel: rewardType,
          skuId: rewardSku,
          name: rewardName,
          expiresIso: rewardExpiresIso,
          collectibleId: rewardCollectibleId || null,
          orbsAmount: rewardOrbsAmount || null
        } : null,
        images,              // lista obrazów (pierwszy = hero)
        rewardImage,         // obraz do accessory (jeśli dostępny)
        rewardVideo,         // not used w layoucie (zostawiam)
        promoVideo,          // MP4/HLS promo (type 12)
        questLink: `https://discord.com/quests/${q?.id || cfg?.id}`
      };
    }

    function extractTasks(cfg) {
      const list = [];
      if (cfg.task_config_v2?.tasks && typeof cfg.task_config_v2.tasks === "object") {
        for (const t of Object.values(cfg.task_config_v2.tasks)) {
          const type = t.type || t.event_name;
          const target = t.target || 0;
          const label = TASK_NAME[type] || prettify(type);
          list.push({ label, seconds: target });
        }
        return list;
      }
      if (cfg.task_config?.tasks && typeof cfg.task_config.tasks === "object") {
        for (const t of Object.values(cfg.task_config.tasks)) {
          const type = t.event_name || t.type;
          const target = t.target || 0;
          const label = TASK_NAME[type] || prettify(type);
          list.push({ label, seconds: target });
        }
      }
      return list;
    }

    function collectImages(cfg, questId, rewardImage) {
      const a = cfg.assets || {};
      const vm = cfg.video_metadata || {};
      const vmAssets = vm.assets || {};

      const candidates = [
        ...resolveAssetMulti(a.hero, questId),
        ...resolveAssetMulti(a.quest_bar_hero, questId),
        ...resolveAssetMulti(a.game_tile, questId),
        ...resolveAssetMulti(a.logotype, questId),
        ...resolveAssetMulti(a.logotype_light, questId),
        ...resolveAssetMulti(a.logotype_dark, questId),
        ...resolveAssetMulti(a.game_tile_light, questId),
        ...resolveAssetMulti(a.game_tile_dark, questId),
        ...resolveAssetMulti(vmAssets.video_player_thumbnail, questId),
        ...resolveAssetMulti(vmAssets.quest_bar_preview_thumbnail, questId)
      ];

      // miniatury zadań video (v2)
      if (cfg.task_config_v2?.tasks) {
        for (const t of Object.values(cfg.task_config_v2.tasks)) {
          const v = t?.assets?.video;
          const vLow = t?.assets?.video_low_res;
          candidates.push(...resolveAssetMulti(v?.thumbnail, questId));
          candidates.push(...resolveAssetMulti(vLow?.thumbnail, questId));
        }
      }
      // miniatury zadań video (v1)
      if (cfg.task_config?.tasks) {
        for (const t of Object.values(cfg.task_config.tasks)) {
          const v = t?.assets?.video;
          const vLow = t?.assets?.video_low_res;
          candidates.push(...resolveAssetMulti(v?.thumbnail, questId));
          candidates.push(...resolveAssetMulti(vLow?.thumbnail, questId));
        }
      }

      if (rewardImage) candidates.push(rewardImage);

      // Tylko obrazki, dedup, max 10
      const images = [...new Set(candidates.filter(isImage))].slice(0, 10);
      return images;
    }

    function collectTaskVideos(cfg, questId) {
      const urls = [];
      const push = (u) => { if (u) urls.push(...resolveAssetMulti(u, questId)); };
      // v2
      if (cfg.task_config_v2?.tasks) {
        for (const t of Object.values(cfg.task_config_v2.tasks)) {
          const a = t?.assets || {};
          push(a.video?.url);
          push(a.video_low_res?.url);
          push(a.video_hls?.url);
        }
      }
      // v1
      if (cfg.task_config?.tasks) {
        for (const t of Object.values(cfg.task_config.tasks)) {
          const a = t?.assets || {};
          push(a.video?.url);
          push(a.video_low_res?.url);
          push(a.video_hls?.url);
        }
      }
      return expandHlsCandidates(urls);
    }

    // Preferuj scoped (/quests/<questId>/...) nad assets/ (kolejność kandydatów!)
    function resolveAssetMulti(val, questId) {
      if (!val) return [];
      const raw = String(val).trim();
      if (!raw) return [];
      if (/^https?:\/\//i.test(raw)) return [raw];

      const path = raw.replace(/^\/+/, "");
      const urls = [];

      if (questId) urls.push(`https://cdn.discordapp.com/quests/${questId}/${path}`);
      urls.push(`${CDN_ASSETS_BASE}${path}`);

      return urls;
    }

    function firstMatch(urls, pred) {
      for (const u of urls || []) {
        if (pred(u)) return u;
      }
      return null;
    }

    function stripQuery(u) {
      return (u || "").split("?")[0];
    }
    function isImage(u) {
      const s = stripQuery(u);
      return !!s && /\.(png|jpe?g|webp|gif)$/i.test(s);
    }
    function isVideo(u) {
      const s = stripQuery(u);
      return !!s && /\.(mp4|webm|mov|m4v|m3u8|ts)$/i.test(s);
    }

    // Jeżeli trafia się segment .ts w stylu *_mx1080h0000000005.ts, spróbuj dodać kandydat playlisty *_mx1080h.m3u8
    function expandHlsCandidates(urls) {
      const out = [];
      for (const u of urls || []) {
        out.push(u);
        const s = stripQuery(u);
        const m = s.match(/(_mx\d{3,4}h)\d+\.ts$/i);
        if (m) {
          const qs = u.includes("?") ? "?" + u.split("?")[1] : "";
          out.push(s.replace(/(_mx\d{3,4}h)\d+\.ts$/i, "$1.m3u8") + qs);
        }
      }
      return out;
    }

    // Z m3u8 lub segmentów .ts wyprowadź możliwe pełne MP4 (_1080 i _720)
    function addMp4Guesses(urls) {
      const out = new Set(urls || []);
      for (const u of urls || []) {
        const s = stripQuery(u);
        // m3u8: /quests/<questId>/<assetId>.m3u8
        let m = s.match(/\/quests\/(\d+)\/(\d+)\.m3u8$/i);
        if (m) {
          const [, qid, aid] = m;
          out.add(`https://cdn.discordapp.com/quests/${qid}/${aid}_1080.mp4`);
          out.add(`https://cdn.discordapp.com/quests/${qid}/${aid}_720.mp4`);
          continue;
        }
        // ts: /quests/<questId>/<assetId>_mx1080h0000000005.ts
        m = s.match(/\/quests\/(\d+)\/(\d+)_mx\d{3,4}h\d+\.ts$/i);
        if (m) {
          const [, qid, aid] = m;
          out.add(`https://cdn.discordapp.com/quests/${qid}/${aid}.m3u8`);
          out.add(`https://cdn.discordapp.com/quests/${qid}/${aid}_1080.mp4`);
          out.add(`https://cdn.discordapp.com/quests/${qid}/${aid}_720.mp4`);
          continue;
        }
      }
      return Array.from(out);
    }

    // Wybierz najlepszy link wideo wg preferencji
    function pickBestVideo(urls) {
      const uniq = Array.from(new Set(urls || []));
      const order = [
        /_1080\.mp4$/i,
        /_720\.mp4$/i,
        /\.mp4$/i,
        /\.webm$/i,
        /\.mov$/i,
        /\.m4v$/i,
        /\.m3u8$/i,
        /\.ts$/i
      ];
      for (const rx of order) {
        const found = uniq.find(u => rx.test(stripQuery(u)));
        if (found) return found;
      }
      return uniq.find(isVideo) || null;
    }

    function prettify(name) {
      if (!name) return "Task";
      return name.toLowerCase().replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
    }

    function isoToEpoch(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
    }

    function tail(u) { return u ? String(u).slice(-10) : ""; }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function divider() { return { type: 14, spacing: 1, divider: true }; }

    function formatSeconds(totalSec) {
      const s = Math.max(0, Math.round(totalSec || 0));
      if (s === 0) return "0s";
      if (s % 60 === 0) {
        const m = s / 60;
        if (m >= 60) {
          const h = Math.floor(m / 60);
          const mm = m % 60;
          return mm ? `${h}h ${mm}m` : `${h} hours`;
        }
        return m === 1 ? "1 minute" : `${m} minutes`;
      }
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m > 0 ? `${m}m${r}s` : `${s} seconds`;
    }

    // =============== Wysyłka do webhooka ===============

    async function sendRoleMention(webhookUrl, threadId, roleId) {
      if (!roleId) return;
      const u = new URL(webhookUrl);
      if (threadId && threadId !== "null") u.searchParams.set("thread_id", String(threadId));
      const finalUrl = u.toString();
      const payload = { content: `<@&${roleId}>`, flags: 1 };
      await axios.post(finalUrl, payload, { headers: { "Content-Type": "application/json" } });
    }

    async function sendToWebhook(webhookUrl, threadId, q) {
      const components = [];
      const container = { type: 17, components: [] };

      // Nagłówek
      container.components.push({ type: 10, content: `## **New Quest** - [${q.name}](${q.questLink})` });

      // Hero (pierwszy obraz)
      const hero = Array.isArray(q.images) && q.images.length ? q.images[0] : null;
      if (hero) {
        container.components.push({
          type: 12,
          items: [{ media: { url: hero }, description: null, spoiler: false }]
        });
      }

      // Divider
      container.components.push(divider());

      // Quest Info
      const dur = (q.duration?.startEpoch && q.duration?.endEpoch)
        ? `<t:${q.duration.startEpoch}:d> - <t:${q.duration.endEpoch}:d>`
        : `${q.duration?.startIso || ""} - ${q.duration?.endIso || ""}`;
      const platformsText = Array.isArray(q.platforms) && q.platforms.length ? q.platforms.join(", ") : "Cross Platform";
      const gameLabel = [q.game?.title, q.game?.publisher].filter(Boolean).join(" (") + (q.game?.publisher ? ")" : "");
      const appLink = q.application?.link ? `[${q.application?.name}](${q.application?.link})` : (q.application?.name || "Unknown");
      const appId = q.application?.id ? ` (\`${q.application.id}\`)` : "";
      const featuresLine = (q.features && q.features.length) ? q.features.map(f => `\`${f}\``).join(", ") : null;
      const infoLines = [
        `# Quest Info`,
        `**Duration**: ${dur}`,
        `**Reedemable Platforms**: ${platformsText}`, // pisownia jak w Twoim “Raw”
        gameLabel ? `**Game**: ${gameLabel}` : null,
        `**Application**: ${appLink}${appId}`,
        featuresLine ? `**Features**: ${featuresLine}` : null
      ].filter(Boolean).join("\n");
      container.components.push({ type: 10, content: infoLines });

      // Divider
      container.components.push(divider());

      // Tasks
      const tasksHeader = [`# Tasks`, `User must complete any of the following tasks`];
      let tasksBody = [];
      if (Array.isArray(q.tasks) && q.tasks.length) {
        tasksBody = q.tasks.map(t => `- ${t.label} (${formatSeconds(t.seconds)})`);
      } else {
        tasksBody = [`- (no tasks listed)`];
      }
      container.components.push({ type: 10, content: [...tasksHeader, ...tasksBody].join("\n") });

      // Divider
      container.components.push(divider());

      // Rewards (wiersz z accessory)
      let rewardsText = `# Rewards\n- (no reward)`;
      if (q.reward) {
        const expEpoch = q.reward.expiresIso ? isoToEpoch(q.reward.expiresIso) : null;
        const rLines = [
          `# Rewards`,
          `**Reward Type**: ${q.reward.typeLabel || "-"}`,
          q.reward.skuId ? `**SKU ID**: \`${q.reward.skuId}\`` : null,
          (q.reward.typeLabel === "Collectible" && q.reward.collectibleId) ? `**Avatar Decoration ID**: \`${q.reward.collectibleId}\`` : null,
          (q.reward.typeLabel === "Virtual Currency" && q.reward.orbsAmount) ? `**Orbs Amount**: ${q.reward.orbsAmount}` : null,
          q.reward.name ? `**Name**: ${q.reward.name}` : null,
          q.reward.expiresIso ? `**Expires**: ${expEpoch ? `<t:${expEpoch}:d>` : q.reward.expiresIso}` : null
        ].filter(Boolean);
        rewardsText = rLines.join("\n");
      }

      const rewardsRow = {
        type: 9,
        components: [{ type: 10, content: rewardsText }]
      };
      const accessoryUrl = q.rewardImage || resolveRewardAccessoryUrl(q);
      if (accessoryUrl) {
        rewardsRow.accessory = {
          type: 11,
          media: { url: accessoryUrl },
          description: q.reward?.name || null,
          spoiler: false
        };
      }
      container.components.push(rewardsRow);

      // Promo video (type 12) - zamiast przycisku
      if (q.promoVideo) {
        container.components.push(divider());
        container.components.push({
          type: 12,
          items: [{
            media: { url: q.promoVideo },
            description: q.game?.title || q.reward?.name || q.name,
            spoiler: false
          }]
        });
      }

      // Divider + Stopka
      container.components.push(divider());
      container.components.push({ type: 10, content: `Quest ID: \`${q.id}\`` });

      components.push(container);

      const finalUrl = (() => {
        const u = new URL(webhookUrl);
        u.searchParams.set("with_components", "true");
        if (threadId && threadId !== "null") u.searchParams.set("thread_id", String(threadId));
        return u.toString();
      })();

      // 32769 – dopasowane do “Raw” (32768 + 1)
      const payload = { content: "", flags: 32769, components };
      await axios.post(finalUrl, payload, { headers: { "Content-Type": "application/json" } });
    }

    // =============== Accessory heurystyki ===============
    function resolveRewardAccessoryUrl(q) {
      if (!q?.reward?.typeLabel) return null;
      // Virtual Currency -> stała ikonka Orbs (jak w Raw)
      if (q.reward.typeLabel === "Virtual Currency") {
        return "https://cdn.discordapp.com/assets/content/eff35518172b971fa47c521ca21c7576d3a245433a669a6765f63b744b7b733a.webm?format=png";
      }
      // Reward Code / Collectible -> fallback do pierwszego sensownego obrazka
      return firstImageFrom(q.images);
    }

    function firstImageFrom(arr) {
      if (!Array.isArray(arr)) return null;
      for (const u of arr) if (isImage(u)) return u;
      return null;
    }
  }
};