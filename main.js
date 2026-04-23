const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, 'bin');
const CHROME_HTML = path.join(APP_DIR, 'browser-chrome.html');
const CHROME_BAR_HEIGHT = 28;
const CHROME_EXPANDED_MAX = 320;

let win = null;
let ptyProc = null;
let cellMetrics = null;

// pid (from the `browse` shell process) → overlay record.
const overlays = new Map();

function ptyEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${BIN_DIR}:${process.env.PATH || ''}`,
  };
}

function spawnPty(cols = 100, rows = 30) {
  const shell = process.env.SHELL || '/bin/zsh';
  ptyProc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd: os.homedir(),
    env: ptyEnv(),
  });
  ptyProc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty-data', data);
  });
  ptyProc.onExit(() => { ptyProc = null; });
}

function killPty() {
  if (ptyProc) {
    try { ptyProc.kill(); } catch {}
    ptyProc = null;
  }
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.includes(' ') || !s.includes('.')) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }
  return 'https://' + s;
}

// ---------- history store ----------

let HISTORY_PATH = null;
let historyData = { entries: {} };
let historyDirty = false;
let historyWriteTimer = null;

function loadHistory() {
  HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries) historyData = parsed;
  } catch {}
}

function persistHistory() {
  if (!HISTORY_PATH || historyWriteTimer) return;
  historyWriteTimer = setTimeout(() => {
    historyWriteTimer = null;
    if (!historyDirty) return;
    historyDirty = false;
    try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(historyData)); } catch {}
  }, 500);
}

function recordVisit(url, title) {
  if (!url || !/^https?:/i.test(url)) return;
  const entry = historyData.entries[url] || { title: '', count: 0, lastVisited: 0 };
  if (title) entry.title = title;
  entry.count += 1;
  entry.lastVisited = Date.now();
  historyData.entries[url] = entry;
  historyDirty = true;
  persistHistory();
}

function suggestHistory(query, limit = 5) {
  const now = Date.now();
  const all = Object.entries(historyData.entries);
  if (!query) {
    all.sort((a, b) => b[1].lastVisited - a[1].lastVisited);
    return all.slice(0, limit).map(([url, e]) => ({ url, title: e.title, count: e.count }));
  }
  const q = query.toLowerCase();
  const candidates = [];
  for (const [url, e] of all) {
    const u = url.toLowerCase();
    const uNoScheme = u.replace(/^https?:\/\/(www\.)?/, '');
    const t = (e.title || '').toLowerCase();
    let score = 0;
    if (uNoScheme.startsWith(q)) score += 100;
    else if (u.includes(q)) score += 30;
    if (t.startsWith(q)) score += 50;
    else if (t.includes(q)) score += 15;
    if (score === 0) continue;
    const daysAgo = Math.max(0.1, (now - e.lastVisited) / (1000 * 60 * 60 * 24));
    score += e.count / (1 + daysAgo / 7);
    candidates.push({ url, title: e.title, count: e.count, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(({ url, title, count }) => ({ url, title, count }));
}

// ---------- google suggest ----------

const suggestCache = new Map();
const SUGGEST_TTL = 45 * 1000;

async function suggestGoogle(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cached = suggestCache.get(q);
  if (cached && Date.now() - cached.ts < SUGGEST_TTL) return cached.results;
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    const list = (Array.isArray(data) && Array.isArray(data[1]) ? data[1] : []).slice(0, 6);
    suggestCache.set(q, { ts: Date.now(), results: list });
    if (suggestCache.size > 200) {
      const oldest = [...suggestCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) suggestCache.delete(oldest[0]);
    }
    return list;
  } catch {
    return [];
  }
}

async function combinedSuggest(query) {
  const urlLike = /\./.test(query) && !/\s/.test(query);
  const [history, searches] = await Promise.all([
    Promise.resolve(suggestHistory(query, urlLike ? 5 : 3)),
    query && !urlLike ? suggestGoogle(query) : Promise.resolve([]),
  ]);
  const out = [];
  for (const h of history) out.push({ type: 'url', url: h.url, title: h.title });
  const seen = new Set(out.map((o) => (o.title || '').toLowerCase()));
  for (const q of searches) {
    if (q && !seen.has(q.toLowerCase())) out.push({ type: 'query', query: q });
    if (out.length >= 8) break;
  }
  return out;
}

// ---------- overlay layout ----------

function cellRectToPixels(cellX, cellY, cols, rows) {
  if (!cellMetrics || !win || win.isDestroyed()) return null;
  const { cellWidth, cellHeight, origin, cols: totalCols, rows: totalRows } = cellMetrics;
  const wb = win.getContentBounds();
  let x1 = Math.round(origin.x + cellX * cellWidth);
  let y1 = Math.round(origin.y + cellY * cellHeight);
  let x2 = Math.round(origin.x + (cellX + cols) * cellWidth);
  let y2 = Math.round(origin.y + (cellY + rows) * cellHeight);
  // Snap edge-hugging overlays to the window's actual content bounds so we
  // don't leave a few pixels of grid padding / sub-cell slack visible.
  if (cellX <= 0) x1 = 0;
  if (cellY <= 0) y1 = 0;
  if (totalCols && cellX + cols >= totalCols) x2 = wb.width;
  if (totalRows && cellY + rows >= totalRows) y2 = wb.height;
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

function layoutOverlays() {
  if (!win || win.isDestroyed()) return;
  for (const overlay of overlays.values()) {
    const rect = cellRectToPixels(overlay.cellX, overlay.cellY, overlay.cols, overlay.rows);
    if (!rect) continue;
    const desired = overlay.chromeExpandedHeight > CHROME_BAR_HEIGHT
      ? Math.min(overlay.chromeExpandedHeight, CHROME_EXPANDED_MAX)
      : CHROME_BAR_HEIGHT;
    const barH = Math.min(desired, rect.height);
    overlay.chromeView.setBounds({
      x: rect.x, y: rect.y, width: rect.width, height: barH,
    });
    overlay.view.setBounds({
      x: rect.x, y: rect.y + barH,
      width: rect.width,
      height: Math.max(0, rect.height - barH),
    });
  }
}

function findOverlayByWc(wc) {
  for (const overlay of overlays.values()) {
    if (overlay.view.webContents === wc) return overlay;
    if (overlay.chromeView.webContents === wc) return overlay;
  }
  return null;
}

function createOverlay({ pid, cellX, cellY, cols, rows, url }) {
  if (!pid || overlays.has(pid)) return;
  const target = normalizeUrl(url);

  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // Opaque so the terminal underneath doesn't bleed through on about:blank or
  // during load. Matches Chrome's new-tab white.
  view.setBackgroundColor('#ffffff');

  const chromeView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  chromeView.setBackgroundColor('#1b1b1b');
  chromeView.webContents.loadFile(CHROME_HTML, { query: { id: pid } });

  const overlay = {
    pid, cellX, cellY, cols, rows,
    view, chromeView,
    chromeExpandedHeight: 0,
    url: target,
  };
  overlays.set(pid, overlay);

  const pushNavState = () => {
    if (chromeView.webContents.isDestroyed()) return;
    chromeView.webContents.send('nav-state', {
      url: view.webContents.getURL() || '',
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  };
  overlay.pushNavState = pushNavState;

  const onStateChange = () => {
    pushNavState();
    try { recordVisit(view.webContents.getURL(), view.webContents.getTitle()); } catch {}
  };
  view.webContents.on('did-navigate', onStateChange);
  view.webContents.on('did-navigate-in-page', onStateChange);
  view.webContents.on('did-finish-load', onStateChange);
  view.webContents.on('page-title-updated', onStateChange);

  // Option+Escape from anywhere inside the overlay dismisses it.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && input.alt) {
      event.preventDefault();
      destroyOverlay(pid);
    }
  });

  // Content added first; chrome stacked on top so the omnibox dropdown can
  // overlay content during an expanded state.
  win.contentView.addChildView(view);
  win.contentView.addChildView(chromeView);
  view.webContents.loadURL(target);
  layoutOverlays();
}

function destroyOverlay(pid) {
  const overlay = overlays.get(pid);
  if (!overlay) return;
  overlays.delete(pid);
  try { win.contentView.removeChildView(overlay.chromeView); } catch {}
  try { overlay.chromeView.webContents.close(); } catch {}
  try { win.contentView.removeChildView(overlay.view); } catch {}
  try { overlay.view.webContents.close(); } catch {}
  // Tear down the `browse` shell process so the pane (or bare terminal) is
  // released. Its cleanup trap will emit tdub-browse-end, which we handle
  // idempotently (overlay already gone).
  const n = Number(pid);
  if (Number.isFinite(n)) {
    try { process.kill(n, 'SIGTERM'); } catch {}
  }
  // Refocus the main renderer so the terminal regains keyboard.
  if (win && !win.isDestroyed()) {
    try { win.webContents.focus(); } catch {}
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 650,
    title: 'tdub',
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
  win.on('resize', layoutOverlays);
  win.on('closed', () => {
    killPty();
    win = null;
  });
}

// ---------- IPC ----------

ipcMain.on('renderer-ready', (_e, { cols, rows }) => {
  if (!ptyProc) spawnPty(cols || 100, rows || 30);
});
ipcMain.on('pty-write', (_e, data) => { if (ptyProc) ptyProc.write(data); });
ipcMain.on('pty-resize', (_e, { cols, rows }) => {
  if (ptyProc) {
    try { ptyProc.resize(cols, rows); } catch {}
  }
});
ipcMain.on('cell-metrics', (_e, metrics) => {
  cellMetrics = metrics;
  layoutOverlays();
});

// OSC-driven overlay lifecycle.
ipcMain.on('tdub-browse', (_e, params) => createOverlay(params));
ipcMain.on('tdub-browse-end', (_e, { pid }) => destroyOverlay(pid));

// Per-overlay navbar IPCs. The overlay id is the same `pid` the OSC used.
ipcMain.on('chrome-ready', (_e, id) => {
  const overlay = overlays.get(id);
  if (!overlay) return;
  overlay.pushNavState();
  // Chrome-new-tab behavior: auto-focus URL input on about:blank.
  const u = overlay.view.webContents.getURL() || '';
  if (/^about:blank\b/.test(u)) {
    try { overlay.chromeView.webContents.focus(); } catch {}
    try { overlay.chromeView.webContents.send('focus-url'); } catch {}
  }
});
ipcMain.on('chrome-click', () => { /* no-op */ });
ipcMain.on('chrome-defocus', (_e, id) => destroyOverlay(id));
ipcMain.on('chrome-expand', (_e, id, height) => {
  const overlay = overlays.get(id);
  if (!overlay) return;
  overlay.chromeExpandedHeight = (height && height > CHROME_BAR_HEIGHT) ? height : 0;
  layoutOverlays();
});
ipcMain.on('nav-back', (_e, id) => {
  const overlay = overlays.get(id);
  if (overlay && overlay.view.webContents.canGoBack()) overlay.view.webContents.goBack();
});
ipcMain.on('nav-forward', (_e, id) => {
  const overlay = overlays.get(id);
  if (overlay && overlay.view.webContents.canGoForward()) overlay.view.webContents.goForward();
});
ipcMain.on('nav-reload', (_e, id) => {
  const overlay = overlays.get(id);
  if (overlay) overlay.view.webContents.reload();
});
ipcMain.on('nav-url', (_e, id, raw) => {
  const overlay = overlays.get(id);
  if (!overlay) return;
  const target = normalizeUrl(raw);
  if (!target) return;
  try { overlay.view.webContents.loadURL(target); } catch {}
  try { overlay.view.webContents.focus(); } catch {}
});
ipcMain.handle('omnibox-suggest', (_e, query) => combinedSuggest(query || ''));

app.whenReady().then(() => {
  loadHistory();
  createWindow();
});

app.on('window-all-closed', () => {
  // Any still-alive `browse` processes will exit when their ptys close.
  app.quit();
});
