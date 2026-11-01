'use strict';
/**
 * Windows packaging tests.
 *
 * The upstream suite (security/network/runtime/downloads/environments) is
 * POSIX-specific: it asserts 0700 file modes, shells out to `ps` and `sips`, and
 * drives a downloaded browser. This file covers the parts of the Windows build
 * that can be checked on any host without a browser: the extractor fallback
 * chain, release-asset matching, and the packaging rules.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractCommands, extractZip } = require('../electron/zip-extract');
const { installerNames, compare, pickInstaller } = require('../electron/update-assets');

// Minimal archive shaped like Playwright's chrome-win64 zip.
const CHROME_ZIP = Buffer.from(
  'UEsDBBQAAAAIAOGzYV17svjlFAAAABIAAAAXAAAAY2hyb21lLXdpbjY0L2Nocm9tZS5leGVLS8xO1U3OKMrPTdVNysxLLKoEAFBLAwQUAAAACADhs2Fdb/HNzQYAAAAEAAAAFwAAAGNocm9tZS13aW42NC9jaHJvbWUuZGxsS0vMTgUAUEsBAhQAFAAAAAgA4bNhXXuy+OUUAAAAEgAAABcAAAAAAAAAAAAAAIABAAAAAGNocm9tZS13aW42NC9jaHJvbWUuZXhlUEsBAhQAFAAAAAgA4bNhXW/xzc0GAAAABAAAABcAAAAAAAAAAAAAAIABSQAAAGNocm9tZS13aW42NC9jaHJvbWUuZGxsUEsFBgAAAAACAAIAigAAAIQAAAAAAA==',
  'base64',
);

test('Windows tries tar.exe, tar, unzip, then PowerShell Expand-Archive', () => {
  const cmds = extractCommands('C:\\tmp\\chrome.zip', 'C:\\tmp\\out', 'win32');
  assert.deepEqual(cmds.map(c => c[0]), ['tar.exe', 'tar', 'unzip', 'powershell.exe']);
  assert.deepEqual(cmds[0][1], ['-xf', 'C:\\tmp\\chrome.zip', '-C', 'C:\\tmp\\out']);
  // The PowerShell fallback has to survive paths with spaces and quotes.
  const script = cmds[3][1][cmds[3][1].length - 1];
  assert.equal(script, "Expand-Archive -LiteralPath 'C:\\tmp\\chrome.zip' -DestinationPath 'C:\\tmp\\out' -Force");
  const tricky = extractCommands("C:\\a b\\it's.zip", 'C:\\out', 'win32')[3][1].at(-1);
  assert.match(tricky, /-LiteralPath 'C:\\a b\\it''s\.zip'/);
});

test('POSIX hosts keep the single unzip path upstream used', () => {
  assert.deepEqual(extractCommands('/tmp/a.zip', '/tmp/out', 'darwin'), [['/usr/bin/unzip', ['-q', '-o', '/tmp/a.zip', '-d', '/tmp/out']]]);
  assert.deepEqual(extractCommands('/tmp/a.zip', '/tmp/out', 'linux'), [['unzip', ['-q', '-o', '/tmp/a.zip', '-d', '/tmp/out']]]);
});

test('extractZip unpacks a Chrome-for-Testing layout on this host', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-zip-test-'));
  try {
    const zip = path.join(dir, 'chrome.zip');
    fs.writeFileSync(zip, CHROME_ZIP);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await extractZip(zip, out);
    assert.equal(fs.readFileSync(path.join(out, 'chrome-win64', 'chrome.exe'), 'utf8'), 'fake-chrome-binary');
    assert.ok(fs.existsSync(path.join(out, 'chrome-win64', 'chrome.dll')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows update prefers the Setup exe and falls back to the portable zip', () => {
  assert.deepEqual(installerNames('0.7.0', 'win32'), ['CIKE-Setup-0.7.0-x64.exe', 'CIKE-0.7.0-win-x64.zip']);
  assert.deepEqual(installerNames('0.7.0', 'darwin'), ['CIKE-0.7.0-mac-arm64.dmg']);
  const assets = [
    { name: 'CIKE-0.7.0-mac-arm64.dmg' },
    { name: 'CIKE-0.7.0-win-x64.zip' },
    { name: 'CIKE-Setup-0.7.0-x64.exe' },
    { name: 'SHA256SUMS.txt' },
  ];
  assert.equal(pickInstaller(assets, '0.7.0', 'win32').name, 'CIKE-Setup-0.7.0-x64.exe');
  assert.equal(pickInstaller(assets.filter(a => !a.name.includes('Setup')), '0.7.0', 'win32').name, 'CIKE-0.7.0-win-x64.zip');
  assert.equal(pickInstaller(assets, '0.7.0', 'darwin').name, 'CIKE-0.7.0-mac-arm64.dmg');
  // Another platform shipping first is not an error: report "no asset".
  assert.equal(pickInstaller(assets, '0.7.0', 'linux'), null);
  assert.equal(pickInstaller([{ name: 'CIKE-0.9.0-win-x64.zip' }], '0.7.0', 'win32'), null);
  assert.equal(pickInstaller(null, '0.7.0', 'win32'), null);
});

test('version compare treats missing parts as zero', () => {
  assert.ok(compare('0.7.0', '0.7.1') < 0);
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.ok(compare('1.10.0', '1.9.9') > 0);
  assert.equal(compare('2', '2.0.0'), 0);
});

test('probeVersion reads the kernel version from the Windows install path', { skip: process.platform !== 'win32' }, async () => {
  const { probeVersion } = require('../electron/chromium');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-probe-'));
  try {
    const exe = path.join(dir, 'browsers', '156.0.8078.4-abc123', 'chrome-win64', 'chrome.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'MZ');
    // No process is started: the install path carries the version on Windows.
    assert.equal(await probeVersion(exe), '156.0.8078.4');
    assert.equal(await probeVersion(path.join(dir, 'missing', 'chrome.exe')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packaging excludes local profile data, kernels and interpreter tooling', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  for (const rule of ['!data/**', '!browsers/**', '!.browsers/**', '!**/*.zip', '!test/**', '!docs/**']) {
    assert.ok(cfg.includes(rule), `electron-builder.yml must exclude ${rule}`);
  }
  assert.match(cfg, /^asar: true$/m);
  assert.match(cfg, /^publish: null$/m);
  // Runtime assets that profileapp.js reads through __dirname must stay packed.
  assert.ok(!cfg.includes('icon.png'), 'electron/assets/icon.png is read at runtime');
});
