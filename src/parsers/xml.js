const axios = require("axios");
const xml2js = require("xml2js");

function cleanCDATA(str) {
  if (!str) return "";
  return str.replace("<![CDATA[", "").replace("]]>", "").trim();
}

async function parseXML(feedUrl) {
  try {
    const res = await axios.get(feedUrl);
    const data = await xml2js.parseStringPromise(res.data);

    const channel = data.rss?.channel?.[0];
    const items = channel?.item || [];

    if (!items.length) return [];

    return items.map((i) => ({
      title: cleanCDATA(i.title?.[0] || ""),
      link: cleanCDATA(i.link?.[0] || ""),
      contentSnippet: cleanCDATA(i.description?.[0] || ""),
      isoDate: cleanCDATA(i.pubDate?.[0] || ""),
      enclosure: i.enclosure?.[0]?.["$"]?.url || null,
      author: i["dc:creator"]?.[0] || null,
      guid: i.guid?.[0] || null,
      categories: i.category || [],
    }));
  } catch {
    return [];
  }
}

module.exports = { parseXML };
