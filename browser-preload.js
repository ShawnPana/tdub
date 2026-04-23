// Preload runs in each browser pane's webContents BEFORE any page JS.
// With contextIsolation: false we can modify page globals directly.

const { ipcRenderer } = require('electron');

try {
  const m = String(navigator.userAgent || '').match(/Chrome\/(\d+)/);
  const major = m ? m[1] : '146';
  const full = (process.versions && process.versions.chrome) || major + '.0.0.0';
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not?A_Brand', version: '99' },
  ];
  const fullVersionList = [
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
    { brand: 'Not?A_Brand', version: '99.0.0.0' },
  ];
  const platform = (navigator.userAgent || '').includes('Mac') ? 'macOS' : 'Unknown';
  const fakeUAD = {
    brands,
    mobile: false,
    platform,
    getHighEntropyValues(hints) {
      const out = { brands, mobile: false, platform };
      if (hints && hints.includes('fullVersionList')) out.fullVersionList = fullVersionList;
      if (hints && hints.includes('architecture')) out.architecture = 'arm';
      if (hints && hints.includes('bitness')) out.bitness = '64';
      if (hints && hints.includes('model')) out.model = '';
      if (hints && hints.includes('platformVersion')) out.platformVersion = '15.0.0';
      if (hints && hints.includes('uaFullVersion')) out.uaFullVersion = full;
      if (hints && hints.includes('wow64')) out.wow64 = false;
      return Promise.resolve(out);
    },
    toJSON() { return { brands, mobile: false, platform }; },
  };

  // userAgentData may be non-configurable on the instance; override the prototype getter too.
  const proto = Object.getPrototypeOf(navigator);
  try { Object.defineProperty(navigator, 'userAgentData', { value: fakeUAD, configurable: true }); } catch {}
  try { Object.defineProperty(proto, 'userAgentData', { get() { return fakeUAD; }, configurable: true }); } catch {}

  // window.chrome: real Chrome has these functions. Embedded webviews often don't.
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.app) window.chrome.app = { isInstalled: false };
  if (!window.chrome.csi) window.chrome.csi = function () { return { onloadT: Date.now(), pageT: 0, startE: Date.now(), tran: 15 }; };
  if (!window.chrome.loadTimes) window.chrome.loadTimes = function () {
    return {
      commitLoadTime: 0, connectionInfo: 'h3', finishDocumentLoadTime: 0,
      finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0,
      navigationType: 'Other', npnNegotiatedProtocol: 'h3', requestTime: 0,
      startLoadTime: 0, wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true, wasNpnNegotiated: true,
    };
  };
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
    };
  }

  // navigator.plugins / mimeTypes — real Chrome exposes a PDF viewer.
  try {
    const pdf = {
      name: 'Chrome PDF Plugin',
      description: 'Portable Document Format',
      filename: 'internal-pdf-viewer',
      length: 1,
      0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    };
    const pluginArray = [pdf];
    pluginArray.item = (i) => pluginArray[i];
    pluginArray.namedItem = (n) => pluginArray.find(p => p.name === n);
    pluginArray.refresh = () => {};
    Object.defineProperty(navigator, 'plugins', { get() { return pluginArray; }, configurable: true });
  } catch {}

  // navigator.permissions.query — some checks query 'notifications' and
  // look for `default` vs `prompt`; headless returns the wrong one.
  try {
    const orig = navigator.permissions && navigator.permissions.query
      ? navigator.permissions.query.bind(navigator.permissions) : null;
    if (orig) {
      navigator.permissions.query = (p) => {
        if (p && p.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, name: 'notifications' });
        }
        return orig(p);
      };
    }
  } catch {}

  // Languages: Electron's default is fine, but some checks want non-empty.
  if (!Array.isArray(navigator.languages) || navigator.languages.length === 0) {
    try { Object.defineProperty(navigator, 'languages', { get() { return ['en-US', 'en']; }, configurable: true }); } catch {}
  }

  ipcRenderer.send('preload-debug', {
    url: location.href,
    ua: navigator.userAgent,
    brands: (navigator.userAgentData && navigator.userAgentData.brands) || null,
    plugins: navigator.plugins && navigator.plugins.length,
    chromeRuntime: !!(window.chrome && window.chrome.runtime),
  });
} catch (e) {
  try { ipcRenderer.send('preload-debug', { fatal: String(e) }); } catch {}
}
