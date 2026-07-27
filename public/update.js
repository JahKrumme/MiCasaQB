// App-update control: service-worker lifecycle + "Check for Updates" /
// "Update App" widget in the header.
//
// This file is split into two halves on purpose:
//   1. Pure, dependency-injected functions (exported) — no `document`,
//      `navigator`, or `window` reference. These are unit-tested directly
//      under Node/vitest with fake registrations/storage.
//   2. Browser wiring at the bottom, guarded so importing this module under
//      Node (as the tests do) never touches DOM/browser globals.
//
// Loaded as `<script type="module" src="/update.js">`, so it can use
// import/export without a bundler.

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
    case UPDATE_STATES.IDLE:
      return context.version ? `App version ${context.version} · up to date` : null;
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
 */
export function createUpdateController(deps) {
  const { getRegistration, fetchVersion, postSkipWaiting, onStateChange, hasUnsavedWork, reload, isOnline } = deps;
  const reloadGuard = createReloadGuard();

  let state = UPDATE_STATES.IDLE;
  let version = null; // first version this page ever saw (its "loaded" version)
  let waitingWorker = null;
  let versionOnlyUpdate = false; // version differs but no SW handshake to wait for
  let reloadArmed = false;

  function setState(next) {
    state = next;
    onStateChange(state, { version });
  }

  async function checkForUpdate() {
    if (typeof isOnline === 'function' && !isOnline()) {
      setState(UPDATE_STATES.OFFLINE);
      return;
    }
    setState(UPDATE_STATES.CHECKING);
    try {
      const registration = await getRegistration();
      if (registration) {
        await registration.update();
        if (registration.waiting) {
          waitingWorker = registration.waiting;
          setState(UPDATE_STATES.AVAILABLE);
          return;
        }
      }
      const serverVersion = await fetchVersion();
      waitingWorker = null;
      if (version === null) {
        version = serverVersion;
      } else if (isNewerVersion(version, serverVersion)) {
        versionOnlyUpdate = true;
        setState(UPDATE_STATES.AVAILABLE);
        return;
      }
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

function initUpdateUI() {
  const widget = document.getElementById('update-widget');
  const btn = document.getElementById('update-btn');
  const labelEl = document.getElementById('update-btn-label');
  const statusEl = document.getElementById('update-status');
  if (!widget || !btn || !labelEl || !statusEl) return;

  function render(state, context) {
    widget.dataset.state = state;
    btn.disabled = isButtonDisabled(state);
    labelEl.textContent = buttonLabelForState(state);
    statusEl.textContent = statusTextForState(state, context) || '';
  }

  const controller = createUpdateController({
    getRegistration: () => ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : Promise.resolve(null)),
    fetchVersion: async () => {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) throw new Error('version check failed');
      const data = await res.json();
      return data.version;
    },
    postSkipWaiting: worker => worker.postMessage({ type: 'SKIP_WAITING' }),
    onStateChange: render,
    hasUnsavedWork: () => Boolean(window.__hasUnsavedWork && window.__hasUnsavedWork()),
    reload: () => window.location.reload(),
    isOnline: () => navigator.onLine
  });

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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(registration => {
      if (!registration) return;
      if (registration.waiting && navigator.serviceWorker.controller) {
        controller.markUpdateWaiting(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            controller.markUpdateWaiting(registration.waiting || installing);
          }
        });
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => controller.onControllerChange());
  }

  // Initial check + the three re-check triggers the spec calls for.
  controller.checkForUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') controller.checkForUpdate();
  });
  window.addEventListener('online', () => controller.checkForUpdate());
  window.addEventListener('offline', () => render(UPDATE_STATES.OFFLINE, {}));
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUpdateUI);
  } else {
    initUpdateUI();
  }
}
