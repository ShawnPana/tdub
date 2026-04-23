const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const stage = document.getElementById('stage');

// paneId → { kind: 'term'|'browser', host, term?, fit? }
const panes = new Map();
let focusedPaneId = null;

// Runtime config pushed from main. Defaults match main's DEFAULT_*.
let termConfig = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#000000', foreground: '#e0e0e0' },
};

function applyTermConfigTo(term) {
  try {
    term.options.fontFamily = termConfig.fontFamily;
    term.options.fontSize = termConfig.fontSize;
    term.options.cursorBlink = !!termConfig.cursorBlink;
    term.options.theme = {
      background: termConfig.theme.background,
      foreground: termConfig.theme.foreground,
    };
  } catch {}
}

function applyPaneConfigToDOM(paneConfig) {
  const root = document.documentElement;
  if (!paneConfig || !paneConfig.border) return;
  const b = paneConfig.border;
  if (b.inactive) root.style.setProperty('--pane-border-inactive', b.inactive);
  if (b.focused)  root.style.setProperty('--pane-border-focused',  b.focused);
  if (b.width)    root.style.setProperty('--pane-border-width',    b.width + 'px');
}

function createHost(paneId, kind) {
  const host = document.createElement('div');
  host.className = 'pane-host' + (kind === 'browser' ? ' browser' : '');
  host.id = `pane-${paneId}`;
  stage.appendChild(host);
  return host;
}

function createTermPane(paneId) {
  if (panes.has(paneId)) return panes.get(paneId);
  const host = createHost(paneId, 'term');

  const term = new Terminal({
    fontFamily: termConfig.fontFamily,
    fontSize: termConfig.fontSize,
    cursorBlink: termConfig.cursorBlink,
    allowProposedApi: true,
    theme: {
      background: termConfig.theme.background,
      foreground: termConfig.theme.foreground,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => ipcRenderer.send('pty-write', { paneId, data }));

  // Per-term OSC 1983: browse fires in this pane; forward to main with pid/url.
  term.parser.registerOscHandler(1983, (data) => {
    const semi = data.indexOf(';');
    const kind = semi === -1 ? data : data.slice(0, semi);
    if (kind !== 'tdub-browse') return false;
    const rest = data.slice(semi + 1);
    const params = {};
    let urlPart = '';
    let remaining = rest;
    while (remaining.length) {
      const i = remaining.indexOf(';');
      const chunk = i === -1 ? remaining : remaining.slice(0, i);
      remaining = i === -1 ? '' : remaining.slice(i + 1);
      const eq = chunk.indexOf('=');
      if (eq === -1) continue;
      const key = chunk.slice(0, eq);
      const val = chunk.slice(eq + 1);
      if (key === 'url') { urlPart = i === -1 ? val : val + ';' + remaining; break; }
      params[key] = val;
    }
    ipcRenderer.send('tdub-browse', {
      paneId,
      pid: String(params.pid || ''),
      url: urlPart || 'about:blank',
    });
    return true;
  });

  const entry = { kind: 'term', host, term, fit };
  panes.set(paneId, entry);
  return entry;
}

function createBrowserPaneHost(paneId) {
  if (panes.has(paneId)) return panes.get(paneId);
  const host = createHost(paneId, 'browser');
  const entry = { kind: 'browser', host };
  panes.set(paneId, entry);
  return entry;
}

function destroyPane(paneId) {
  const entry = panes.get(paneId);
  if (!entry) return;
  if (entry.term) { try { entry.term.dispose(); } catch {} }
  try { entry.host.remove(); } catch {}
  panes.delete(paneId);
}

function applyLayout(rectsByPaneId) {
  for (const [paneId, rect] of Object.entries(rectsByPaneId)) {
    const entry = panes.get(paneId);
    if (!entry) continue;
    entry.host.style.left = rect.x + 'px';
    entry.host.style.top = rect.y + 'px';
    entry.host.style.width = rect.w + 'px';
    entry.host.style.height = rect.h + 'px';
    if (entry.kind === 'term') {
      try {
        entry.fit.fit();
        ipcRenderer.send('pty-resize', { paneId, cols: entry.term.cols, rows: entry.term.rows });
      } catch {}
    }
  }
}

function setFocus(paneId) {
  focusedPaneId = paneId;
  for (const [id, entry] of panes) {
    if (id === paneId) {
      entry.host.classList.add('focused');
      if (entry.term) { try { entry.term.focus(); } catch {} }
    } else {
      entry.host.classList.remove('focused');
      if (entry.term) { try { entry.term.blur(); } catch {} }
    }
  }
}

ipcRenderer.on('pane-add', (_e, { paneId, kind }) => {
  if (kind === 'browser') createBrowserPaneHost(paneId);
  else createTermPane(paneId);
});
ipcRenderer.on('pane-remove', (_e, { paneId }) => destroyPane(paneId));
ipcRenderer.on('pane-change-kind', (_e, { paneId, kind }) => {
  destroyPane(paneId);
  if (kind === 'browser') createBrowserPaneHost(paneId);
  else createTermPane(paneId);
});
ipcRenderer.on('layout', (_e, { rectsByPaneId }) => applyLayout(rectsByPaneId));
ipcRenderer.on('focus', (_e, { paneId }) => setFocus(paneId));
ipcRenderer.on('pty-data', (_e, { paneId, data }) => {
  const entry = panes.get(paneId);
  if (entry && entry.term) entry.term.write(data);
});
ipcRenderer.on('pane-visibility', (_e, { visible, hidden }) => {
  for (const paneId of hidden || []) {
    const entry = panes.get(paneId);
    if (entry) entry.host.style.display = 'none';
  }
  for (const paneId of visible || []) {
    const entry = panes.get(paneId);
    if (entry) {
      entry.host.style.display = '';
      if (entry.fit) { try { entry.fit.fit(); } catch {} }
    }
  }
});

// ---------- workspace bar ----------
const statusbar = document.getElementById('statusbar');
function renderWorkspaces({ list, activeIdx }) {
  statusbar.innerHTML = '';
  list.forEach((ws, i) => {
    const el = document.createElement('div');
    el.className = 'ws-tab' + (i === activeIdx ? ' active' : '');
    el.textContent = `${i + 1}:${ws.name}`;
    el.title = ws.name;
    el.addEventListener('click', () => ipcRenderer.send('activate-workspace', { idx: i }));
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      const next = prompt('Rename workspace', ws.name);
      if (next && next.trim()) {
        ipcRenderer.send('rename-workspace', { idx: i, name: next.trim() });
      }
    });
    statusbar.appendChild(el);
  });
}
ipcRenderer.on('workspaces', (_e, payload) => renderWorkspaces(payload));

