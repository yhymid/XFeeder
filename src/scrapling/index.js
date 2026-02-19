// src/scrapling/index.js
const { getDetector } = require('./detector');
const { getConfig } = require('./config');
const { getCLI } = require('./cli');
const { getShell } = require('./shell');
const { 
  isCloudflareProtected,
  isProtectedStatus,
  htmlToFeedItems,
  detectFeedFormat
} = require('./utils');

class Scrapling {
  constructor() {
    this.detector = getDetector();
    this.config = getConfig();
    this.cli = getCLI();
    this.shell = getShell();
  }
  
  /**
   * Check if Scrapling is available
   */
  get available() {
    return this.detector.available;
  }
  
  /**
   * Check if enabled in config
   */
  get enabled() {
    return this.config.enabled && this.available;
  }
  
  /**
   * Get version
   */
  get version() {
    return this.detector.version;
  }
  
  /**
   * Fetch URL with auto-selection of best method
   * @param {string} url - URL to fetch
   * @param {object} options - Fetch options
   * @returns {Promise<object>} Response object
   */
  async fetch(url, options = {}) {
    if (!this.enabled) {
      throw new Error('Scrapling not enabled or not available');
    }
    
    const preferredMode = options.preferredMode || this.config.preferredMode;
    
    // Try preferred mode first
    try {
      if (preferredMode === 'cli' && this.detector.hasExtract) {
        return await this.cli.extract(url, options);
      } else if (preferredMode === 'shell' && this.detector.hasShell) {
        return await this.shell.fetch(url, options);
      } else if (preferredMode === 'auto') {
        // Auto-select based on features needed
        if (options.solveCaptcha && this.detector.hasExtract) {
          return await this.cli.extract(url, options);
        } else if (this.detector.hasShell) {
          return await this.shell.fetch(url, options);
        } else if (this.detector.hasExtract) {
          return await this.cli.extract(url, options);
        }
      }
    } catch (err) {
      console.warn(`[Scrapling] ${preferredMode} mode failed, trying fallback`);
      
      // Try fallback
      if (preferredMode !== 'shell' && this.detector.hasShell) {
        return await this.shell.fetch(url, options);
      } else if (preferredMode !== 'cli' && this.detector.hasExtract) {
        return await this.cli.extract(url, options);
      }
      
      throw err;
    }
    
    throw new Error('No Scrapling interface available');
  }
  
  /**
   * Quick methods for specific modes
   */
  async get(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'get' });
  }
  
  async stealthyFetch(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'stealthy-fetch', solveCaptcha: true });
  }
  
  async dynamicFetch(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'fetch' });
  }
  
  /**
   * Should use Scrapling for this URL/status?
   */
  shouldUse(url, statusCode = null) {
    return this.config.shouldUseScrapling(url, statusCode);
  }
  
  /**
   * Parse HTML to feed items
   */
  parseHtmlToFeed(html, options = {}) {
    return htmlToFeedItems(html, options);
  }
  
  /**
   * Utility functions
   */
  utils = {
    isCloudflareProtected,
    isProtectedStatus,
    htmlToFeedItems,
    detectFeedFormat
  };
}

// Singleton instance
let instance = null;

/**
 * Get Scrapling instance
 * @returns {Scrapling}
 */
function getScrapling() {
  if (!instance) {
    instance = new Scrapling();
  }
  return instance;
}

// Export main function and class
module.exports = {
  getScrapling,
  Scrapling,
  
  // Direct exports for convenience
  isCloudflareProtected,
  isProtectedStatus,
  htmlToFeedItems,
  detectFeedFormat
};