// src/scrapling/shell.js
const { execFileSync } = require('child_process');
const { getDetector } = require('./detector');
const { getConfig } = require('./config');

class ScraplingShell {
  constructor() {
    this.detector = getDetector();
    this.config = getConfig();
  }
  
  /**
   * Execute Python code via scrapling shell
   * @param {string} code - Python code to execute
   * @param {number} timeout - Timeout in seconds
   * @returns {string} stdout output
   */
  exec(code, timeout = 60) {
    this.detector.requireFeature('shell');
    
    try {
      const { command, baseArgs } = resolveScraplingCommand(this.detector.scraplingPath);
      const result = execFileSync(command, [...baseArgs, 'shell', '-c', code], {
        encoding: 'utf8',
        timeout: timeout * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
      
      return result.trim();
      
    } catch (err) {
      console.error('[Scrapling Shell] Error:', err.message);
      throw err;
    }
  }
  
  /**
   * Fetch URL using shell mode
   * @param {string} url - URL to fetch
   * @param {object} options - Fetch options
   * @returns {Promise<object>} Response object
   */
  async fetch(url, options = {}) {
    this.detector.requireFeature('shell');
    
    const {
      mode = 'stealthy_fetch',
      solveCaptcha = false,
      headless = true,
      networkIdle = false,
      loadDom = true,
      cssSelector = null,
      waitSelector = null,
      waitSelectorState = null,
      timeout = 60,
      wait = 0,
      proxy = null,
      blockedDomains = [],
      retries = 3,
      retryDelay = 1,
      headers = {},
      disableResources = true,
    } = { ...this.config.getUrlConfig(url), ...options };

    const normalizedMode = normalizeMode(mode);
    if (!normalizedMode) {
      throw new Error(`Unsupported Scrapling mode: ${mode}`);
    }
    
    const payload = JSON.stringify({
      mode: normalizedMode,
      url,
      solveCaptcha: Boolean(solveCaptcha),
      headless: Boolean(headless),
      networkIdle: Boolean(networkIdle),
      loadDom: Boolean(loadDom),
      cssSelector: cssSelector || null,
      waitSelector: waitSelector || null,
      waitSelectorState: waitSelectorState || null,
      timeout: Number(timeout),
      wait: Number(wait),
      proxy: proxy || null,
      blockedDomains: Array.isArray(blockedDomains) ? blockedDomains : [],
      retries: Number(retries),
      retryDelay: Number(retryDelay),
      extraHeaders: headers && typeof headers === 'object' ? headers : {},
      disableResources: Boolean(disableResources),
    });

    const pythonCode = [
      'import json',
      `p = json.loads(${JSON.stringify(payload)})`,
      'mode = p.get("mode", "stealthy_fetch")',
      'if mode not in {"get", "fetch", "stealthy_fetch"}:',
      '    raise ValueError(f"Unsupported mode: {mode}")',
      'kwargs = {}',
      'if mode == "stealthy_fetch" and p.get("solveCaptcha"):',
      '    kwargs["solve_cloudflare"] = True',
      'if not p.get("headless", True):',
      '    kwargs["headless"] = False',
      'if p.get("networkIdle"):',
      '    kwargs["network_idle"] = True',
      'if not p.get("loadDom", True):',
      '    kwargs["load_dom"] = False',
      'if p.get("waitSelector"):',
      '    kwargs["wait_selector"] = p["waitSelector"]',
      'if p.get("waitSelectorState"):',
      '    kwargs["wait_selector_state"] = p["waitSelectorState"]',
      'if p.get("proxy"):',
      '    kwargs["proxy"] = p["proxy"]',
      'if p.get("blockedDomains"):',
      '    kwargs["blocked_domains"] = list(p["blockedDomains"])',
      'if p.get("retries") not in [None, 3]:',
      '    kwargs["retries"] = int(p["retries"])',
      'if p.get("retryDelay") not in [None, 1]:',
      '    kwargs["retry_delay"] = int(p["retryDelay"])',
      'if p.get("extraHeaders"):',
      '    kwargs["extra_headers"] = p["extraHeaders"]',
      'if p.get("disableResources", True):',
      '    kwargs["disable_resources"] = True',
      'if p.get("timeout") not in [None, 60]:',
      '    timeout_value = int(p["timeout"])',
      '    if mode in {"fetch", "stealthy_fetch"}:',
      '        kwargs["timeout"] = timeout_value * 1000',
      '    else:',
      '        kwargs["timeout"] = timeout_value',
      'if p.get("wait") not in [None, 0] and mode in {"fetch", "stealthy_fetch"}:',
      '    kwargs["wait"] = int(p["wait"])',
      'fetch_fn = {"get": get, "fetch": fetch, "stealthy_fetch": stealthy_fetch}[mode]',
      'page = fetch_fn(p["url"], **kwargs)',
      'if p.get("cssSelector"):',
      '    content = page.css(p["cssSelector"])',
      '    html_content = "\\n".join([str(el.html) for el in content])',
      'else:',
      '    html_content = page.html',
      'print(json.dumps({"html": html_content, "status": page.status, "url": page.url}))',
    ].join('\n');
    
    console.log(`[Scrapling Shell] Executing ${normalizedMode} for ${url}`);
    
    try {
      const startTime = Date.now();
      const result = this.exec(pythonCode, timeout);
      const elapsed = Date.now() - startTime;
      
      // Parse JSON response
      const data = JSON.parse(result);
      
      console.log(`[Scrapling Shell] Success in ${elapsed}ms`);
      
      return {
        ok: true,
        status: data.status || 200,
        html: data.html,
        url: data.url || url,
        scrapling: true,
        mode: 'shell',
        fetchMode: normalizedMode,
        elapsed
      };
      
    } catch (err) {
      if (err.message.includes('SyntaxError')) {
        console.error('[Scrapling Shell] Python syntax error');
      } else if (err.message.includes('json')) {
        console.error('[Scrapling Shell] Failed to parse JSON response');
      }
      throw err;
    }
  }
  
  /**
   * Quick methods
   */
  async get(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'get' });
  }
  
  async stealthyFetch(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'stealthy_fetch', solveCaptcha: true });
  }
  
  async dynamicFetch(url, options = {}) {
    return this.fetch(url, { ...options, mode: 'fetch' });
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

function normalizeMode(mode) {
  const normalized = String(mode || '').replace(/-/g, '_');
  if (normalized === 'get' || normalized === 'fetch' || normalized === 'stealthy_fetch') {
    return normalized;
  }
  return null;
}

// Singleton
let instance = null;

function getShell() {
  if (!instance) {
    instance = new ScraplingShell();
  }
  return instance;
}

module.exports = { getShell, ScraplingShell };
