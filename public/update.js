// App-update lifecycle + the "Application Updates" admin widget.
//
// This file is split into three parts:
//   1. Pure, dependency-injected functions (exported) — no `document`,
//      `navigator`, or `window` reference. Unit-tested directly under
//      Node/vitest with fake registrations/storage.
//   2. Lifecycle wiring, always active on any page that loads this script:
//      registers the update check (on load, on visibility, on reconnect),
//      handles the SKIP_WAITING handshake and the guarded single reload,
//      and dispatches a `mc-update-state` window event on every state
//      change so any page can react (e.g. the header's small update dot)
//      without needing the full widget markup to exist.
//   3. The full widget UI (version numbers, status text, Check for
//      Updates / Update App buttons) — only renders if its DOM elements
//      exist, which today is only true on the Admin page's Application
//      Updates section. The chat page gets the lifecycle without the
//      full controls, per the "move updates into Admin" redesign.
//
// Loaded as `<script type="module" src="/update.js">` on every
// authenticated page, so it can use import/export without a bundler.

export const UPDATE_STATES = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  INSTALLING: 'installing',
  SUCCESS: 'success',
  FAILED: 'failed',
  OFFLINE: 'offline'
};

// Status text shown in the widget. `null` means "no banner text" — the
// caller falls back to showing the current app version instead (idle state).
export function statusTextForState(state, context = {}) {
  switch (state) {
    case UPDATE_STATES.CHECKING:
      return 'Checking for updates…';
    case UPDATE_STATES.AVAILABLE:
      return 'A new version of the app is ready.';
    case UPDATE_STATES.INSTALLING:
      return 'Installing update…';
    case UPDATE_STATES.SUCCESS:
      return 'App updated successfully.';
    case UPDATE_STATES.FAILED:
      return 'Could not update the app. Try again.';
    case UPDATE_STATES.OFFLINE:
      return 'Offline — cannot check for updates right now.';
    case UPDATE_STATES.IDLE: {
      const version = context.serverVersion || context.loadedVersion;
      return version ? `Up to date — version ${version}` : null;
    }
    default:
      return null;
  }
}

export function buttonLabelForState(state) {
  if (state === UPDATE_STATES.AVAILABLE) return 'Update App';
  if (state === UPDATE_STATES.FAILED) return 'Retry';
  return 'Check for Updates';
}

export function isButtonDisabled(state) {
  return state === UPDATE_STATES.CHECKING || state === UPDATE_STATES.INSTALLING;
}

// Guards against a reload loop: at most one reload happens per page load,
// no matter how many controllerchange events fire.
export function createReloadGuard() {
  let reloaded = false;
  return {
    shouldReload() {
      return !reloaded;
    },
    markReloaded() {
      reloaded = true;
    }
  };
}

export function isNewerVersion(loadedVersion, serverVersion) {
  if (!loadedVersion || !serverVersion) return false;
  return loadedVersion !== serverVersion;
}

/**
 * Dependency-injected update controller. Every side effect (SW registration,
 * network, reload, storage) is passed in, so this is fully testable without
 * a browser.
 *
 * deps:
 *   getRegistration()      -> Promise<ServiceWorkerRegistration|null>
 *   fetchVersion()         -> Promise<string>            (throws on failure)
 *   postSkipWaiting(worker)-> void
 *   onStateChange(state, context) -> void
 *   hasUnsavedWork()       -> boolean
 *   reload()               -> void
 *   isOnline()             -> boolean
 *
 * context passed to onStateChange: { loadedVersion, serverVersion, lastCheckedAt }
 *   - loadedVersion: the first version this page ever observed (its baseline)
 *   - serverVersion: the most recently fetched /api/version value
 *   - lastCheckedAt: epoch ms of the most recent check attempt
 */
