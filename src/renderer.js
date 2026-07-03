'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  theme: 'dark',
  accent: '#0a84ff',
  activeNav: 'download',

  format: 'video',
  quality: 'best',
  subtitlesOn: false,
  subtitleLang: 'auto',
  playlistOn: false,
  urlText: '',

  savePath: '~/Downloads/yt-dlp',
  tempPath: '',
  showPathModal: false,

  concurrency: 2,
  filenameTemplate: '%(title)s.%(ext)s',

  queue: [],
  history: [],
  toasts: [],

  ytdlpVersionChecking: false,
  ytdlpVersionMsg: '',
  bin: { ytdlp: { found: false, version: null }, ffmpeg: { found: false } },
};

let idCounter = 1;
const toastTimers = {};

const ACCENT_OPTIONS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#30d158'];

const VIDEO_QUALITIES = [
  { value: 'best', label: 'Лучшее качество' },
  { value: '2160', label: '4K · 2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
];
const AUDIO_QUALITIES = [
  { value: 'best', label: 'Лучшее (VBR)' },
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '128', label: '128 kbps' },
];
const SUBTITLE_LANGS = [
  { value: 'auto', label: 'Авто' },
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'zh', label: '中文' },
];
const PATH_PRESETS = [
  { label: 'Загрузки', path: '~/Downloads/yt-dlp' },
  { label: 'Видео', path: '~/Videos/yt-dlp' },
  { label: 'Музыка', path: '~/Music/yt-dlp' },
  { label: 'Рабочий стол', path: '~/Desktop' },
];

function getQualityLabel(format, value) {
  const list = format === 'audio' ? AUDIO_QUALITIES : VIDEO_QUALITIES;
  const found = list.find((q) => q.value === value);
  return found ? found.label : value;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  const mb = bps / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' МБ/с';
  return (bps / 1024).toFixed(0) + ' КБ/с';
}
function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' ГБ';
  return mb.toFixed(0) + ' МБ';
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function pushToast(text) {
  const id = 't' + idCounter++;
  state.toasts.push({ id, text });
  renderToasts();
  toastTimers[id] = setTimeout(() => dismissToast(id), 3200);
}
function dismissToast(id) {
  state.toasts = state.toasts.filter((t) => t.id !== id);
  clearTimeout(toastTimers[id]);
  delete toastTimers[id];
  renderToasts();
}
function renderToasts() {
  const root = document.getElementById('toasts');
  root.innerHTML = '';
  for (const t of state.toasts) {
    root.appendChild(el('div', { class: 'toast', onclick: () => dismissToast(t.id) }, el('span', { text: t.text })));
  }
}

// ---------------------------------------------------------------------------
// Titlebar / theme
// ---------------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  document.documentElement.style.setProperty('--accent', state.accent);
  const toggle = document.getElementById('theme-toggle');
  toggle.classList.toggle('on', state.theme === 'light');
  toggle.querySelector('.knob').style.left = state.theme === 'light' ? '22px' : '2px';
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  window.api.saveSettings({ theme: state.theme });
});
document.getElementById('btn-close').addEventListener('click', () => window.api.windowAction('close'));
document.getElementById('btn-min').addEventListener('click', () => window.api.windowAction('minimize'));
document.getElementById('btn-max').addEventListener('click', () => window.api.windowAction('maximize'));

document.body.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-external]');
  if (a) {
    e.preventDefault();
    window.open(a.href, '_blank');
  }
});

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
const NAV_DEFS = [
  { key: 'download', label: 'Загрузка' },
  { key: 'queue', label: 'Очередь' },
  { key: 'history', label: 'История' },
  { key: 'settings', label: 'Настройки' },
];

