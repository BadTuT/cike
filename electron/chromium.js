'use strict';
/**
 * Chromium kernel installer.
 *
 * Downloads the Playwright-pinned builds/cft archive over HTTPS, unpacks it with
 * a per-platform extractor (see zip-extract.js), verifies the executable and
 * records the executable path in:
 *   <dataDir>/browsers/chromium-executable.txt
 *
 * Fully self-contained: does not depend on Playwright's internal layout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const exec = promisify(execFile);
const { privateDirectory, writePrivate } = require('../src/privatefiles');
const { extractZip } = require('./zip-extract');
const inProgress = new Map();
function chromiumEntry() {
  const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  return JSON.parse(fs.readFileSync(file)).browsers.find(b => b.name === 'chromium');
}
function cftPlatform() {
  const platform = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error('不支持此平台的 Chromium 下载');
  return platform;
}
function downloadUrl() {
  const host = process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://cdn.playwright.dev';
  const platform = cftPlatform();
  return `${host}/builds/cft/${chromiumEntry().browserVersion}/${platform}/chrome-${platform}.zip`;
}
function browserRoot(dir) { return path.join(dir, 'browsers'); }
function executableMarker(dir) { return path.join(browserRoot(dir), 'chromium-executable.txt'); }

/** Shell-quote a path for a single-quoted PowerShell string literal. */
const psQuote = (p) => `'${String(p).replace(/'/g, "''")}'`;

/**
 * Version of the unpacked kernel.
 *
 * macOS and Linux builds print "Chromium <version>" for --version. Windows
 * chrome.exe is a GUI-subsystem binary: it writes nothing to stdout, and
 * running it for a version probe can start a browser window. So on Windows the
 * version is taken from the install path we created
 * (<dataDir>/browsers/<version>-<suffix>/chrome-win64/chrome.exe), with the PE
 * version resource as the fallback for a hand-placed executable.
 */
async function probeVersion(executable) {
  if (!executable || !fs.existsSync(executable)) return null;
  if (process.platform === 'win32') {
    const fromPath = executable.match(/(\d+\.\d+\.\d+\.\d+)-[^\\/]+[\\/][^\\/]+[\\/]chrome\.exe$/i);
    if (fromPath) return fromPath[1];
    try {
      const script = `(Get-Item -LiteralPath ${psQuote(executable)}).VersionInfo.ProductVersion`;
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true, maxBuffer: 65536 });
      const version = String(stdout).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      if (version) return version;
    } catch { /* fall through: unknown version */ }
    return null;
  }
  try {
    const { stdout } = await exec(executable, ['--version'], { timeout: 10000 });
    return String(stdout).match(/\d+\.\d+\.\d+\.\d+/)?.[0] || null;
  } catch {
    return null;
  }
}

async function chromiumStatus(dir) {
  const targetVersion = chromiumEntry().browserVersion;
  try {
    const executable = fs.readFileSync(executableMarker(dir), 'utf8').trim();
    const version = await probeVersion(executable);
    if (version) return { installed: true, executable, version, targetVersion, updateAvailable: version !== targetVersion };
  } catch { /* not installed or unusable */ }
  return { installed: false, executable: null, version: null, targetVersion, updateAvailable: true };
}
async function downloadFile(url, dest, onProgress, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('内核下载必须使用 HTTPS，且不能无限重定向');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CIKE' } }, resolve);
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('内核下载超时')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadFile(new URL(response.headers.location, url).href, dest, onProgress, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`内核下载失败：HTTP ${response.statusCode}`); }
  const total = Number(response.headers['content-length']) || 0;
  let done = 0;
  response.on('data', chunk => {
    done += chunk.length;
    if (done > 1024 * 1024 * 1024) response.destroy(new Error('内核安装包异常过大'));
    onProgress?.({ done, total, pct: total ? Math.round(done / total * 100) : 0 });
  });
  await pipeline(response, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
}
function findExecutable(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        return path.join(macos, fs.readdirSync(macos).find(n => !n.startsWith('.')));
      }
      const found = findExecutable(full); if (found) return found;
    } else if (e.isFile() && ((process.platform === 'linux' && e.name === 'chrome') || (process.platform === 'win32' && e.name === 'chrome.exe'))) return full;
  }
  return null;
}
async function install(dir, onProgress) {
  const status = await chromiumStatus(dir);
  if (status.installed && !status.updateAvailable) return status.executable;
  privateDirectory(browserRoot(dir));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-chromium-'));
  const staging = fs.mkdtempSync(path.join(browserRoot(dir), '.install-'));
  try {
    const zip = path.join(tmp, 'chromium.zip');
    await downloadFile(downloadUrl(), zip, onProgress);
    await extractZip(zip, staging);
    const executable = findExecutable(staging);
    if (!executable) throw new Error('安装包中没有 Chromium');
    // Playwright's CfT archive may omit bundle resource seals. Do not repair
    // that by re-signing locally or claim Developer ID validation: transport
    // trust is HTTPS to the configured CDN, followed by a version check.
    const destination = path.join(browserRoot(dir), `${chromiumEntry().browserVersion}-${path.basename(staging).slice(9)}`);
    const relative = path.relative(staging, executable);
    fs.renameSync(staging, destination);
    const final = path.join(destination, relative);
    // Verify the version from the final path: on Windows this reads the
    // directory name, on macOS/Linux it runs --version on the unpacked binary.
    const version = await probeVersion(final);
    if (version !== chromiumEntry().browserVersion) {
      // Never leave an unverified kernel behind: the next start would fail
      // the same check and the size on disk would grow with every retry.
      fs.rmSync(destination, { recursive: true, force: true });
      throw new Error('下载的内核版本不匹配');
    }
    // Keep the downloaded bundle unchanged, including its icon. Old
    // kernels remain available until the new version is fully verified.
    writePrivate(executableMarker(dir), final + '\n');
    onProgress?.({ done: 1, total: 1, pct: 100 });
    return final;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
async function downloadChromium(dir, onProgress) {
  if (inProgress.has(dir)) return inProgress.get(dir);
  const promise = install(dir, onProgress);
  inProgress.set(dir, promise);
  try { return await promise; } finally { inProgress.delete(dir); }
}
module.exports = { chromiumStatus, downloadChromium, downloadUrl, executableMarker, browserRoot, probeVersion };
