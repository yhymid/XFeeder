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
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === "entry" || name === "link" || name === "media:thumbnail",
    });
    const data = parser.parse(res.data);

    const entries = data.feed?.entry || [];
    if (!entries.length) return [];

    return (Array.isArray(entries) ? entries : [entries]).map((e) => {
      // Miniaturki
      const thumbnails = e["media:group"]?.["media:thumbnail"] || [];
      const highResThumbnail = Array.isArray(thumbnails)
        ? thumbnails.find((t) => parseInt(t["@_width"], 10) >= 640)?.["@_url"] ||
          thumbnails[0]?.["@_url"]
        : thumbnails?.["@_url"];

      // Opis (uwzględnia różne możliwe formaty)
      const description =
        e["media:group"]?.["media:description"]?.["#text"] ||
        e["media:group"]?.["media:description"] ||
        e.summary?.["#text"] ||
        e.summary ||
        "";

      // Autor (może być tablica lub obiekt)
      let author = null;
      if (e.author) {
        if (Array.isArray(e.author)) {
          author = e.author[0]?.name?.["#text"] || e.author[0]?.name || null;
        } else {
          author = e.author?.name?.["#text"] || e.author?.name || null;
        }
      }

      return {
        title: cleanCDATA(e.title?.["#text"] || e.title || ""),
        link: getYouTubeLink(e),
        contentSnippet: cleanCDATA(
          description.slice(0, 300) + (description.length > 300 ? "..." : "")
        ),
        isoDate: e.published?.["#text"] || e.published || e.updated?.["#text"] || e.updated || "",
        enclosure: highResThumbnail,
        author,
        guid: e["yt:videoId"]?.["#text"] || e["yt:videoId"] || e.id?.["#text"] || e.id || null,
        categories: [],
      };
    });
  } catch (error) {
    console.error("[YouTube] Błąd parsowania:", error.message);
    return [];
  }
}

// Funkcja pomocnicza do uzyskania poprawnego linka
function getYouTubeLink(entry) {
  if (entry.link) {
    const links = Array.isArray(entry.link) ? entry.link : [entry.link];
    const videoLink = links.find((link) => link["@_rel"] === "alternate" && link["@_href"]);
    if (videoLink) return videoLink["@_href"];
  }

  // Fallback: stwórz link z videoId
  const videoId = entry["yt:videoId"]?.["#text"] || entry["yt:videoId"];
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

  return "";
}

module.exports = { parseYouTube };