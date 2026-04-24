// tmux-backend.js — thin wrapper around a bundled tmux binary.
//
// ophanim hosts every terminal pane's shell inside a dedicated tmux server
// so that shells outlive the Electron process. Benefits:
//   - Quit ophanim → shells keep running. Relaunch → reattach and everything
//     (scrollback, cwd, running processes, ssh sessions) is still there.
//   - Converting a term pane to a browser pane no longer SIGHUPs the shell —
//     we only kill the attach client, the session stays alive.
//   - External terminals can `tmux -L ophanim attach -t term-pN` to see the
//     same shell ophanim is showing.
//
// We own a tiny `ophanim-tmux.conf` that neuters every tmux UI feature so
// tmux is purely a PTY supervisor — no status bar, no prefix keys, no mouse
// capture. Everything a user types flows straight to the shell.
//
// If the bundled binary is missing and no override is set, `available()`
// returns false and main.js falls back to direct node-pty spawning (today's
// behavior, no persistence).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

const SOCKET_LABEL = 'ophanim';

// Translate an ophanim-style key ("Option+Tab", "Shift+I", "Alt+X") to
// tmux's notation ("M-Tab", "I", "M-x"). Letters + Shift collapse to
// uppercase (tmux's convention); Option/Alt → M-, Ctrl → C-. Cmd is
// discarded — tmux can't see it and it wouldn't be useful here anyway.
function toTmuxKey(key) {
  const parts = String(key || '').split('+').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  let k = parts.pop();
  const mods = parts.map(s => s.toLowerCase());
  if (mods.includes('shift') && /^[a-zA-Z]$/.test(k)) {
    k = k.toUpperCase();
  }
  let prefix = '';
  if (mods.includes('ctrl') || mods.includes('control')) prefix = 'C-' + prefix;
  if (mods.includes('alt') || mods.includes('option')) prefix = 'M-' + prefix;
  if (mods.includes('shift') && !/^[A-Z]$/.test(k)) prefix = 'S-' + prefix;
  return prefix + k;
}

function renderTmuxConf(scroll) {
  const enter    = toTmuxKey(scroll.enterKey)   || 'M-Tab';
  const up       = toTmuxKey(scroll.upKey)      || 'i';
  const down     = toTmuxKey(scroll.downKey)    || 'k';
  const fastUp   = toTmuxKey((scroll.fasterModifier || 'Shift') + '+' + scroll.upKey);
  const fastDown = toTmuxKey((scroll.fasterModifier || 'Shift') + '+' + scroll.downKey);
  const nBase    = Math.max(1, Math.floor(Number(scroll.linesPerPress)    || 2));
  const nFast    = Math.max(1, Math.floor(nBase * (Number(scroll.fasterMultiplier) || 10)));
  return `# ophanim runtime tmux config — generated from user config, do not edit.
# tmux is purely a PTY supervisor here; everything that could intercept
# keystrokes, mutate the visible buffer, or change sizing behavior in
# surprising ways is disabled.
set -g prefix None
unbind-key -a
set -g status off
set -g mouse off
set -g exit-empty off
set -g default-terminal tmux-256color
set -g history-limit 50000
set -g window-size latest
set -g detach-on-destroy off
# DCS-wrapped OSC 1983 from the 'browse' / 'config' shell helpers needs
# this to pass through to the attach client.
set -g allow-passthrough on

# Scroll mode. ${scroll.enterKey} toggles tmux copy-mode (frozen view of the
# pane's scrollback). Inside, ${scroll.upKey}/${scroll.downKey} step ${nBase} line(s),
# ${scroll.fasterModifier}+${scroll.upKey}/${scroll.fasterModifier}+${scroll.downKey} step ${nFast}. q / Escape exit
# (tmux defaults, not touched by unbind-key -a above).
bind -n ${enter} if -F '#{pane_in_mode}' 'send-keys -X cancel' 'copy-mode'
bind -T copy-mode ${up}       send-keys -X -N ${nBase} scroll-up
bind -T copy-mode ${down}     send-keys -X -N ${nBase} scroll-down
bind -T copy-mode ${fastUp}   send-keys -X -N ${nFast} scroll-up
bind -T copy-mode ${fastDown} send-keys -X -N ${nFast} scroll-down
`;
}

