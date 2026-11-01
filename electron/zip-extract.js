'use strict';
/**
 * Zip extraction without a bundled unzip binary.
 *
 * macOS ships /usr/bin/unzip, most Linux distributions ship unzip, and Windows
 * has neither — Windows 10 1803+ ships bsdtar (libarchive) as System32\tar.exe,
 * and every supported Windows image also has PowerShell's Expand-Archive as a
 * last resort. Each candidate is tried in turn and the first success wins, so a
 * locked-down PATH or a missing tar.exe still installs the browser kernel.
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

/** Command lines that can unpack a zip on this platform, in preference order. */
function extractCommands(zipPath, destDir, platform = process.platform) {
  if (platform === 'win32') {
    const psQuote = (p) => `'${p.replace(/'/g, "''")}'`;
    return [
      ['tar.exe', ['-xf', zipPath, '-C', destDir]],
      ['tar', ['-xf', zipPath, '-C', destDir]],
      ['unzip', ['-q', '-o', zipPath, '-d', destDir]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`]],
    ];
  }
  const unzipBin = platform === 'darwin' ? '/usr/bin/unzip' : 'unzip';
  return [[unzipBin, ['-q', '-o', zipPath, '-d', destDir]]];
}

async function extractZip(zipPath, destDir) {
  const errors = [];
  for (const [cmd, args] of extractCommands(zipPath, destDir)) {
    try {
      await exec(cmd, args, { timeout: 600000, windowsHide: true, maxBuffer: 65536 });
      return cmd;
    } catch (err) {
      const reason = String(err.stderr || err.message).trim().split('\n')[0];
      errors.push(`${path.basename(cmd)}: ${reason}`);
    }
  }
  throw new Error(`内核解压失败（已尝试 ${errors.length} 种解压器）：${errors.join(' | ')}`);
}

module.exports = { extractCommands, extractZip };
