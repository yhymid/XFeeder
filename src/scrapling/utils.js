// src/scrapling/utils.js

/**
 * Check if URL is likely protected by Cloudflare
 */
function isCloudflareProtected(headers) {
  if (!headers) return false;
  
  const cfHeaders = [
    'cf-ray',
    'cf-cache-status',
    'cf-request-id',
    'cf-edge-server'
  ];
  
  const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
  
  return cfHeaders.some(cf => headerKeys.includes(cf));
}

/**
 * Check if status code indicates protection
 */
function isProtectedStatus(status) {
  return [403, 429, 503].includes(status);
}

/**
 * Parse HTML to extract feed-like items
 */
function htmlToFeedItems(html, options = {}) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  const {
    itemSelector = 'article, .post, .entry, .item',
    titleSelector = 'h1, h2, h3, .title',
    linkSelector = 'a[href]',
    contentSelector = '.content, .description, .excerpt, p',
    dateSelector = 'time, .date, .published',
    authorSelector = '.author, .by'
  } = options;
  
  const items = [];
  
  $(itemSelector).each((i, elem) => {
    const $item = $(elem);
    
    const title = $item.find(titleSelector).first().text().trim();
    const link = $item.find(linkSelector).first().attr('href');
    const content = $item.find(contentSelector).first().text().trim();
    const date = $item.find(dateSelector).first().text().trim() || 
                 $item.find(dateSelector).first().attr('datetime');
    const author = $item.find(authorSelector).first().text().trim();
    
    if (title || content) {
      items.push({
        title: title || 'Untitled',
        link: link || '#',
        contentSnippet: content ? content.substring(0, 500) : '',
        isoDate: date ? new Date(date).toISOString() : new Date().toISOString(),
        author: author || null,
        guid: link || `item-${i}`,
        categories: []
      });
    }
  });
  
  return items;
}

/**
 * Detect feed format from HTML
 */
function detectFeedFormat(html) {
  const formats = {
    rss: /<rss[\s>]/i,
    atom: /<feed[\s>].*xmlns/i,
    json: /^\s*{[\s\S]*"items"\s*:/,
    html: /<html[\s>]/i
  };
  
  for (const [format, pattern] of Object.entries(formats)) {
    if (pattern.test(html)) {
      return format;
    }
  }
  
  return 'unknown';
}

module.exports = {
  isCloudflareProtected,
  isProtectedStatus,
  htmlToFeedItems,
  detectFeedFormat
};