'use strict';
/**
 * Pure helpers for the release check: no Electron dependency, so the Windows
 * build can unit-test asset matching without booting the app.
 */

/** Candidate asset names for a platform, in preference order. */
function installerNames(version, platform = process.platform) {
  if (platform === 'win32') {
    return [`CIKE-Setup-${version}-x64.exe`, `CIKE-${version}-win-x64.zip`];
  }
  if (platform === 'darwin') {
    return [`CIKE-${version}-mac-arm64.dmg`];
  }
  // No published installer for this platform: an empty list makes the update
  // check report "no asset" instead of offering another platform's download.
  return [];
}

/** Semver-ish compare for x.y.z, tolerant of missing parts. */
function compare(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Pick the installer asset published for this platform, or null. */
function pickInstaller(assets, version, platform = process.platform) {
  const names = installerNames(version, platform);
  for (const name of names) {
    const hit = (assets || []).find(a => a.name === name);
    if (hit) return hit;
  }
  return null;
}

module.exports = { installerNames, compare, pickInstaller };