ipcRenderer.on('config-update', (_e, cfg) => {
  if (cfg.terminal) {
    termConfig = {
      fontFamily: cfg.terminal.fontFamily || termConfig.fontFamily,
      fontSize: cfg.terminal.fontSize || termConfig.fontSize,
      cursorBlink: cfg.terminal.cursorBlink,
      theme: {
        background: (cfg.terminal.theme && cfg.terminal.theme.background) || termConfig.theme.background,
        foreground: (cfg.terminal.theme && cfg.terminal.theme.foreground) || termConfig.theme.foreground,
      },
    };
    for (const entry of panes.values()) {
      if (entry.term) {
        applyTermConfigTo(entry.term);
        try { entry.fit.fit(); } catch {}
      }
    }
  }
  if (cfg.panes) applyPaneConfigToDOM(cfg.panes);
  if (cfg.bindings) bindings = cfg.bindings;
});

// Chord dispatch (renderer). Needed because main's before-input-event doesn't
// fire for macOS Option-dead-key combos (Option+I, Option+E, Option+N, Option+U)
// — the IME eats the key before Electron can dispatch Input. The DOM keydown
// listener still fires, so we match here and send the action back to main.
let bindings = {};

function chordKeyForEvent(e) {
  const c = String(e.code || '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return String(e.key || '').toLowerCase();
}

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

function actionForEvent(e) {
  const k = chordKeyForEvent(e);
  for (const [action, chords] of Object.entries(bindings)) {
    for (const str of chords) {
      const c = parseChord(str);
      if (!!e.metaKey !== c.meta) continue;
      if (!!e.altKey !== c.alt) continue;
      if (!!e.shiftKey !== c.shift) continue;
      if (!!e.ctrlKey !== c.ctrl) continue;
      if (c.key === '=' && (k === '=' || k === '+')) return action;
      if (k === c.key) return action;
    }
  }
  return null;
}

// Catch nav chords at capture phase, BEFORE the Option-as-Meta fallback
// would send ESC+letter to the pty. This also bypasses macOS dead-key
// interception of Option+I since the DOM keydown still fires.
window.addEventListener('keydown', (e) => {
  const action = actionForEvent(e);
  if (action) {
    swallow(e);
    ipcRenderer.send('dispatch-action', action);
  }
}, true);

// ---------- Option-as-Meta ----------
// macOS maps Option+<letter> to dead-key composition by default. For
// tmux/readline bindings we need Option to act like Alt/Meta: send ESC
// followed by the base character of the physical key.

let layoutMap = null;
async function loadLayout() {
  if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
  try { layoutMap = await navigator.keyboard.getLayoutMap(); } catch {}
}
loadLayout();
window.addEventListener('focus', loadLayout);

const CONTROL_KEYS = {
  Backspace: '\x7f', Enter: '\r', Tab: '\t', Space: ' ', Escape: '\x1b',
  ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
  Delete: '\x1b[3~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
};

function altBaseSequence(e) {
  if (CONTROL_KEYS[e.code]) return CONTROL_KEYS[e.code];
  const base = layoutMap && layoutMap.get(e.code);
  if (!base) return null;
  return e.shiftKey ? base.toUpperCase() : base;
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const seq = altBaseSequence(e);
  swallow(e);
  if (seq !== null && focusedPaneId) {
    ipcRenderer.send('pty-write', { paneId: focusedPaneId, data: '\x1b' + seq });
  }
}, true);

['compositionstart', 'compositionupdate', 'compositionend', 'textInput'].forEach((type) => {
  window.addEventListener(type, swallow, true);
});
window.addEventListener('beforeinput', (e) => {
  if (e.isComposing || (e.inputType && e.inputType.startsWith('insertComposi'))) swallow(e);
}, true);

ipcRenderer.send('renderer-ready');