function createBackend({ unpackedDir, userDataDir, getOverridePath, getScrollConfig }) {
  let confPath = null;
  let cachedTmuxPath = undefined; // undefined = not yet resolved, null = unavailable, string = path

  function bundledTmuxPath() {
    return path.join(unpackedDir, 'build', 'vendor', `tmux-${process.arch}`, 'tmux');
  }

  function resolveTmuxPath() {
    // User-configured override wins if valid.
    const override = (getOverridePath && getOverridePath()) || '';
    if (override && typeof override === 'string') {
      try {
        fs.accessSync(override, fs.constants.X_OK);
        return override;
      } catch {
        console.warn('[tmux-backend] terminal.tmuxPath set but not executable:', override);
      }
    }
    // Otherwise the bundled binary.
    const bundled = bundledTmuxPath();
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      return null;
    }
  }

  function tmuxPath() {
    if (cachedTmuxPath === undefined) cachedTmuxPath = resolveTmuxPath();
    return cachedTmuxPath;
  }

  // Clear the cache so a config change (terminal.tmuxPath) takes effect
  // without restarting. main.js can call this from its config reload hook.
  function invalidatePathCache() { cachedTmuxPath = undefined; }

  function available() { return tmuxPath() !== null; }

  function currentScrollConfig() {
    return (getScrollConfig && getScrollConfig()) || {
      enterKey: 'Option+Tab', upKey: 'i', downKey: 'k',
      linesPerPress: 2, fasterModifier: 'Shift', fasterMultiplier: 10,
    };
  }

  function writeConfFile() {
    const p = path.join(userDataDir, 'ophanim-tmux.conf');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(p, renderTmuxConf(currentScrollConfig()));
    return p;
  }

  function ensureConfFile() {
    if (confPath) return confPath;
    try { confPath = writeConfFile(); }
    catch (e) {
      console.warn('[tmux-backend] could not write conf file:', e.message);
      confPath = null;
    }
    // Apply the full conf to any already-running server. Config files
    // are only read at server startup; without this, sessions created by
    // an older ophanim launch wouldn't pick up new bindings until the
    // user killed the tmux server. Best-effort — silently no-ops if
    // there's no server yet.
    if (confPath) { try { runControl(['source-file', confPath]); } catch {} }
    return confPath;
  }

  // Called from main.js on config reload so edits to terminal.scroll
  // take effect without relaunching. Rewrites the conf file and
  // source-files it into the running server.
  function reloadConf() {
    try { confPath = writeConfFile(); }
    catch (e) { console.warn('[tmux-backend] reloadConf write failed:', e.message); return; }
    if (!available()) return;
    try { runControl(['source-file', confPath]); } catch {}
  }

  function baseArgs() {
    const args = ['-L', SOCKET_LABEL];
    const conf = ensureConfFile();
    if (conf) args.push('-f', conf);
    return args;
  }

  function runControl(extraArgs, opts = {}) {
    const bin = tmuxPath();
    if (!bin) throw new Error('tmux not available');
    return execFileSync(bin, [...baseArgs(), ...extraArgs], {
      encoding: 'utf8',
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env,
    });
  }

  function hasSession(sessionName) {
    if (!available()) return false;
    try {
      runControl(['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  function createSession(sessionName, { shellCommand, env, cwd }) {
    if (!available()) throw new Error('tmux not available');
    const args = [
      'new-session', '-d',
      '-s', sessionName,
      '-x', '200', '-y', '50',      // initial size; resized on attach
      '-c', cwd || process.env.HOME || '/',
    ];
    // shellCommand is a single pre-quoted shell command line; tmux runs
    // it via /bin/sh -c. If omitted, tmux uses default-shell (usually
    // $SHELL or /bin/sh).
    if (shellCommand) args.push(shellCommand);
    runControl(args, { env: env || process.env });
  }

  function killSession(sessionName) {
    if (!available()) return;
    try {
      runControl(['kill-session', '-t', sessionName]);
    } catch {
      // Already gone — benign.
    }
  }

  function listSessions() {
    if (!available()) return [];
    try {
      const out = runControl(['list-sessions', '-F', '#{session_name}']);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];  // no sessions = non-zero exit
    }
  }

  function attach(sessionName, { cols, rows, env }) {
    if (!available()) throw new Error('tmux not available');
    // TMUX env var has to be unset; tmux refuses to attach from inside an
    // existing client otherwise ("sessions should be nested with care").
    const childEnv = { ...(env || process.env), TMUX: '' };
    const args = [...baseArgs(), 'attach-session', '-t', sessionName];
    return pty.spawn(tmuxPath(), args, {
      name: 'tmux-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd: childEnv.HOME || '/',
      env: childEnv,
    });
  }

  return {
    available,
    tmuxPath,
    invalidatePathCache,
    reloadConf,
    hasSession,
    createSession,
    killSession,
    listSessions,
    attach,
  };
}

module.exports = { createBackend, SOCKET_LABEL };
