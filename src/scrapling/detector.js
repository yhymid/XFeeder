// src/scrapling/detector.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class ScraplingDetector {
  constructor() {
    this.available = false;
    this.version = null;
    this.hasShell = false;
    this.hasExtract = false;
    this.hasMCP = false;
    this.pythonPath = null;
    this.scraplingPath = null;
    
    this.detect();
  }

  detect() {
    console.log('[Scrapling] Detecting installation...');
    
    try {
      // Check Python
      this.pythonPath = this.findPython();
      if (!this.pythonPath) {
        console.warn('[Scrapling] Python not found');
        return;
      }
      
      // Check Scrapling installation
      const versionOutput = execSync(`${this.pythonPath} -m scrapling --version`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      
      this.available = true;
      this.version = versionOutput.replace('scrapling', '').trim();
      this.validateVersion();
      
      // Find scrapling executable
      try {
        this.scraplingPath = execSync('which scrapling || where scrapling', {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim().split('\n')[0];
      } catch {
        // Fallback to python -m
        this.scraplingPath = `${this.pythonPath} -m scrapling`;
      }
      
      // Check available features
      this.checkFeatures();
      
      console.log(`[Scrapling] Detected version ${this.version}`);
      console.log(`[Scrapling] Path: ${this.scraplingPath}`);
      if (this.hasShell) console.log('[Scrapling] Shell support: ✓');
      if (this.hasExtract) console.log('[Scrapling] Extract support: ✓');
      if (this.hasMCP) console.log('[Scrapling] MCP support: ✓');
      
    } catch (err) {
      console.log('[Scrapling] Not installed or not available');
      console.log('[Scrapling] Install: pip install "scrapling[all]" && scrapling install');
    }
  }

  validateVersion() {
    const minimum = [0, 4, 0];
    const current = parseVersion(this.version);
    if (!current) {
      console.warn(`[Scrapling] Could not parse version "${this.version}". Recommended: >=0.4.0`);
      return;
    }

    if (compareVersions(current, minimum) < 0) {
      console.warn(`[Scrapling] Version ${this.version} detected. Recommended: >=0.4.0 for full compatibility.`);
    }
  }
  
  findPython() {
    const candidates = ['python3', 'python', 'py'];
    for (const cmd of candidates) {
      try {
        const version = execSync(`${cmd} --version`, {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        if (version.includes('Python')) {
          return cmd;
        }
      } catch {}
    }
    return null;
  }
  
  checkFeatures() {
    // Check shell support
    try {
      execSync(`${this.scraplingPath} shell --help`, {
        timeout: 3000,
        stdio: ['ignore', 'ignore', 'ignore']
      });
      this.hasShell = true;
    } catch {}
    
    // Check extract support
    try {
      execSync(`${this.scraplingPath} extract --help`, {
        timeout: 3000,
        stdio: ['ignore', 'ignore', 'ignore']
      });
      this.hasExtract = true;
    } catch {}
    
    // Check MCP support
    try {
      execSync(`${this.scraplingPath} mcp --help`, {
        timeout: 3000,
        stdio: ['ignore', 'ignore', 'ignore']
      });
      this.hasMCP = true;
    } catch {}
  }
  
  requireFeature(feature) {
    if (!this.available) {
      throw new Error('Scrapling not available. Install: pip install "scrapling[all]" && scrapling install');
    }
    
    if (feature === 'shell' && !this.hasShell) {
      throw new Error('Scrapling shell not available. Install: pip install "scrapling[shell]"');
    }
    
    if (feature === 'extract' && !this.hasExtract) {
      throw new Error('Scrapling extract not available. Install: pip install "scrapling[shell]"');
    }
    
    if (feature === 'mcp' && !this.hasMCP) {
      throw new Error('Scrapling MCP not available. Install: pip install "scrapling[ai]"');
    }
  }
}

function parseVersion(input) {
  const match = String(input || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// Singleton
let instance = null;

function getDetector() {
  if (!instance) {
    instance = new ScraplingDetector();
  }
  return instance;
}

module.exports = { getDetector, ScraplingDetector };
