// Downloads a platform-specific yt-dlp binary into resources/bin/ so it can be
// bundled into the packaged app via electron-builder's extraResources.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const ASSET_BY_PLATFORM = {
  win: { name: 'yt-dlp.exe', out: 'yt-dlp.exe' },
  linux: { name: 'yt-dlp', out: 'yt-dlp' },
  mac: { name: 'yt-dlp_macos', out: 'yt-dlp' },
};

const platformArg = process.argv[2] || (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux');
const asset = ASSET_BY_PLATFORM[platformArg];
if (!asset) {
  console.error(`Unknown platform "${platformArg}". Use one of: ${Object.keys(ASSET_BY_PLATFORM).join(', ')}`);
  process.exit(1);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset.name}`;
const outDir = path.join(__dirname, '..', 'resources', 'bin');
const outFile = path.join(outDir, asset.out);

fs.mkdirSync(outDir, { recursive: true });

function download(u, redirectsLeft) {
  https.get(u, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      if (redirectsLeft <= 0) {
        console.error('Too many redirects');
        process.exit(1);
      }
      res.resume();
      download(res.headers.location, redirectsLeft - 1);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`Download failed: HTTP ${res.statusCode} for ${u}`);
      process.exit(1);
    }
    const file = fs.createWriteStream(outFile, { mode: 0o755 });
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        fs.chmodSync(outFile, 0o755);
        console.log(`Saved ${asset.out} -> ${outFile}`);
      });
    });
  }).on('error', (err) => {
    console.error('Download error:', err.message);
    process.exit(1);
  });
}

console.log(`Fetching ${asset.name} for platform "${platformArg}"...`);
download(url, 5);