function renderNav() {
  const root = document.getElementById('nav-list');
  root.innerHTML = '';
  for (const n of NAV_DEFS) {
    const active = n.key === state.activeNav;
    const btn = el('button', {
      class: 'nav-btn' + (active ? ' active' : ''),
      onclick: () => { state.activeNav = n.key; render(); },
    });
    btn.appendChild(el('span', { class: 'label', text: n.label }));
    if (n.key === 'queue' && state.queue.length > 0) {
      btn.appendChild(el('span', { class: 'badge', text: String(state.queue.length) }));
    }
    root.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Download view
// ---------------------------------------------------------------------------
function renderDownloadView() {
  const view = el('div', { class: 'view' });

  view.appendChild(el('div', { class: 'view-header' }, [
    el('div', { class: 'title', text: 'Новая загрузка' }),
    el('div', { class: 'subtitle', text: 'Вставьте ссылку с YouTube или другого сайта, поддерживаемого yt-dlp' }),
  ]));

  const lineCount = state.urlText.split('\n').map((x) => x.trim()).filter(Boolean).length;
  const parsedCountText = state.playlistOn && lineCount > 0 ? 'Найдено ссылок: ' + lineCount : '';

  const urlField = el('div', { class: 'field' });
  const hintSpan = el('span', { class: 'hint', text: parsedCountText });
  urlField.appendChild(el('div', { class: 'field-label-row' }, [
    el('label', { text: 'Ссылка на видео' }),
    hintSpan,
  ]));
  const urlRow = el('div', { class: 'url-row' });
  if (state.playlistOn) {
    const ta = el('textarea', { class: 'input', rows: '4', placeholder: 'По одной ссылке на строку…' });
    ta.value = state.urlText;
    ta.addEventListener('input', () => {
      state.urlText = ta.value;
      const n = state.urlText.split('\n').map((x) => x.trim()).filter(Boolean).length;
      hintSpan.textContent = n > 0 ? 'Найдено ссылок: ' + n : '';
    });
    urlRow.appendChild(ta);
  } else {
    const inp = el('input', { class: 'input', placeholder: 'https://www.youtube.com/watch?v=…' });
    inp.value = state.urlText;
    inp.addEventListener('input', () => { state.urlText = inp.value; });
    urlRow.appendChild(inp);
  }
  urlRow.appendChild(el('button', {
    class: 'btn-ghost',
    title: 'Вставить из буфера',
    onclick: async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch (e) {}
      if (!text || !text.trim()) { pushToast('Буфер обмена пуст'); return; }
      state.urlText = state.playlistOn ? (state.urlText ? state.urlText + '\n' + text.trim() : text.trim()) : text.trim();
      renderContent();
    },
  }, el('span', { text: 'Вставить' })));
  urlField.appendChild(urlRow);
  view.appendChild(urlField);

  const fmtField = el('div', { class: 'field' });
  fmtField.appendChild(el('label', { text: 'Формат' }));
  const fmtRow = el('div', { class: 'format-row' });
  for (const f of [{ key: 'video', label: 'Видео' }, { key: 'audio', label: 'Аудио' }]) {
    fmtRow.appendChild(el('button', {
      class: 'format-btn' + (state.format === f.key ? ' active' : ''),
      onclick: () => { state.format = f.key; state.quality = 'best'; renderContent(); },
    }, el('span', { text: f.label })));
  }
  fmtField.appendChild(fmtRow);

  const qualities = state.format === 'audio' ? AUDIO_QUALITIES : VIDEO_QUALITIES;
  const select = el('select', { class: 'input' });
  for (const q of qualities) {
    const opt = el('option', { value: q.value, text: q.label });
    if (q.value === state.quality) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => { state.quality = select.value; });
  fmtField.appendChild(select);
  view.appendChild(fmtField);

  // Options panel: subtitles + playlist
  const panel = el('div', { class: 'panel' });
  const subsRow = el('div', { class: 'row-between' }, [
    el('div', {}, [
      el('div', { class: 'row-title', text: 'Субтитры' }),
      el('div', { class: 'row-desc', text: 'Скачать и встроить субтитры' }),
    ]),
    makeSwitch(state.subtitlesOn, () => { state.subtitlesOn = !state.subtitlesOn; renderContent(); }),
  ]);
  panel.appendChild(subsRow);
  if (state.subtitlesOn) {
    const langSelect = el('select', { class: 'input' });
    for (const l of SUBTITLE_LANGS) {
      const opt = el('option', { value: l.value, text: l.label });
      if (l.value === state.subtitleLang) opt.selected = true;
      langSelect.appendChild(opt);
    }
    langSelect.addEventListener('change', () => { state.subtitleLang = langSelect.value; });
    panel.appendChild(langSelect);
  }
  panel.appendChild(el('div', { class: 'hr' }));
  panel.appendChild(el('div', { class: 'row-between' }, [
    el('div', {}, [
      el('div', { class: 'row-title', text: 'Плейлист / несколько ссылок' }),
      el('div', { class: 'row-desc', text: 'Разрешить несколько строк в поле ссылки' }),
    ]),
    makeSwitch(state.playlistOn, () => { state.playlistOn = !state.playlistOn; state.urlText = ''; renderContent(); }),
  ]));
  view.appendChild(panel);

  const pathField = el('div', { class: 'field' });
  pathField.appendChild(el('label', { text: 'Папка сохранения' }));
  const pathRow = el('div', { class: 'path-row' });
  pathRow.appendChild(el('div', { class: 'path-display', text: state.savePath }));
  pathRow.appendChild(el('button', {
    class: 'btn-ghost',
    onclick: () => { state.tempPath = state.savePath; state.showPathModal = true; renderModal(); },
  }, el('span', { text: 'Обзор' })));
  pathField.appendChild(pathRow);
  view.appendChild(pathField);

  const canStart = state.bin.ytdlp.found;
  view.appendChild(el('button', {
    class: 'btn-primary',
    disabled: canStart ? null : 'disabled',
    onclick: startDownload,
  }, el('span', { text: canStart ? 'Скачать' : 'yt-dlp не найден' })));

  return view;
}

function makeSwitch(on, onClick) {
  const btn = el('button', { class: 'switch' + (on ? ' on' : ''), onclick: () => { onClick(); } });
  btn.appendChild(el('div', { class: 'knob' }));
  return btn;
}

async function startDownload() {
  const lines = state.urlText.split('\n').map((s) => s.trim()).filter(Boolean);
  const list = state.playlistOn ? lines : lines.slice(0, 1);
  if (list.length === 0) {
    pushToast('Вставьте ссылку на видео');
    return;
  }
  const payload = {
    urls: list,
    format: state.format,
    quality: state.quality,
    subtitles: state.subtitlesOn ? state.subtitleLang : null,
    filenameTemplate: state.filenameTemplate,
    savePath: state.savePath,
  };
  const created = await window.api.startDownload(payload);
  for (const item of created) state.queue.push(item);
  state.urlText = '';
  pushToast('Добавлено в очередь: ' + created.length);
  render();
}

// ---------------------------------------------------------------------------
// Queue view
// ---------------------------------------------------------------------------
function renderQueueView() {
  const view = el('div', { class: 'view' });
  view.appendChild(el('div', { class: 'view-header-row' }, [
    el('div', {}, [
      el('div', { class: 'title', text: 'Очередь загрузок' }),
      el('div', { class: 'subtitle', text: state.queue.length > 0 ? 'Активных загрузок: ' + state.queue.length : 'Нет активных загрузок' }),
    ]),
    el('div', { style: 'display:flex; gap:8px;' }, [
      el('button', { class: 'btn-secondary', text: 'Пауза всех', onclick: () => window.api.pauseAll() }),
      el('button', { class: 'btn-secondary', text: 'Возобновить', onclick: () => window.api.resumeAll() }),
    ]),
  ]));

  if (state.queue.length === 0) {
    view.appendChild(el('div', { class: 'empty-state' }, el('div', { text: 'Очередь пуста — добавьте ссылку на вкладке «Загрузка»' })));
    return view;
  }

  const list = el('div', { class: 'queue-list' });
  for (const item of state.queue) {
    const pct = Math.round(item.progress || 0);
    const statusText = item.status === 'paused' ? 'На паузе'
      : item.status === 'queued' ? 'В очереди…'
      : item.status === 'error' ? (item.statusText || 'Ошибка')
      : (item.statusText || 'Загрузка…');
    const speedText = item.status === 'downloading' ? fmtSpeed(item.speedBps) : '—';

    const card = el('div', { class: 'queue-item' });
    card.appendChild(el('div', { class: 'queue-item-top' }, [
      el('div', { class: 'queue-item-name', text: item.name }),
      el('div', { class: 'queue-item-pct', text: pct + '%' }),
    ]));
    card.appendChild(el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: `width:${pct}%` })));
    card.appendChild(el('div', { class: 'queue-item-bottom' }, [
      el('div', { class: 'queue-item-meta', text: `${getQualityLabel(item.format, item.quality)} · ${speedText} · ${statusText}` }),
      el('div', { class: 'queue-item-actions' }, [
        el('button', {
          class: 'btn-small', text: item.status === 'paused' ? 'Продолжить' : 'Пауза',
          onclick: () => window.api.togglePause(item.id),
        }),
        el('button', { class: 'btn-small danger', text: 'Отмена', onclick: () => window.api.cancelItem(item.id) }),
      ]),
    ]));
    list.appendChild(card);
  }
  view.appendChild(list);
  return view;
}

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------
function renderHistoryView() {
  const view = el('div', { class: 'view' });
  view.appendChild(el('div', { class: 'view-header-row' }, [
    el('div', {}, [
      el('div', { class: 'title', text: 'История' }),
      el('div', { class: 'subtitle', text: 'Завершённые загрузки' }),
    ]),
    el('button', {
      class: 'btn-secondary', text: 'Очистить всё',
      onclick: async () => { await window.api.clearHistory(); state.history = []; render(); },
    }),
  ]));

  if (state.history.length === 0) {
    view.appendChild(el('div', { class: 'empty-state' }, el('div', { text: 'История пока пуста' })));
    return view;
  }

  const list = el('div', { class: 'history-list' });
  for (const h of state.history) {
    const card = el('div', { class: 'history-item' });
    card.appendChild(el('div', { class: 'history-item-main' }, [
      el('div', { class: 'history-item-name', text: h.name }),
      el('div', { class: 'history-item-meta', text: `${getQualityLabel(h.format, h.qualityLabel)} · ${fmtSize(h.sizeBytes)} · ${fmtDate(h.date)}` }),
    ]));
    if (h.path) {
      card.appendChild(el('button', { class: 'btn-small', text: 'Папка', onclick: () => window.api.openPath(h.path) }));
    }
    card.appendChild(el('button', {
      class: 'btn-small danger', text: 'Удалить',
      onclick: async () => { await window.api.deleteHistoryItem(h.id); state.history = state.history.filter((x) => x.id !== h.id); render(); },
    }));
    list.appendChild(card);
  }
  view.appendChild(list);
  return view;
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
function renderSettingsView() {
  const view = el('div', { class: 'view' });
  view.appendChild(el('div', { class: 'view-header' }, [
    el('div', { class: 'title', text: 'Настройки' }),
    el('div', { class: 'subtitle', text: 'Пути, поведение загрузок и оформление' }),
  ]));

  // Tools
  const toolsField = el('div', { class: 'field' });
  toolsField.appendChild(el('label', { text: 'Пути к инструментам' }));
  const toolsPanel = el('div', { class: 'panel' });
  toolsPanel.appendChild(el('div', { class: 'tool-row' }, [
    el('span', { class: 'tool-label', text: 'yt-dlp' }),
    el('div', { class: 'tool-path', text: state.bin.ytdlp.path || 'не найден' }),
    el('button', {
      class: 'btn-small', text: 'Проверить',
      onclick: async () => {
        state.ytdlpVersionChecking = true;
        state.ytdlpVersionMsg = '';
        renderContent();
        const res = await window.api.checkYtdlpUpdate();
        state.ytdlpVersionChecking = false;
        state.ytdlpVersionMsg = res.message;
        pushToast(res.message);
        renderContent();
      },
    }),
  ]));
  if (state.ytdlpVersionChecking) {
    toolsPanel.appendChild(el('div', { class: 'tool-status' }, [el('span', { class: 'spinner' }), el('span', { text: 'Проверка обновлений…' })]));
  }
  if (state.ytdlpVersionMsg && !state.ytdlpVersionChecking) {
    toolsPanel.appendChild(el('div', { class: 'tool-status', text: state.ytdlpVersionMsg }));
  } else if (state.bin.ytdlp.version && !state.ytdlpVersionChecking) {
    toolsPanel.appendChild(el('div', { class: 'tool-status', text: 'Версия: ' + state.bin.ytdlp.version }));
  }
  toolsPanel.appendChild(el('div', { class: 'tool-row' }, [
    el('span', { class: 'tool-label', text: 'ffmpeg' }),
    el('div', { class: 'tool-path', text: state.bin.ffmpeg.found ? state.bin.ffmpeg.path : 'не найден — слияние видео/аудио и извлечение звука недоступны' }),
  ]));
  toolsField.appendChild(toolsPanel);
  view.appendChild(toolsField);

  // Downloads
  const dlField = el('div', { class: 'field' });
  dlField.appendChild(el('label', { text: 'Загрузки' }));
  const dlPanel = el('div', { class: 'panel' });
  const rangeWrap = el('div', { class: 'range-row' });
  rangeWrap.appendChild(el('div', { class: 'range-top' }, [el('span', { text: 'Одновременных загрузок' }), el('span', { text: String(state.concurrency) })]));
  const range = el('input', { type: 'range', min: '1', max: '5', step: '1' });
  range.value = state.concurrency;
  range.addEventListener('change', () => {
    state.concurrency = parseInt(range.value, 10);
    window.api.saveSettings({ concurrency: state.concurrency });
    renderContent();
  });
  rangeWrap.appendChild(range);
  dlPanel.appendChild(rangeWrap);

  const nameField = el('div', {});
  nameField.appendChild(el('div', { class: 'row-title', style: 'margin-bottom:8px;', text: 'Шаблон имени файла' }));
  const nameInput = el('input', { class: 'input', style: 'font-family:monospace; font-size:13px; padding:10px 12px;' });
  nameInput.value = state.filenameTemplate;
  nameInput.addEventListener('change', () => {
    state.filenameTemplate = nameInput.value;
    window.api.saveSettings({ filenameTemplate: state.filenameTemplate });
  });
  nameField.appendChild(nameInput);
  dlPanel.appendChild(nameField);
  dlField.appendChild(dlPanel);
  view.appendChild(dlField);

  // Appearance
  const apField = el('div', { class: 'field' });
  apField.appendChild(el('label', { text: 'Оформление' }));
  const themeRow = el('div', { class: 'row-between panel' }, [
    el('div', {}, [
      el('div', { class: 'row-title', text: 'Тема оформления' }),
      el('div', { class: 'row-desc', text: state.theme === 'dark' ? 'Тёмная' : 'Светлая' }),
    ]),
    makeSwitch(state.theme === 'light', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      window.api.saveSettings({ theme: state.theme });
      renderContent();
    }),
  ]);
  apField.appendChild(themeRow);

  const accentRow = el('div', { class: 'accent-row' });
  for (const c of ACCENT_OPTIONS) {
    const sw = el('button', { class: 'swatch' + (state.accent === c ? ' active' : ''), style: `background:${c}` });
    sw.addEventListener('click', () => {
      state.accent = c;
      applyTheme();
      window.api.saveSettings({ accent: c });
      renderContent();
    });
    accentRow.appendChild(sw);
  }
  apField.appendChild(accentRow);
  view.appendChild(apField);

  // About
  const aboutField = el('div', { class: 'field' });
  aboutField.appendChild(el('label', { text: 'О программе' }));
  const about = el('div', { class: 'about-row' });
  about.appendChild(el('div', { class: 'about-icon', text: 'YT' }));
  const aboutMain = el('div', { style: 'flex:1;' });
  aboutMain.appendChild(el('div', { class: 'about-name', text: 'yt-dlp GUI · v1.0.0' }));
  aboutMain.appendChild(el('div', { class: 'about-desc', text: 'Графический интерфейс для yt-dlp' }));
  about.appendChild(aboutMain);
  const link = el('a', { class: 'repo-link', text: 'Репозиторий ↗', 'data-external': '1', href: 'https://github.com/Intcatsite/yt-dlp-gui' });
  about.appendChild(link);
  aboutField.appendChild(about);
  view.appendChild(aboutField);

  return view;
}

