const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseYouTube(feedUrl) {
  if (!feedUrl.includes("youtube.com") && !feedUrl.includes("yt:")) return [];

  try {
    const res = await axios.get(feedUrl);
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(res.data);

    const entries = data.feed?.entry || [];
    if (!entries.length) return [];

    return (Array.isArray(entries) ? entries : [entries]).map((e) => ({
      title: cleanCDATA(e.title || ""),
      link: e.link?.["@_href"] || "",
      contentSnippet: cleanCDATA(e["media:description"] || e.summary || ""),
      isoDate: e.published || e.updated || "",
      enclosure: e["media:thumbnail"]?.["@_url"] || null,
      author: e.author?.name || null,
      guid: e["yt:videoId"] || null,
      categories: [],
    }));
  } catch {
    return [];
  }
}

module.exports = { parseYouTube };