export function createUpdateController(deps) {
  const { getRegistration, fetchVersion, postSkipWaiting, onStateChange, hasUnsavedWork, reload, isOnline } = deps;
  const reloadGuard = createReloadGuard();

  let state = UPDATE_STATES.IDLE;
  let loadedVersion = null;
  let serverVersion = null;
  let lastCheckedAt = null;
  let waitingWorker = null;
  let versionOnlyUpdate = false; // version differs but no SW handshake to wait for
  let reloadArmed = false;

  function setState(next) {
    state = next;
    onStateChange(state, { loadedVersion, serverVersion, lastCheckedAt });
  }

  async function checkForUpdate() {
    lastCheckedAt = Date.now();
    if (typeof isOnline === 'function' && !isOnline()) {
      setState(UPDATE_STATES.OFFLINE);
      return;
    }
    setState(UPDATE_STATES.CHECKING);
    try {
      const registration = await getRegistration();
      let waitingFound = false;
      if (registration) {
        await registration.update();
        if (registration.waiting) {
          waitingWorker = registration.waiting;
          waitingFound = true;
        }
      }

      serverVersion = await fetchVersion();
      if (loadedVersion === null) loadedVersion = serverVersion;

      if (waitingFound) {
        versionOnlyUpdate = false;
        setState(UPDATE_STATES.AVAILABLE);
        return;
      }
      if (isNewerVersion(loadedVersion, serverVersion)) {
        versionOnlyUpdate = true;
        setState(UPDATE_STATES.AVAILABLE);
        return;
      }
      waitingWorker = null;
      versionOnlyUpdate = false;
      setState(UPDATE_STATES.IDLE);
    } catch {
      setState(UPDATE_STATES.FAILED);
    }
  }

  function markUpdateWaiting(worker) {
    waitingWorker = worker;
    versionOnlyUpdate = false;
    setState(UPDATE_STATES.AVAILABLE);
  }

  async function applyUpdate() {
    if (!waitingWorker && !versionOnlyUpdate) return;
    if (typeof hasUnsavedWork === 'function' && hasUnsavedWork()) {
      // Refuse silently at this layer — the caller (UI) is responsible for
      // telling the user why nothing happened, so no work is ever discarded.
      return;
    }
    setState(UPDATE_STATES.INSTALLING);
    reloadArmed = true;
    if (waitingWorker) {
      // Reload happens from onControllerChange() once the new worker takes over.
      postSkipWaiting(waitingWorker);
    } else {
      // No service worker in the picture (or it hasn't surfaced a waiting
      // worker yet) — the version endpoint already disagrees with what this
      // page loaded, so a plain reload is enough to pick up the new deploy.
      reloadGuard.markReloaded();
      setState(UPDATE_STATES.SUCCESS);
      reload();
    }
  }

  function onControllerChange() {
    if (!reloadArmed) return;
    if (!reloadGuard.shouldReload()) return;
    reloadGuard.markReloaded();
    setState(UPDATE_STATES.SUCCESS);
    reload();
  }

  return {
    checkForUpdate,
    applyUpdate,
    markUpdateWaiting,
    onControllerChange,
    getState: () => state
  };
}

// ---------------------------------------------------------------------------
// Browser wiring — never runs under Node/vitest.
// ---------------------------------------------------------------------------

let sharedController = null;
let latestState = UPDATE_STATES.IDLE;
let latestContext = { loadedVersion: null, serverVersion: null, lastCheckedAt: null };

function initUpdateLifecycle() {
  if (sharedController) return sharedController;

  sharedController = createUpdateController({
    getRegistration: () => ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null)),
    fetchVersion: async () => {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) throw new Error('version check failed');
      const data = await res.json();
      return data.version;
    },
    postSkipWaiting: worker => worker.postMessage({ type: 'SKIP_WAITING' }),
    onStateChange: (state, context) => {
      latestState = state;
      latestContext = context;
      window.dispatchEvent(new CustomEvent('mc-update-state', { detail: { state, context } }));
    },
    hasUnsavedWork: () => Boolean(window.__hasUnsavedWork && window.__hasUnsavedWork()),
    reload: () => window.location.reload(),
    isOnline: () => navigator.onLine
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(registration => {
      if (!registration) return;
      if (registration.waiting && navigator.serviceWorker.controller) {
        sharedController.markUpdateWaiting(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            sharedController.markUpdateWaiting(registration.waiting || installing);
          }
        });
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => sharedController.onControllerChange());
  }

  // Initial check + the three re-check triggers the spec calls for.
  sharedController.checkForUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sharedController.checkForUpdate();
  });
  window.addEventListener('online', () => sharedController.checkForUpdate());
  window.addEventListener('offline', () => sharedController.checkForUpdate());

  window.MCUpdate = {
    checkForUpdate: () => sharedController.checkForUpdate(),
    applyUpdate: () => sharedController.applyUpdate(),
    getState: () => latestState,
    getContext: () => latestContext
  };

  return sharedController;
}

function formatCheckedTime(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function initUpdateWidgetUI(controller) {
  const widget = document.getElementById('update-widget');
  const btn = document.getElementById('update-btn');
  const labelEl = document.getElementById('update-btn-label');
  const statusEl = document.getElementById('update-status');
  if (!widget || !btn || !labelEl || !statusEl) return;

  const currentVersionEl = document.getElementById('update-current-version');
  const latestVersionEl = document.getElementById('update-latest-version');
  const lastCheckedEl = document.getElementById('update-last-checked');

  function render(state, context) {
    widget.dataset.state = state;
    btn.disabled = isButtonDisabled(state);
    labelEl.textContent = buttonLabelForState(state);
    statusEl.textContent = statusTextForState(state, context) || '';
    if (currentVersionEl) currentVersionEl.textContent = context.loadedVersion || '—';
    if (latestVersionEl) latestVersionEl.textContent = context.serverVersion || '—';
    if (lastCheckedEl) lastCheckedEl.textContent = formatCheckedTime(context.lastCheckedAt);
  }

  btn.addEventListener('click', () => {
    if (controller.getState() === UPDATE_STATES.AVAILABLE) {
      if (window.__hasUnsavedWork && window.__hasUnsavedWork()) {
        statusEl.textContent = 'Finish or save your current work, then click Update App again.';
        return;
      }
      controller.applyUpdate();
    } else {
      controller.checkForUpdate();
    }
  });

  window.addEventListener('mc-update-state', e => render(e.detail.state, e.detail.context));
  render(latestState, latestContext);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    const controller = initUpdateLifecycle();
    initUpdateWidgetUI(controller);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
