'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync, execFile } = require('child_process');
const execFileAsync = (...args) => new Promise((resolve, reject) => {
  execFile(...args, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
});

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// Persistent store (settings + history) — plain JSON file in userData.
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#0a84ff',
  savePath: path.join(os.homedir(), 'Downloads', 'yt-dlp'),
  concurrency: 2,
  filenameTemplate: '%(title)s.%(ext)s',
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'store.json');
    this.data = { settings: { ...DEFAULT_SETTINGS }, history: [] };
    this.load();
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      this.data.history = Array.isArray(parsed.history) ? parsed.history : [];
    } catch (e) {
      // No store yet or corrupted — start fresh.
    }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to persist store:', e);
    }
  }
  get settings() {
    return this.data.settings;
  }
  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
  get history() {
    return this.data.history;
  }
  addHistory(item) {
    this.data.history.unshift(item);
    this.save();
  }
  deleteHistory(id) {
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this.save();
  }
  clearHistory() {
    this.data.history = [];
    this.save();
  }
}

let store;

// ---------------------------------------------------------------------------
// Locating yt-dlp / ffmpeg
// ---------------------------------------------------------------------------
function bundledBinDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'resources', 'bin');
}

function findOnPath(name) {
  try {
    const cmd = isWin ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch (e) {
    return null;
  }
}

function resolveBinary(name) {
  const exeName = isWin ? `${name}.exe` : name;
  const bundled = path.join(bundledBinDir(), exeName);
  if (fs.existsSync(bundled)) return bundled;
  return findOnPath(exeName) || findOnPath(name);
}

let ytdlpPath = null;
let ffmpegPath = null;

function refreshBinaries() {
  ytdlpPath = resolveBinary('yt-dlp');
  ffmpegPath = resolveBinary('ffmpeg');
}

function getYtdlpVersion() {
  if (!ytdlpPath) return null;
  try {
    return execFileSync(ytdlpPath, ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download manager
// ---------------------------------------------------------------------------
const POSTPROCESS_LABELS = [
  [/^\[Merger\]/, 'Слияние потоков…'],
  [/^\[ExtractAudio\]/, 'Извлечение аудио…'],
  [/^\[EmbedSubtitle\]/, 'Встраивание субтитров…'],
  [/^\[SubtitlesConvertor\]/, 'Конвертация субтитров…'],
  [/^\[Metadata\]/, 'Запись метаданных…'],
  [/^\[VideoRemuxer\]/, 'Перекодирование контейнера…'],
  [/^\[FixupM3u8\]|^\[FixupM4a\]|^\[FixupTimestamp\]/, 'Постобработка…'],
];

class DownloadManager {
  constructor(sendToRenderer) {
    this.send = sendToRenderer;
    this.items = new Map(); // id -> item state
    this.procs = new Map(); // id -> ChildProcess
    this.pendingIds = [];
  }

  activeCount() {
    return this.procs.size;
  }

  concurrency() {
    return Math.max(1, Math.min(5, store.settings.concurrency || 2));
  }

  createItems(payload) {
    const { urls, format, quality, subtitles, filenameTemplate, savePath } = payload;
    const created = [];
    for (const url of urls) {
      const id = 'q' + Math.random().toString(36).slice(2, 10);
      let host = 'видео';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch (e) {}
      const item = {
        id,
        url,
        format,
        quality,
        subtitles: subtitles || null,
        filenameTemplate,
        savePath,
        name: (format === 'audio' ? 'Аудио · ' : 'Видео · ') + host,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        eta: null,
        status: 'queued', // queued | downloading | paused | error
        statusText: 'В очереди…',
      };
      this.items.set(id, item);
      this.pendingIds.push(id);
      created.push(item);
    }
    this.schedule();
    return created;
  }

  schedule() {
    while (this.activeCount() < this.concurrency() && this.pendingIds.length > 0) {
      const id = this.pendingIds.shift();
      const item = this.items.get(id);
      if (!item || item.status === 'cancelled') continue;
      this.startProcess(id);
    }
  }

  buildArgs(item) {
    const outDir = expandHome(item.savePath || store.settings.savePath);
    const outTemplate = path.join(outDir, item.filenameTemplate || store.settings.filenameTemplate || '%(title)s.%(ext)s');
    const ffmpegAvailable = !!ffmpegPath;

    const args = [
      '--newline',
      '--no-color',
      '--no-mtime',
      '--progress-template',
      'download:DLPROG %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
      '-o', outTemplate,
      '--continue',
    ];

    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);

    if (item.format === 'audio') {
      args.push('-x', '--audio-format', 'mp3');
      args.push('--audio-quality', item.quality === 'best' ? '0' : `${item.quality}K`);
    } else {
      const heightFilter = item.quality !== 'best' ? `[height<=${item.quality}]` : '';
      if (ffmpegAvailable) {
        args.push('-f', `bv*${heightFilter}+ba/b${heightFilter}`);
        args.push('--merge-output-format', 'mp4');
      } else {
        args.push('-f', `b${heightFilter}`);
      }
    }

    if (item.subtitles) {
      args.push('--write-subs', '--write-auto-subs');
      if (item.subtitles !== 'auto') args.push('--sub-langs', item.subtitles);
      if (item.format === 'video' && ffmpegAvailable) args.push('--embed-subs');
    }

    args.push(item.url);
    return args;
  }

  startProcess(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (!ytdlpPath) {
      item.status = 'error';
      item.statusText = 'yt-dlp не найден';
      this.send('queue-update', { id, patch: { status: item.status, statusText: item.statusText } });
      this.settleFailed(id);
      return;
    }

    fs.mkdirSync(expandHome(item.savePath || store.settings.savePath), { recursive: true });

    const args = this.buildArgs(item);
    const child = spawn(ytdlpPath, args, { windowsHide: true });
    this.procs.set(id, child);
    item.status = 'downloading';
    item.statusText = 'Загрузка…';
    this.send('queue-update', { id, patch: { status: item.status, statusText: item.statusText } });

    let stderrTail = '';
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) this.handleLine(id, line);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.on('close', (code, signal) => {
      this.procs.delete(id);
      const cur = this.items.get(id);
      if (!cur) return;
      if (cur.status === 'paused' || cur.status === 'cancelled') {
        // Intentional stop — do nothing further here.
      } else if (code === 0) {
        this.finishItem(id);
      } else {
        cur.status = 'error';
        cur.statusText = 'Ошибка загрузки';
        this.send('queue-update', { id, patch: { status: cur.status, statusText: cur.statusText, error: stderrTail.trim().slice(-500) } });
      }
      this.schedule();
    });
    child.on('error', () => {
      this.procs.delete(id);
      const cur = this.items.get(id);
      if (cur) {
        cur.status = 'error';
        cur.statusText = 'Не удалось запустить yt-dlp';
        this.send('queue-update', { id, patch: { status: cur.status, statusText: cur.statusText } });
      }
      this.schedule();
    });
  }

  handleLine(id, line) {
    const item = this.items.get(id);
    if (!item) return;
    if (line.startsWith('DLPROG ')) {
      const parts = line.slice(7).trim().split(' ');
      const [status, downloadedS, totalS, totalEstS, speedS, etaS] = parts;
      const num = (s) => (s && s !== 'NA' ? parseFloat(s) : null);
      const downloaded = num(downloadedS) || 0;
      const total = num(totalS) || num(totalEstS) || 0;
      const speed = num(speedS);
      const eta = num(etaS);
      const progress = total > 0 ? Math.min(100, (downloaded / total) * 100) : item.progress;
      Object.assign(item, {
        progress,
        downloadedBytes: downloaded,
        totalBytes: total,
        speedBps: speed || 0,
        eta,
        statusText: status === 'finished' ? 'Обработка…' : 'Загрузка…',
      });
      this.send('queue-update', {
        id,
        patch: { progress: item.progress, speedBps: item.speedBps, eta: item.eta, statusText: item.statusText, status: item.status },
      });
      return;
    }
    for (const [re, label] of POSTPROCESS_LABELS) {
      if (re.test(line)) {
        item.statusText = label;
        this.send('queue-update', { id, patch: { statusText: label } });
        return;
      }
    }
    const destMatch = line.match(/^\[download\] Destination: (.+)$/) || line.match(/Merging formats into "(.+)"$/);
    if (destMatch) {
      item.finalPath = destMatch[1];
    }
  }

  finishItem(id) {
    const item = this.items.get(id);
    if (!item) return;
    let sizeBytes = item.totalBytes;
    try {
      if (item.finalPath && fs.existsSync(item.finalPath)) {
        sizeBytes = fs.statSync(item.finalPath).size;
      }
    } catch (e) {}
    const histItem = {
      id: 'h' + Math.random().toString(36).slice(2, 10),
      name: item.name,
      format: item.format,
      qualityLabel: item.quality,
      path: item.finalPath || null,
      sizeBytes,
      date: new Date().toISOString(),
    };
    store.addHistory(histItem);
    this.items.delete(id);
    this.send('queue-remove', { id });
    this.send('history-add', { item: histItem });
  }

  settleFailed(id) {
    this.items.delete(id);
  }

  togglePause(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === 'paused') {
      item.status = 'queued';
      item.statusText = 'Возобновление…';
      this.pendingIds.push(id);
      this.send('queue-update', { id, patch: { status: item.status, statusText: item.statusText } });
      this.schedule();
    } else {
      item.status = 'paused';
      item.statusText = 'На паузе';
      const proc = this.procs.get(id);
      if (proc) proc.kill();
      this.pendingIds = this.pendingIds.filter((x) => x !== id);
      this.send('queue-update', { id, patch: { status: item.status, statusText: item.statusText } });
    }
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    item.status = 'cancelled';
    const proc = this.procs.get(id);
    if (proc) proc.kill();
    this.pendingIds = this.pendingIds.filter((x) => x !== id);
    this.items.delete(id);
    this.send('queue-remove', { id });
    this.schedule();
  }

  pauseAll() {
    for (const id of this.items.keys()) {
      const item = this.items.get(id);
      if (item.status === 'downloading' || item.status === 'queued') this.togglePause(id);
    }
  }
  resumeAll() {
    for (const id of this.items.keys()) {
      const item = this.items.get(id);
      if (item.status === 'paused') this.togglePause(id);
    }
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;
let downloadManager = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('window-action', (e, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
  });

  ipcMain.handle('get-init-data', () => {
    refreshBinaries();
    return {
      settings: store.settings,
      history: store.history,
      bin: {
        ytdlp: { found: !!ytdlpPath, path: ytdlpPath, version: getYtdlpVersion() },
        ffmpeg: { found: !!ffmpegPath, path: ffmpegPath },
      },
      platform: process.platform,
    };
  });

  ipcMain.handle('choose-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('open-path', (e, targetPath) => {
    if (targetPath) shell.showItemInFolder(targetPath);
  });

  ipcMain.handle('save-settings', (e, patch) => {
    const settings = store.setSettings(patch);
    if ('concurrency' in patch) downloadManager.schedule();
    return settings;
  });

  ipcMain.handle('start-download', (e, payload) => downloadManager.createItems(payload));
  ipcMain.handle('toggle-pause', (e, id) => downloadManager.togglePause(id));
  ipcMain.handle('cancel-item', (e, id) => downloadManager.cancel(id));
  ipcMain.handle('pause-all', () => downloadManager.pauseAll());
  ipcMain.handle('resume-all', () => downloadManager.resumeAll());

  ipcMain.handle('clear-history', () => store.clearHistory());
  ipcMain.handle('delete-history-item', (e, id) => store.deleteHistory(id));

  ipcMain.handle('check-ytdlp-update', async () => {
    refreshBinaries();
    if (!ytdlpPath) return { ok: false, message: 'yt-dlp не найден' };
    const before = getYtdlpVersion();
    try {
      const out = await execFileAsync(ytdlpPath, ['-U'], { encoding: 'utf8', timeout: 30000 });
      const after = getYtdlpVersion();
      if (/up to date|already.*latest/i.test(out)) {
        return { ok: true, message: `Установлена последняя версия · ${after || before}` };
      }
      if (/error|permission/i.test(out)) {
        return { ok: false, message: 'Не удалось обновить: нет прав на запись' };
      }
      return { ok: true, message: `Обновлено до версии ${after || '?'}` };
    } catch (err) {
      return { ok: false, message: `Установленная версия: ${before || 'неизвестна'}` };
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    store = new Store();
    refreshBinaries();
    downloadManager = new DownloadManager(sendToRenderer);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
