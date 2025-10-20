// workshop/apix.plugin.js
module.exports = {
  id: "apix",
  name: "ApiX Workshop Plugin",
  version: "1.0.0",
  init(api) {
    api.registerParser({
      name: "apix",
      priority: 45, // przed RSS, po JSON — dostosuj wg potrzeb
      test: (url) => url.startsWith("apix://") || url.endsWith(".json") || url.includes("api."),
      parse: async (url, ctx) => {
        let target = url;
        if (url.startsWith("apix://")) {
          const raw = url.replace("apix://", "");
          target = decodeURIComponent(raw);
          if (!/^https?:\/\//i.test(target)) {
            target = "https://" + target;
          }
        }

        const res = await ctx.get(target);
        const data = res.data;
        let itemsSrc = [];

        if (Array.isArray(data)) {
          itemsSrc = data;
        } else if (data && typeof data === "object") {
          itemsSrc =
            data.items ||
            data.posts ||
            data.entries ||
            data.articles ||
            data.results ||
            data.children ||
            data.data ||
            data.response ||
            [];

          if (!Array.isArray(itemsSrc) || itemsSrc.length === 0) {
            for (const val of Object.values(data)) {
              if (Array.isArray(val) && val.length > 0) {
                itemsSrc = val;
                break;
              }
            }
          }
        }

        if (!Array.isArray(itemsSrc) || itemsSrc.length === 0) return [];

        const { stripHtml, parseDate } = api.utils;
        const items = itemsSrc
          .map((entry) => {
            const title =
              entry.title || entry.name || entry.headline || "Brak tytułu";
            const link =
              entry.url ||
              entry.link ||
              entry.permalink ||
              (entry.id ? `#${entry.id}` : null);
            if (!link) return null;

            const description =
              entry.summary ||
              entry.description ||
              entry.body ||
              entry.text ||
              entry.content ||
              "";
            const author =
              entry.author?.name ||
              entry.author ||
              entry.user?.name ||
              entry.user ||
              entry.by ||
              null;

            const dateString =
              entry.date ||
              entry.created_at ||
              entry.updated_at ||
              entry.published_at ||
              entry.timestamp ||
              null;

            const image =
              entry.image ||
              entry.thumbnail ||
              entry.banner ||
              entry.media_url ||
              entry.preview_image ||
              null;

            const contentSnippet =
              typeof description === "string"
                ? stripHtml(description).result.substring(0, 500).trim()
                : "Brak opisu.";

            return {
              title,
              link,
              contentSnippet,
              isoDate: parseDate(dateString || new Date().toISOString()),
              enclosure: image || null,
              author,
              guid: entry.id || link || title,
              categories: entry.tags || entry.categories || []
            };
          })
          .filter(Boolean);

        // przykład użycia KV (zapamiętaj ostatnie GUIDy)
        const recentKey = "recent_guids";
        for (const it of items) {
          api.kv.push(recentKey, it.guid, 500);
        }

        return items;
      }
    });
  }
};