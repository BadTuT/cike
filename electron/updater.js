'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { app, shell } = require('electron');
const { installerNames, compare, pickInstaller } = require('./update-assets');

// Release repository that publishes the installers. Override with
// LFB_UPDATE_REPO=owner/name when building your own distribution line, so a
// self-hosted Windows build checks its own releases instead of upstream's.
const REPO = process.env.LFB_UPDATE_REPO || 'chainfix/cike';

function get(url, file) {
  return new Promise((resolve, reject) => {
    const out = file && fs.createWriteStream(file);
    https.get(url, { headers: { 'User-Agent': 'CIKE', Accept: 'application/vnd.github+json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { out?.close(); if (file) fs.rmSync(file, { force: true }); return get(res.headers.location, file).then(resolve, reject); }
      if (res.statusCode !== 200) { out?.close(); if (file) fs.rmSync(file, { force: true }); return reject(new Error(`更新服务器返回 ${res.statusCode}`)); }
      if (!out) { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString())); }
      else { res.on('data', c => out.bytes = (out.bytes || 0) + c.length); res.pipe(out); out.on('finish', () => resolve()); }
    }).on('error', reject).setTimeout(120000, function () { this.destroy(new Error('检查更新超时')); });
  });
}

/** Files that accompany an installer asset as the checksum manifest. */
function supportsInPlaceInstall() {
  return process.platform === 'darwin' && process.arch === 'arm64' && app.isPackaged;
}

async function checkUpdate() {
  const current = app.getVersion();
  const release = JSON.parse(await get(`https://api.github.com/repos/${REPO}/releases/latest`));
  const version = release.tag_name?.replace(/^v/, '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('更新版本格式无效');
  const installer = pickInstaller(release.assets, version);
  const sums = release.assets?.find(a => a.name === 'SHA256SUMS.txt') || null;
  // A release without an asset for this platform is not an error: another
  // platform may have shipped first. Report it and let the UI explain.
  return {
    current,
    latest: version,
    available: compare(version, current) > 0,
    url: release.html_url,
    installerUrl: installer?.browser_download_url || null,
    installerName: installer?.name || null,
    checksumUrl: sums?.browser_download_url || null,
    inPlace: supportsInPlaceInstall(),
    dmgUrl: installer?.browser_download_url || null,
  };
}

async function installUpdate() {
  const info = await checkUpdate();
  if (!info.available) return info;
  if (process.platform === 'win32') {
    // Windows builds are unsigned and unpacked into a user-chosen folder, so an
    // in-place swap would fight SmartScreen and the installer. Send the user to
    // the release page instead; replacing the folder keeps profile data intact.
    if (!info.installerUrl) throw new Error('该版本没有发布 Windows 安装包');
    await shell.openExternal(info.url);
    return { ...info, manual: true, message: '已在浏览器打开发布页：下载 Setup 安装包或 zip 覆盖当前目录后重启' };
  }
  if (!supportsInPlaceInstall()) throw new Error('在线更新仅支持已安装的 Apple 芯片版 CIKE');
  if (!info.installerUrl || !info.checksumUrl) throw new Error('该版本未提供可自动安装的安装包或校验文件');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-update-'));
  const dmg = path.join(dir, 'update.dmg');
  const expected = (await get(info.checksumUrl)).match(/^([a-f0-9]{64})\s+CIKE-[0-9.]+-mac-arm64\.dmg$/m)?.[1];
  if (!expected) throw new Error('更新校验文件无效');
  await get(info.installerUrl, dmg);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  if (actual !== expected) throw new Error('更新文件校验失败');
  const mount = path.join(dir, 'mount');
  fs.mkdirSync(mount);
  await new Promise((resolve, reject) => execFile('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], e => e ? reject(new Error('无法打开更新镜像')) : resolve()));
  const source = path.join(mount, 'CIKE.app');
  if (!fs.existsSync(source)) throw new Error('更新镜像中缺少 CIKE');
  const target = '/Applications/CIKE.app';
  const staging = '/Applications/CIKE.app.update';
  const script = `rm -rf ${JSON.stringify(staging)} && cp -R ${JSON.stringify(source)} ${JSON.stringify(staging)} && rm -rf ${JSON.stringify(target)} && mv ${JSON.stringify(staging)} ${JSON.stringify(target)}`;
  await new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`], e => e ? reject(new Error('更新安装已取消或权限不足')) : resolve()));
  app.relaunch({ execPath: path.join(target, 'Contents/MacOS/CIKE') });
  app.exit(0);
}
module.exports = { checkUpdate, installUpdate, REPO };