// ---------------------------------------------------------------------------
// Path modal
// ---------------------------------------------------------------------------
function renderModal() {
  const overlay = document.getElementById('path-modal-overlay');
  const modal = document.getElementById('path-modal');
  if (!state.showPathModal) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  modal.innerHTML = '';
  modal.onclick = (e) => e.stopPropagation();
  modal.appendChild(el('div', { class: 'modal-title', text: 'Выбрать папку сохранения' }));
  for (const p of PATH_PRESETS) {
    modal.appendChild(el('button', {
      class: 'modal-opt',
      onclick: () => { state.savePath = p.path; closeModal(); },
    }, [el('span', { class: 'opt-label', text: p.label }), el('span', { class: 'opt-path', text: p.path })]));
  }
  modal.appendChild(el('button', {
    class: 'modal-opt',
    onclick: async () => {
      const dir = await window.api.chooseFolder();
      if (dir) { state.savePath = dir; closeModal(); }
    },
  }, [el('span', { class: 'opt-label', text: 'Выбрать через проводник…' })]));
  const row = el('div', { class: 'modal-row' });
  const input = el('input', { class: 'input', placeholder: 'Свой путь…', style: 'font-family:monospace; font-size:13px; padding:10px 12px;' });
  input.value = state.tempPath;
  input.addEventListener('input', () => { state.tempPath = input.value; });
  row.appendChild(input);
  row.appendChild(el('button', {
    class: 'btn-accent', text: 'Готово',
    onclick: () => {
      const p = (state.tempPath || '').trim();
      if (p) state.savePath = p;
      closeModal();
    },
  }));
  modal.appendChild(row);
}
function closeModal() {
  state.showPathModal = false;
  renderModal();
  renderContent();
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------
function renderContent() {
  const root = document.getElementById('content');
  root.innerHTML = '';
  let view;
  if (state.activeNav === 'download') view = renderDownloadView();
  else if (state.activeNav === 'queue') view = renderQueueView();
  else if (state.activeNav === 'history') view = renderHistoryView();
  else view = renderSettingsView();
  root.appendChild(view);
}

function render() {
  renderNav();
  renderContent();
  renderToasts();
  renderModal();
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
window.api.onQueueUpdate(({ id, patch }) => {
  const item = state.queue.find((q) => q.id === id);
  if (item) {
    Object.assign(item, patch);
    if (state.activeNav === 'queue') renderContent();
    if (patch.status === 'error') pushToast((item.name || 'Загрузка') + ': ошибка');
  }
});
window.api.onQueueRemove(({ id }) => {
  state.queue = state.queue.filter((q) => q.id !== id);
  renderNav();
  if (state.activeNav === 'queue') renderContent();
});
window.api.onHistoryAdd(({ item }) => {
  state.history.unshift(item);
  pushToast('Загрузка завершена: ' + item.name);
  if (state.activeNav === 'history') renderContent();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  const data = await window.api.getInitData();
  state.theme = data.settings.theme || 'dark';
  state.accent = data.settings.accent || '#0a84ff';
  state.savePath = data.settings.savePath || state.savePath;
  state.concurrency = data.settings.concurrency || 2;
  state.filenameTemplate = data.settings.filenameTemplate || state.filenameTemplate;
  state.history = data.history || [];
  state.bin = data.bin;

  if (!data.bin.ytdlp.found) {
    pushToast('yt-dlp не найден — добавьте его в PATH или переустановите приложение');
  }

  applyTheme();
  render();
})();
