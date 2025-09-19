const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseAtom(feedUrl) {
  try {
    const res = await axios.get(feedUrl);
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(res.data);

    const entries = data.feed?.entry || [];
    if (!entries.length) return [];

    return (Array.isArray(entries) ? entries : [entries]).map((e) => ({
      title: cleanCDATA(e.title || ""),
      link: e.link?.["@_href"] || "",
      contentSnippet: cleanCDATA(e.summary || e.content || ""),
      isoDate: e.updated || e.published || "",
      enclosure: e["media:thumbnail"]?.["@_url"] || null,
      author: e.author?.name || null,
      guid: e.id || null,
      categories: e.category ? [e.category] : [],
    }));
  } catch {
    return [];
  }
}

module.exports = { parseAtom };
