const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');

const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, 'bin');
const CHROME_HTML = path.join(APP_DIR, 'browser-chrome.html');
const CHROME_BAR_HEIGHT = 28;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'tdub');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_BINDINGS = {
  newTerminal:      ['Cmd+T'],
  closePane:        ['Cmd+W'],
  closeWindow:      ['Cmd+Shift+W'],
  newWindow:        ['Cmd+N'],
  splitRight:       ['Cmd+Alt+N'],
  splitDown:        ['Cmd+Alt+Shift+N'],
  navLeft:          ['Cmd+H'],
  navDown:          ['Cmd+J'],
  navUp:            ['Cmd+K'],
  navRight:         ['Cmd+L'],
  equalize:         ['Cmd+='],
  engage:           ['Cmd+Enter'],
  disengage:        ['Alt+Escape'],
};

const DEFAULT_TERMINAL = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#000000', foreground: '#e0e0e0' },
  shell: null,
};

const DEFAULT_WINDOW = { width: 1000, height: 650 };

const DEFAULT_PANES = {
  border: { inactive: '#2a2a2a', focused: '#4a9eff', width: 1 },
};

let bindings = DEFAULT_BINDINGS;
let termConfig = DEFAULT_TERMINAL;
let windowConfig = DEFAULT_WINDOW;
let paneConfig = DEFAULT_PANES;

function parseChord(str) {
  const parts = String(str).split('+').map((s) => s.trim()).filter(Boolean);
  const out = { meta: false, alt: false, shift: false, ctrl: false, key: '' };
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === 'cmd' || lp === 'meta' || lp === 'command') out.meta = true;
    else if (lp === 'alt' || lp === 'option' || lp === 'opt') out.alt = true;
    else if (lp === 'shift') out.shift = true;
    else if (lp === 'ctrl' || lp === 'control') out.ctrl = true;
    else out.key = lp;
  }
  return out;
}

function chordKey(input) {
  const c = String(input.code || '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return String(input.key || '').toLowerCase();
}

function matchesChord(input, chord) {
  if (input.type !== 'keyDown') return false;
  if (!!input.meta !== chord.meta) return false;
  if (!!input.alt !== chord.alt) return false;
  if (!!input.shift !== chord.shift) return false;
  if (!!input.control !== chord.ctrl) return false;
  const k = chordKey(input);
  if (chord.key === '=' && (k === '=' || k === '+')) return true;
  return k === chord.key;
}

function actionFor(input) {
  for (const [action, chords] of Object.entries(bindings)) {
    for (const str of chords) {
      if (matchesChord(input, parseChord(str))) return action;
    }
  }
  return null;
}

function mergeDeep(defaults, patch) {
  if (!patch || typeof patch !== 'object') return defaults;
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = mergeDeep(defaults[k], v);
    } else if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfigFromDisk() {
  let parsed = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[tdub] config load:', e.message);
  }

  if (parsed && parsed.keybindings && typeof parsed.keybindings === 'object') {
    const next = { ...DEFAULT_BINDINGS };
    for (const [k, v] of Object.entries(parsed.keybindings)) {
      if (Array.isArray(v)) next[k] = v.filter((x) => typeof x === 'string');
      else if (typeof v === 'string') next[k] = [v];
    }
    bindings = next;
  } else {
    bindings = DEFAULT_BINDINGS;
  }

  termConfig = mergeDeep(DEFAULT_TERMINAL, parsed && parsed.terminal);
  windowConfig = mergeDeep(DEFAULT_WINDOW, parsed && parsed.window);
  paneConfig = mergeDeep(DEFAULT_PANES, parsed && parsed.panes);

  for (const world of worlds.values()) pushRuntimeConfig(world);
}

function pushRuntimeConfig(world) {
  if (!world || !world.rendererReady || world.win.isDestroyed()) return;
  world.termView.webContents.send('config-update', {
    terminal: termConfig, panes: paneConfig, bindings,
  });
}

