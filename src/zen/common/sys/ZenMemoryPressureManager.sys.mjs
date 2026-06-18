// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const PREF_BRANCH = "zen.tab-unloader.";
const MEMORY_PRESSURE_TOPIC = "memory-pressure";

function boolPref(name, fallback) {
  return Services.prefs.getBoolPref(PREF_BRANCH + name, fallback);
}

function intPref(name, fallback) {
  return Services.prefs.getIntPref(PREF_BRANCH + name, fallback);
}

function now() {
  return Date.now();
}

export const ZenMemoryPressureManager = {
  _windows: new Set(),
  _loadStallTimers: new WeakMap(),
  _scanTimer: null,
  _initialized: false,
  _runningCycle: false,

  init(win) {
    if (!win?.gBrowser || this._windows.has(win)) {
      return;
    }
    this._windows.add(win);
    win.gBrowser.addTabsProgressListener(this);
    win.addEventListener("TabAttrModified", this);
    win.addEventListener("TabClose", this);
    win.addEventListener("unload", this, { once: true });

    if (!this._initialized) {
      Services.obs.addObserver(this, MEMORY_PRESSURE_TOPIC);
      this._initialized = true;
    }
    this._scheduleScan();
  },

  uninit(win) {
    if (!this._windows.delete(win)) {
      return;
    }
    this._clearLoadStallTimer(win);
    win.gBrowser?.removeTabsProgressListener(this);
    win.removeEventListener("TabAttrModified", this);
    win.removeEventListener("TabClose", this);
    win.removeEventListener("unload", this);

    if (this._windows.size === 0) {
      this._clearScanTimer();
      if (this._initialized) {
        Services.obs.removeObserver(this, MEMORY_PRESSURE_TOPIC);
        this._initialized = false;
      }
    }
  },

  observe(_subject, topic) {
    if (topic === MEMORY_PRESSURE_TOPIC) {
      this.runCycle("memory-pressure");
    }
  },

  handleEvent(event) {
    if (event.type === "unload") {
      this.uninit(event.currentTarget);
      return;
    }
    if (event.type === "TabClose") {
      this._clearLoadStallTimer(event.currentTarget);
    }
  },

  onStateChange(browser, _webProgress, _request, stateFlags) {
    const win = browser.ownerGlobal;
    if (!win || !this._windows.has(win) || browser !== win.gBrowser.selectedBrowser) {
      return;
    }
    if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
      this._armLoadStallTimer(win);
    } else if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
      this._clearLoadStallTimer(win);
    }
  },

  async runCycle(reason = "scan") {
    if (!this._enabled || this._runningCycle) {
      return { unloaded: 0, candidates: 0 };
    }
    this._runningCycle = true;
    try {
      const emergency = reason === "memory-pressure" || reason === "load-stall";
      const maxUnloads = emergency
        ? intPref("max-emergency-unloads-per-cycle", 8)
        : intPref("max-unloads-per-cycle", 3);
      const candidates = this._collectCandidates({ reason, emergency });
      let unloaded = 0;
      for (const candidate of candidates) {
        if (unloaded >= maxUnloads) {
          break;
        }
        const result = await candidate.win.gBrowser.explicitUnloadTabs([
          candidate.tab,
        ]);
        if (result !== false) {
          unloaded++;
        }
      }
      if (unloaded) {
        this._refreshTabsToolbar();
        this._log("unloaded", unloaded, "tabs for", reason);
      }
      return { unloaded, candidates: candidates.length };
    } finally {
      this._runningCycle = false;
      this._scheduleScan();
    }
  },

  runCycleForTesting(reason, options = {}) {
    if (!this._testingEnabled) {
      throw new Error("runCycleForTesting is only available in Zen tests");
    }
    return this.runCycle(reason, options);
  },

  collectCandidatesForTesting(win) {
    if (!this._testingEnabled) {
      throw new Error(
        "collectCandidatesForTesting is only available in Zen tests"
      );
    }
    return this._collectCandidates({ reason: "testing", testWindow: win });
  },

  resetForTesting() {
    if (!this._testingEnabled) {
      throw new Error("resetForTesting is only available in Zen tests");
    }
    this._clearScanTimer();
    for (const win of this._windows) {
      this._clearLoadStallTimer(win);
    }
    this._runningCycle = false;
  },

  get _enabled() {
    return boolPref("auto-enabled", true);
  },

  get _testingEnabled() {
    return Services.prefs.getBoolPref("zen.testing.enabled", false);
  },

  _collectCandidates({ reason, emergency = false, testWindow = null } = {}) {
    const idleMs =
      reason === "scan" && !emergency
        ? intPref("timeout-minutes", 10) * 60 * 1000
        : 0;
    const minLoaded = emergency
      ? 1
      : intPref("min-loaded-tabs-before-pressure", 8);
    const cutoff = now() - idleMs;
    const candidates = [];

    for (const win of this._browserWindows(testWindow)) {
      const tabs = Array.from(win.gZenWorkspaces?.allStoredTabs ?? []);
      const loadedTabs = tabs.filter(tab => this._isLoadedTab(tab));
      if (loadedTabs.length < minLoaded) {
        continue;
      }
      for (const tab of loadedTabs) {
        if (!this._isSafeCandidate(win, tab, cutoff)) {
          continue;
        }
        candidates.push({
          tab,
          win,
          score: this._scoreCandidate(win, tab),
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  },

  *_browserWindows(testWindow = null) {
    if (testWindow) {
      yield testWindow;
      return;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowser && win.gZenWorkspaces) {
        yield win;
      }
    }
  },

  _isLoadedTab(tab) {
    return (
      !tab.hasAttribute("pending") &&
      !tab.hasAttribute("discarded") &&
      tab.linkedBrowser?.isConnected
    );
  },

  _isSafeCandidate(win, tab, cutoff) {
    if (
      tab.closing ||
      tab.selected ||
      tab.pinned ||
      tab.hasAttribute("pending") ||
      tab.hasAttribute("discarded") ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-essential") ||
      tab.hasAttribute("zen-glance-tab") ||
      tab.hasAttribute("split-view") ||
      tab.group?.hasAttribute("split-view-group") ||
      tab.hasAttribute("pictureinpicture") ||
      tab.hasAttribute("sharing") ||
      tab.hasAttribute("soundplaying") ||
      tab.linkedBrowser?.zenModeActive ||
      tab.lastAccessed > cutoff
    ) {
      return false;
    }

    const browser = tab.linkedBrowser;
    return !(
      win.PictureInPicture?.isOriginatingBrowser?.(browser) ||
      win.webrtcUI?.browserHasStreams(browser) ||
      browser?.browsingContext?.currentWindowGlobal?.hasActivePeerConnections()
    );
  },

  _scoreCandidate(win, tab) {
    let score = now() - (tab.lastAccessed || 0);
    if (
      tab.getAttribute("zen-workspace-id") !== win.gZenWorkspaces.activeWorkspace
    ) {
      score += 60 * 60 * 1000;
    }
    if (!tab.visible || tab.hidden) {
      score += 30 * 60 * 1000;
    }
    if (win !== Services.wm.getMostRecentWindow("navigator:browser")) {
      score += 15 * 60 * 1000;
    }
    return score;
  },

  _armLoadStallTimer(win) {
    this._clearLoadStallTimer(win);
    const delay = intPref("load-stall-seconds", 30) * 1000;
    const timer = win.setTimeout(() => {
      const tab = win.gBrowser.selectedTab;
      if (tab?.hasAttribute("busy")) {
        this.runCycle("load-stall");
      }
      this._loadStallTimers.delete(win);
    }, delay);
    this._loadStallTimers.set(win, timer);
  },

  _clearLoadStallTimer(win) {
    const timer = this._loadStallTimers.get(win);
    if (timer) {
      win.clearTimeout(timer);
      this._loadStallTimers.delete(win);
    }
  },

  _scheduleScan() {
    this._clearScanTimer();
    if (!this._enabled || !this._windows.size) {
      return;
    }
    const delay = intPref("scan-interval-seconds", 60) * 1000;
    this._scanTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._scanTimer.initWithCallback(
      () => this.runCycle("scan"),
      delay,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
  },

  _clearScanTimer() {
    if (this._scanTimer) {
      this._scanTimer.cancel();
      this._scanTimer = null;
    }
  },

  _refreshTabsToolbar() {
    for (const win of this._windows) {
      win.gZenUIManager?.updateTabsToolbar();
    }
  },

  _log(...args) {
    if (boolPref("log", false)) {
      console.log("ZenMemoryPressureManager:", ...args);
    }
  },
};
