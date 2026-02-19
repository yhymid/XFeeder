// src/scrapling/config.js
const { loadConfig } = require('../config-loader');

class ScraplingConfig {
  constructor() {
    this.config = this.loadConfig();
  }
  
  loadConfig() {
    try {
      const config = loadConfig('./config.json');
      return config.Scrapling || {};
    } catch (err) {
      console.warn('[Scrapling] No config found, using defaults');
      return {};
    }
  }
  
  get enabled() {
    return this.config.Enabled !== false;
  }
  
  get autoFallback() {
    return this.config.AutoFallback !== false;
  }

  get forceGlobal() {
    return this.config.ForceGlobal === true;
  }
  
  get preferredMode() {
    return this.config.PreferredMode || 'cli';  // 'cli' | 'shell' | 'auto'
  }
  
  get defaultFetchMode() {
    return this.config.DefaultFetchMode || 'stealthy-fetch';
  }
  
  get defaultOptions() {
    return {
      headless: true,
      solveCaptcha: false,
      timeout: 60,
      wait: 0,
      disableResources: true,
      networkIdle: false,
      waitSelector: null,
      waitSelectorState: null,
      blockedDomains: [],
      retries: 3,
      retryDelay: 1,
      ...this.config.DefaultOptions
    };
  }
  
  getUrlConfig(url) {
    const perUrlConfig = this.config.PerUrlConfig || {};
    
    // Find matching config
    for (const [pattern, config] of Object.entries(perUrlConfig)) {
      if (url.includes(pattern)) {
        return {
          ...this.defaultOptions,
          ...config
        };
      }
    }
    
    return this.defaultOptions;
  }
  
  shouldUseScrapling(url, statusCode) {
    if (!this.enabled) return false;
    
    // Check explicit URL/pattern config
    const perUrlConfig = this.config.PerUrlConfig || {};
    for (const [pattern, cfg] of Object.entries(perUrlConfig)) {
      if (url.includes(pattern) && cfg?.enabled !== undefined) {
        return cfg.enabled;
      }
    }

    // Force Scrapling for all URLs
    if (this.forceGlobal) return true;
    
    // Check auto-fallback for specific status codes
    if (this.autoFallback && statusCode) {
      const fallbackCodes = this.config.FallbackStatusCodes || [403, 429, 503];
      return fallbackCodes.includes(statusCode);
    }
    
    return false;
  }
}

// Singleton
let instance = null;

function getConfig() {
  if (!instance) {
    instance = new ScraplingConfig();
  }
  return instance;
}

module.exports = { getConfig, ScraplingConfig };