function ensureConfigFile() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      const seed = {
        _comment: 'Edit below. Chord syntax: "Cmd+T", "Cmd+Alt+Shift+N". Reload on save.',
        keybindings: DEFAULT_BINDINGS,
        terminal: DEFAULT_TERMINAL,
        window: DEFAULT_WINDOW,
        panes: DEFAULT_PANES,
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
    }
  } catch (e) { console.warn('[tdub] ensureConfigFile:', e.message); }
}

function watchConfig() {
  try {
    fs.watchFile(CONFIG_PATH, { interval: 400, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) loadConfigFromDisk();
    });
  } catch (e) { console.warn('[tdub] watchConfig:', e.message); }
}

const worlds = new Map();

let nextPaneSeq = 1;
const newPaneId = () => `p${nextPaneSeq++}`;

function ptyEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${BIN_DIR}:${process.env.PATH || ''}`,
    TDUB_BIN: BIN_DIR,
    ZDOTDIR: path.join(APP_DIR, 'shell', 'zsh'),
  };
}

function spawnPty(world, paneId, cols = 100, rows = 30) {
  const shell = termConfig.shell || process.env.SHELL || '/bin/zsh';
  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd: os.homedir(),
    env: ptyEnv(),
  });
  p.onData((data) => {
    if (!world.win.isDestroyed() && !world.termView.webContents.isDestroyed()) {
      world.termView.webContents.send('pty-data', { paneId, data });
    }
  });
  p.onExit(() => {
    if (!worlds.has(world.win.id)) return;
    const cur = world.panes.get(paneId);
    if (!cur || cur.kind !== 'term' || cur.pty !== p) return;
    closePane(world, paneId);
  });
  return p;
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

// ---------- history + google suggest ----------

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
  } catch { return []; }
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

// ---------- tree ----------

function contentRect(world) {
  const wb = world.win.getContentBounds();
  return { x: 0, y: 0, w: wb.width, h: wb.height };
}

function layoutNode(node, rect, out) {
  if (node.kind === 'leaf') { out[node.paneId] = rect; return; }
  if (node.dir === 'h') {
    const wA = Math.max(1, Math.floor(rect.w * node.ratio));
    layoutNode(node.a, { x: rect.x, y: rect.y, w: wA, h: rect.h }, out);
    layoutNode(node.b, { x: rect.x + wA, y: rect.y, w: rect.w - wA, h: rect.h }, out);
  } else {
    const hA = Math.max(1, Math.floor(rect.h * node.ratio));
    layoutNode(node.a, { x: rect.x, y: rect.y, w: rect.w, h: hA }, out);
    layoutNode(node.b, { x: rect.x, y: rect.y + hA, w: rect.w, h: rect.h - hA }, out);
  }
}

function layoutWorld(world) {
  if (world.win.isDestroyed()) return;
  const rect = contentRect(world);
  const rects = {};
  layoutNode(world.root, rect, rects);
  for (const [paneId, r] of Object.entries(rects)) {
    const pane = world.panes.get(paneId);
    if (!pane) continue;
    pane.rect = r;
    if (pane.kind === 'browser') {
      const ix = r.x + 1, iy = r.y + 1;
      const iw = Math.max(0, r.w - 2), ih = Math.max(0, r.h - 2);
      const barH = Math.min(CHROME_BAR_HEIGHT, ih);
      try { pane.chromeView.setBounds({ x: ix, y: iy, width: iw, height: barH }); } catch {}
      try { pane.view.setBounds({ x: ix, y: iy + barH, width: iw, height: Math.max(0, ih - barH) }); } catch {}
    }
  }
  if (world.rendererReady) {
    world.termView.webContents.send('layout', { rectsByPaneId: rects });
  }
}

function findLeafParent(node, paneId, parent = null) {
  if (node.kind === 'leaf') return node.paneId === paneId ? { leaf: node, parent } : null;
  return findLeafParent(node.a, paneId, node) || findLeafParent(node.b, paneId, node);
}

function addTermPane(world, paneId) {
  const pane = { id: paneId, kind: 'term', pty: null, rect: { x: 0, y: 0, w: 1, h: 1 } };
  world.panes.set(paneId, pane);
  if (world.rendererReady) {
    world.termView.webContents.send('pane-add', { paneId, kind: 'term' });
  }
  pane.pty = spawnPty(world, paneId);
  return pane;
}

function removePane(world, paneId) {
  const pane = world.panes.get(paneId);
  if (!pane) return;
  world.panes.delete(paneId);
  if (pane.kind === 'term') {
    try { pane.pty && pane.pty.kill(); } catch {}
    if (world.rendererReady) {
      world.termView.webContents.send('pane-remove', { paneId });
    }
  } else if (pane.kind === 'browser') {
    try { world.win.contentView.removeChildView(pane.chromeView); } catch {}
    try { pane.chromeView.webContents.close(); } catch {}
    try { world.win.contentView.removeChildView(pane.view); } catch {}
    try { pane.view.webContents.close(); } catch {}
    if (world.rendererReady) {
      world.termView.webContents.send('pane-remove', { paneId });
    }
    const n = Number(pane.pid || '');
    if (Number.isFinite(n)) { try { process.kill(n, 'SIGTERM'); } catch {} }
  }
}

function smartDirection(rect) {
  return rect.w / Math.max(1, rect.h) >= 1 ? 'h' : 'v';
}

function split(world, paneId, dir) {
  const found = findLeafParent(world.root, paneId);
  if (!found) return;
  const { leaf, parent } = found;
  const newId = newPaneId();
  addTermPane(world, newId);
  const splitNode = { kind: 'split', dir, ratio: 0.5, a: leaf, b: { kind: 'leaf', paneId: newId } };
  if (!parent) world.root = splitNode;
  else if (parent.a === leaf) parent.a = splitNode;
  else parent.b = splitNode;
  world.focusedPaneId = newId;
  layoutWorld(world);
  pushFocus(world);
}

function closePane(world, paneId) {
  if (!world.panes.has(paneId)) return;
  if (world.root.kind === 'leaf' && world.root.paneId === paneId) return;
  removePane(world, paneId);
  const unlink = (node, pp = null) => {
    if (node.kind === 'leaf') return false;
    if (node.a.kind === 'leaf' && node.a.paneId === paneId) {
      replaceNode(pp, node, node.b, world); return true;
    }
    if (node.b.kind === 'leaf' && node.b.paneId === paneId) {
      replaceNode(pp, node, node.a, world); return true;
    }
    return unlink(node.a, node) || unlink(node.b, node);
  };
  unlink(world.root);
  const anyLeaf = firstLeaf(world.root);
  if (anyLeaf) world.focusedPaneId = anyLeaf.paneId;
  layoutWorld(world);
  pushFocus(world);
}

function replaceNode(parent, oldNode, newNode, world) {
  if (!parent) world.root = newNode;
  else if (parent.a === oldNode) parent.a = newNode;
  else if (parent.b === oldNode) parent.b = newNode;
}

function firstLeaf(node) {
  if (!node) return null;
  if (node.kind === 'leaf') return node;
  return firstLeaf(node.a) || firstLeaf(node.b);
}

function allLeaves(node, out = []) {
  if (!node) return out;
  if (node.kind === 'leaf') { out.push(node); return out; }
  allLeaves(node.a, out); allLeaves(node.b, out);
  return out;
}

function gotoDir(world, dir) {
  const cur = world.panes.get(world.focusedPaneId);
  if (!cur) return;
  const leaves = allLeaves(world.root).map((l) => world.panes.get(l.paneId)).filter(Boolean);
  const cr = cur.rect;
  const cmid = { x: cr.x + cr.w / 2, y: cr.y + cr.h / 2 };
  let best = null, bestScore = Infinity;
  for (const p of leaves) {
    if (p.id === cur.id) continue;
    const r = p.rect;
    const pmid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    let ok = false, dist = 0;
    if (dir === 'left')  { ok = r.x + r.w <= cr.x + 1;  dist = cr.x - (r.x + r.w); }
    if (dir === 'right') { ok = r.x >= cr.x + cr.w - 1; dist = r.x - (cr.x + cr.w); }
    if (dir === 'up')    { ok = r.y + r.h <= cr.y + 1;  dist = cr.y - (r.y + r.h); }
    if (dir === 'down')  { ok = r.y >= cr.y + cr.h - 1; dist = r.y - (cr.y + cr.h); }
    if (!ok) continue;
    const perp = (dir === 'left' || dir === 'right')
      ? Math.abs(pmid.y - cmid.y) : Math.abs(pmid.x - cmid.x);
    const score = dist + perp;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  if (best) { world.focusedPaneId = best.id; pushFocus(world); }
}

function pushFocus(world) {
  if (!world.rendererReady || world.win.isDestroyed()) return;
  world.termView.webContents.send('focus', { paneId: world.focusedPaneId });
  const pane = world.panes.get(world.focusedPaneId);
  if (pane && pane.kind === 'browser' && pane.engaged) {
    try { pane.view.webContents.focus(); } catch {}
  } else {
    try { world.termView.webContents.focus(); } catch {}
  }
}

function equalize(node) {
  if (!node || node.kind === 'leaf') return;
  node.ratio = 0.5;
  equalize(node.a); equalize(node.b);
}

function updateBrowserBorder(pane) {
  try {
    pane.chromeView.setBackgroundColor(pane.engaged ? '#4a9eff' : '#1b1b1b');
  } catch {}
}

// ---------- browser pane conversion ----------

function convertToBrowser(world, paneId, url, pid) {
  const pane = world.panes.get(paneId);
  if (!pane || pane.kind !== 'term') return;
  const target = normalizeUrl(url);
  try { pane.pty && pane.pty.kill(); } catch {}
  if (world.rendererReady) {
    world.termView.webContents.send('pane-change-kind', { paneId, kind: 'browser' });
  }
  world.panes.delete(paneId);

  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const chromeView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  chromeView.setBackgroundColor('#1b1b1b');
  chromeView.webContents.loadFile(CHROME_HTML);

  const bp = {
    id: paneId, kind: 'browser',
    view, chromeView,
    rect: pane.rect, engaged: false,
    pid: String(pid || ''),
  };
  world.panes.set(paneId, bp);

  const pushNavState = () => {
    if (chromeView.webContents.isDestroyed()) return;
    chromeView.webContents.send('nav-state', {
      url: view.webContents.getURL() || '',
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  };
  bp.pushNavState = pushNavState;

  const onStateChange = () => {
    pushNavState();
    try { recordVisit(view.webContents.getURL(), view.webContents.getTitle()); } catch {}
  };
  view.webContents.on('did-navigate', onStateChange);
  view.webContents.on('did-navigate-in-page', onStateChange);
  view.webContents.on('did-finish-load', onStateChange);
  view.webContents.on('page-title-updated', onStateChange);

  const onInput = (event, input) => {
    if (handleBrowserPaneInput(world, bp, event, input)) event.preventDefault();
  };
  view.webContents.on('before-input-event', onInput);
  chromeView.webContents.on('before-input-event', onInput);

  world.win.contentView.addChildView(view);
  world.win.contentView.addChildView(chromeView);
  layoutWorld(world);
  view.webContents.loadURL(target);
}

function convertToTerminal(world, paneId) {
  const pane = world.panes.get(paneId);
  if (!pane || pane.kind !== 'browser') return;
  try { world.win.contentView.removeChildView(pane.chromeView); } catch {}
  try { pane.chromeView.webContents.close(); } catch {}
  try { world.win.contentView.removeChildView(pane.view); } catch {}
  try { pane.view.webContents.close(); } catch {}
  const n = Number(pane.pid || '');
  if (Number.isFinite(n)) { try { process.kill(n, 'SIGTERM'); } catch {} }

  const termPane = { id: paneId, kind: 'term', pty: null, rect: pane.rect };
  world.panes.set(paneId, termPane);
  if (world.rendererReady) {
    world.termView.webContents.send('pane-change-kind', { paneId, kind: 'term' });
  }
  termPane.pty = spawnPty(world, paneId);
  layoutWorld(world);
  pushFocus(world);
}

function handleBrowserPaneInput(world, pane, event, input) {
  const action = actionFor(input);
  if (!action) return false;
  // Cmd+L while engaged: focus URL bar.
  if (action === 'navRight' && pane.engaged && input.meta && !input.alt) {
    try { pane.chromeView.webContents.focus(); } catch {}
    try { pane.chromeView.webContents.send('focus-url'); } catch {}
    return true;
  }
  // Everything else: delegate to main dispatcher.
  return dispatchAction(world, action);
}

// ---------- keybinding dispatch ----------

function dispatchAction(world, action) {
  switch (action) {
    case 'newTerminal': {
      const p = world.panes.get(world.focusedPaneId);
      if (p) split(world, p.id, smartDirection(p.rect));
      return true;
    }
    case 'closePane':   closePane(world, world.focusedPaneId); return true;
    case 'closeWindow': if (!world.win.isDestroyed()) world.win.close(); return true;
    case 'newWindow':   newWindow(); return true;
    case 'splitRight':  split(world, world.focusedPaneId, 'h'); return true;
    case 'splitDown':   split(world, world.focusedPaneId, 'v'); return true;
    case 'navLeft':     gotoDir(world, 'left'); return true;
    case 'navDown':     gotoDir(world, 'down'); return true;
    case 'navUp':       gotoDir(world, 'up'); return true;
    case 'navRight':    gotoDir(world, 'right'); return true;
    case 'equalize':    equalize(world.root); layoutWorld(world); return true;
    case 'engage': {
      const p = world.panes.get(world.focusedPaneId);
      if (p && p.kind === 'browser') {
        p.engaged = true;
        try { p.view.webContents.focus(); } catch {}
        updateBrowserBorder(p);
      }
      return true;
    }
    case 'disengage': {
      const p = world.panes.get(world.focusedPaneId);
      if (p && p.kind === 'browser') {
        if (p.engaged) {
          p.engaged = false;
          try { world.termView.webContents.focus(); } catch {}
          updateBrowserBorder(p);
        } else {
          convertToTerminal(world, p.id);
        }
      }
      return true;
    }
  }
  return false;
}

function handleNavChord(world, input) {
  const action = actionFor(input);
  if (!action) return false;
  return dispatchAction(world, action);
}

// ---------- window lifecycle ----------

function newWindow() {
  const win = new BrowserWindow({
    width: windowConfig.width || 1000,
    height: windowConfig.height || 650,
    title: 'tdub',
    backgroundColor: '#000000',
  });

  const termView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.contentView.addChildView(termView);
  const wb0 = win.getContentBounds();
  termView.setBounds({ x: 0, y: 0, width: wb0.width, height: wb0.height });
  termView.webContents.on('did-finish-load', () => {
    try { termView.webContents.setZoomFactor(1); } catch {}
  });
  termView.webContents.loadFile('index.html');

  const world = {
    win, termView,
    root: null, focusedPaneId: null, panes: new Map(),
    rendererReady: false,
  };
  worlds.set(win.id, world);

  const paneId = newPaneId();
  world.root = { kind: 'leaf', paneId };
  world.focusedPaneId = paneId;
  addTermPane(world, paneId);

  termView.webContents.on('before-input-event', (event, input) => {
    if (handleNavChord(world, input)) event.preventDefault();
  });

  const syncTermBounds = () => {
    if (win.isDestroyed() || termView.webContents.isDestroyed()) return;
    const wb = win.getContentBounds();
    const cur = termView.getBounds();
    if (cur.x === 0 && cur.y === 0 && cur.width === wb.width && cur.height === wb.height) return;
    termView.setBounds({ x: 0, y: 0, width: wb.width, height: wb.height });
    layoutWorld(world);
  };
  win.on('resize', syncTermBounds);
  win.on('resized', syncTermBounds);
  win.on('show', syncTermBounds);
  win.on('ready-to-show', syncTermBounds);
  const pollId = setInterval(syncTermBounds, 250);
  win.on('closed', () => {
    clearInterval(pollId);
    for (const pane of world.panes.values()) {
      if (pane.kind === 'term') { try { pane.pty && pane.pty.kill(); } catch {} }
      if (pane.kind === 'browser') {
        const n = Number(pane.pid || '');
        if (Number.isFinite(n)) { try { process.kill(n, 'SIGTERM'); } catch {} }
      }
    }
    worlds.delete(win.id);
  });

  return world;
}

// ---------- IPC ----------

ipcMain.on('renderer-ready', (e) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      world.rendererReady = true;
      pushRuntimeConfig(world);
      for (const pane of world.panes.values()) {
        if (pane.kind === 'term') {
          world.termView.webContents.send('pane-add', { paneId: pane.id, kind: 'term' });
        }
      }
      layoutWorld(world);
      pushFocus(world);
      return;
    }
  }
});

ipcMain.on('pty-write', (_e, { paneId, data }) => {
  for (const world of worlds.values()) {
    const pane = world.panes.get(paneId);
    if (pane && pane.kind === 'term' && pane.pty) { try { pane.pty.write(data); } catch {} return; }
  }
});

ipcMain.on('pty-resize', (_e, { paneId, cols, rows }) => {
  for (const world of worlds.values()) {
    const pane = world.panes.get(paneId);
    if (pane && pane.kind === 'term' && pane.pty) { try { pane.pty.resize(cols, rows); } catch {} return; }
  }
});

ipcMain.on('dispatch-action', (e, action) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      dispatchAction(world, action);
      return;
    }
  }
});

ipcMain.on('tdub-browse', (e, { paneId, pid, url }) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents !== e.sender) continue;
    if (!world.panes.has(paneId)) return;
    convertToBrowser(world, paneId, url, pid);
    return;
  }
});

function findPaneByChromeWc(wc) {
  for (const world of worlds.values()) {
    for (const pane of world.panes.values()) {
      if (pane.kind === 'browser' && pane.chromeView.webContents === wc) {
        return { world, pane };
      }
    }
  }
  return null;
}

ipcMain.on('chrome-ready', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (!found) return;
  found.pane.pushNavState();
  const u = found.pane.view.webContents.getURL() || '';
  if (/^about:blank\b/.test(u)) {
    try { found.pane.chromeView.webContents.focus(); } catch {}
    try { found.pane.chromeView.webContents.send('focus-url'); } catch {}
  }
});
ipcMain.on('chrome-defocus', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found) convertToTerminal(found.world, found.pane.id);
});
ipcMain.on('chrome-expand', () => {});
ipcMain.on('nav-back', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found && found.pane.view.webContents.canGoBack()) found.pane.view.webContents.goBack();
});
ipcMain.on('nav-forward', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found && found.pane.view.webContents.canGoForward()) found.pane.view.webContents.goForward();
});
ipcMain.on('nav-reload', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found) found.pane.view.webContents.reload();
});
ipcMain.on('nav-url', (e, raw) => {
  const found = findPaneByChromeWc(e.sender);
  if (!found) return;
  const target = normalizeUrl(raw);
  try { found.pane.view.webContents.loadURL(target); } catch {}
  try { found.pane.view.webContents.focus(); } catch {}
});
ipcMain.handle('omnibox-suggest', (_e, query) => combinedSuggest(query || ''));

app.whenReady().then(() => {
  ensureConfigFile();
  loadConfigFromDisk();
  watchConfig();
  loadHistory();
  newWindow();
});

app.on('window-all-closed', () => { app.quit(); });
