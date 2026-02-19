// src/scrapling/cli.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDetector } = require('./detector');
const { getConfig } = require('./config');

class ScraplingCLI {
  constructor() {
    this.detector = getDetector();
    this.config = getConfig();
  }
  
  /**
   * Execute scrapling extract command
   * @param {string} url - URL to fetch
   * @param {object} options - Fetch options
   * @returns {Promise<object>} Response with html, status, url
   */
  async extract(url, options = {}) {
    this.detector.requireFeature('extract');
    
    const {
      mode = this.config.defaultFetchMode,
      headless = true,
      solveCaptcha = false,
      cssSelector = null,
      timeout = 60,
      proxy = null,
      headers = {},
      cookies = null,
      impersonate = 'chrome',
      networkIdle = false,
      wait = 0,
      waitSelector = null,
      disableResources = true,
      blockWebrtc = false,
      hideCanvas = false,
      allowWebgl = true,
    } = { ...this.config.getUrlConfig(url), ...options };
    const modeType = getModeType(mode);
    if (modeType === 'unknown') {
      throw new Error(`Unsupported Scrapling mode: ${mode}`);
    }
    const timeoutValue = normalizeTimeoutForMode(timeout, modeType);
    
    // Create temp file for output
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `scrapling-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    
    try {
      const { command, baseArgs } = resolveScraplingCommand(this.detector.scraplingPath);

      // Build command
      const args = [
        ...baseArgs,
        'extract',
        mode,
        url,
        tmpFile,
        '--timeout', String(timeoutValue),
      ];
      
      // Mode-specific options
      if (modeType === 'browser') {
        if (headless) args.push('--headless');
        else args.push('--no-headless');
        
        if (disableResources) args.push('--disable-resources');
        if (networkIdle) args.push('--network-idle');
        if (waitSelector) args.push('--wait-selector', waitSelector);
        if (Number(wait) > 0) args.push('--wait', String(Math.round(Number(wait))));
        
        if (mode === 'stealthy-fetch') {
          if (solveCaptcha) args.push('--solve-cloudflare');
          if (blockWebrtc) args.push('--block-webrtc');
          if (hideCanvas) args.push('--hide-canvas');
          if (!allowWebgl) args.push('--block-webgl');
        }
      } else if (modeType === 'request') {
        args.push('--impersonate', impersonate);
        if (!headless) args.push('--no-stealthy-headers');
      }
      
      // Common options
      if (cssSelector) args.push('--css-selector', cssSelector);
      if (proxy) args.push('--proxy', proxy);
      if (cookies && modeType === 'request') args.push('--cookies', cookies);
      
      // Headers
      for (const [key, value] of Object.entries(headers)) {
        if (modeType === 'browser') {
          args.push('--extra-headers', `${key}: ${value}`);
        } else {
          args.push('-H', `${key}: ${value}`);
        }
      }
      
      console.log(`[Scrapling CLI] Executing: ${mode} for ${url}`);
      
      const startTime = Date.now();
      
      execFileSync(command, args, {
        encoding: 'utf8',
        timeout: (timeout + 10) * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024  // 50MB buffer
      });
      
      // Read output file
      const html = fs.readFileSync(tmpFile, 'utf8');
      const elapsed = Date.now() - startTime;
      
      console.log(`[Scrapling CLI] Success in ${elapsed}ms`);
      
      return {
        ok: true,
        status: 200,
        html,
        url,
        scrapling: true,
        mode: 'cli',
        fetchMode: mode,
        elapsed
      };
      
    } catch (err) {
      console.error('[Scrapling CLI] Error:', err.message);
      
      // Check if it's a timeout
      if (err.message.includes('ETIMEDOUT')) {
        throw new Error(`Scrapling timeout after ${timeout}s`);
      }
      
      throw err;
      
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {}
    }
  }
  
  /**
   * Quick methods for common modes
   */
  async get(url, options = {}) {
    return this.extract(url, { ...options, mode: 'get' });
  }
  
  async stealthyFetch(url, options = {}) {
    return this.extract(url, { ...options, mode: 'stealthy-fetch', solveCaptcha: true });
  }
  
  async dynamicFetch(url, options = {}) {
    return this.extract(url, { ...options, mode: 'fetch' });
  }
}

function resolveScraplingCommand(scraplingPath) {
  const value = String(scraplingPath || '').trim();
  if (!value) throw new Error('Scrapling path is empty');

  if (/\s-m\s+scrapling$/.test(value)) {
    const command = value.replace(/\s-m\s+scrapling$/, '').trim();
    return { command, baseArgs: ['-m', 'scrapling'] };
  }

  return { command: value, baseArgs: [] };
}

function getModeType(mode) {
  if (mode === 'fetch' || mode === 'stealthy-fetch') return 'browser';
  if (mode === 'get' || mode === 'post' || mode === 'put' || mode === 'delete') return 'request';
  return 'unknown';
}

function normalizeTimeoutForMode(timeout, modeType) {
  const n = Number(timeout);
  const safe = Number.isFinite(n) && n > 0 ? n : 30;
  // Request modes (get/post/put/delete) expect seconds, browser modes expect milliseconds.
  return modeType === 'browser' ? Math.round(safe * 1000) : Math.round(safe);
}

// Singleton
let instance = null;

function getCLI() {
  if (!instance) {
    instance = new ScraplingCLI();
  }
  return instance;
}

module.exports = { getCLI, ScraplingCLI };
