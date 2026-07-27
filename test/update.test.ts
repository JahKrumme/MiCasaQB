import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateController, createReloadGuard, isNewerVersion, UPDATE_STATES } from '../public/update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const updateSource = readFileSync(path.join(__dirname, '../public/update.js'), 'utf-8');

function fakeWorker() {
  return { postMessage: vi.fn() };
}

function makeDeps(overrides: Partial<Parameters<typeof createUpdateController>[0]> = {}) {
  const states: string[] = [];
  const contexts: Array<{ loadedVersion: string | null; serverVersion: string | null; lastCheckedAt: number | null }> = [];
  return {
    deps: {
      getRegistration: vi.fn(async () => null),
      fetchVersion: vi.fn(async () => 'v1'),
      postSkipWaiting: vi.fn(),
      onStateChange: vi.fn((state: string, context: (typeof contexts)[number]) => {
        states.push(state);
        contexts.push(context);
      }),
      hasUnsavedWork: vi.fn(() => false),
      reload: vi.fn(),
      isOnline: vi.fn(() => true),
      ...overrides
    },
    states,
    contexts
  };
}

describe('update controller — checking for updates', () => {
  it('manual check with no service worker: reports up to date after fetching the version', async () => {
    const { deps, states } = makeDeps();
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();

    expect(deps.fetchVersion).toHaveBeenCalledTimes(1);
    expect(states).toEqual([UPDATE_STATES.CHECKING, UPDATE_STATES.IDLE]);
    expect(controller.getState()).toBe(UPDATE_STATES.IDLE);
  });

  it('no update available: two checks with the same server version both settle on idle', async () => {
    const { deps } = makeDeps({ fetchVersion: vi.fn(async () => 'v1') });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();
    await controller.checkForUpdate();

    expect(controller.getState()).toBe(UPDATE_STATES.IDLE);
  });

  it('detects a waiting service worker and moves straight to "available"', async () => {
    const waiting = fakeWorker();
    const registration = { update: vi.fn(async () => {}), waiting };
    const { deps } = makeDeps({ getRegistration: vi.fn(async () => registration) });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();

    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe(UPDATE_STATES.AVAILABLE);
  });

  it('a version-endpoint mismatch (no waiting worker yet) also surfaces "available"', async () => {
    let call = 0;
    const { deps } = makeDeps({
      fetchVersion: vi.fn(async () => (call++ === 0 ? 'v1' : 'v2'))
    });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate(); // establishes "loaded" version v1
    await controller.checkForUpdate(); // server now reports v2

    expect(controller.getState()).toBe(UPDATE_STATES.AVAILABLE);
  });

  it('exposes loadedVersion, serverVersion, and lastCheckedAt for the Admin "Application Updates" display', async () => {
    const { deps, contexts } = makeDeps({ fetchVersion: vi.fn(async () => 'abc123') });
    const controller = createUpdateController(deps);

    const before = Date.now();
    await controller.checkForUpdate();

    const finalContext = contexts.at(-1);
    expect(finalContext?.loadedVersion).toBe('abc123');
    expect(finalContext?.serverVersion).toBe('abc123');
    expect(finalContext?.lastCheckedAt).toBeGreaterThanOrEqual(before);
  });

  it('still fetches the version endpoint even when a waiting worker is already found, so "latest deployed version" stays accurate', async () => {
    const waiting = fakeWorker();
    const registration = { update: vi.fn(async () => {}), waiting };
    const { deps } = makeDeps({ getRegistration: vi.fn(async () => registration), fetchVersion: vi.fn(async () => 'v9') });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();

    expect(deps.fetchVersion).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe(UPDATE_STATES.AVAILABLE);
  });

  it('failed update check: a thrown error surfaces the failed state, not an unhandled rejection', async () => {
    const { deps } = makeDeps({ fetchVersion: vi.fn(async () => { throw new Error('network down'); }) });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();

    expect(controller.getState()).toBe(UPDATE_STATES.FAILED);
  });

  it('offline update check: does not attempt any network call and reports offline', async () => {
    const { deps } = makeDeps({ isOnline: vi.fn(() => false) });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();

    expect(deps.getRegistration).not.toHaveBeenCalled();
    expect(deps.fetchVersion).not.toHaveBeenCalled();
    expect(controller.getState()).toBe(UPDATE_STATES.OFFLINE);
  });
});

describe('update controller — applying an update', () => {
  it('sends SKIP_WAITING to the waiting worker when the user applies the update', async () => {
    const waiting = fakeWorker();
    const registration = { update: vi.fn(async () => {}), waiting };
    const { deps } = makeDeps({ getRegistration: vi.fn(async () => registration) });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();
    await controller.applyUpdate();

    expect(deps.postSkipWaiting).toHaveBeenCalledTimes(1);
    expect(deps.postSkipWaiting).toHaveBeenCalledWith(waiting);
    expect(controller.getState()).toBe(UPDATE_STATES.INSTALLING);
  });

  it('unsaved work blocks the update instead of reloading over it', async () => {
    const waiting = fakeWorker();
    const registration = { update: vi.fn(async () => {}), waiting };
    const { deps } = makeDeps({
      getRegistration: vi.fn(async () => registration),
      hasUnsavedWork: vi.fn(() => true)
    });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();
    await controller.applyUpdate();

    expect(deps.postSkipWaiting).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    // Still "available" — nothing was silently discarded or force-installed.
    expect(controller.getState()).toBe(UPDATE_STATES.AVAILABLE);
  });

  it('reloads exactly once when the new worker takes control, even if controllerchange fires twice', async () => {
    const waiting = fakeWorker();
    const registration = { update: vi.fn(async () => {}), waiting };
    const { deps } = makeDeps({ getRegistration: vi.fn(async () => registration) });
    const controller = createUpdateController(deps);

    await controller.checkForUpdate();
    await controller.applyUpdate();

    controller.onControllerChange();
    controller.onControllerChange();

    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe(UPDATE_STATES.SUCCESS);
  });

  it('reload-loop prevention: a stray controllerchange before any update was requested does not reload', () => {
    const { deps } = makeDeps();
    const controller = createUpdateController(deps);

    controller.onControllerChange();

    expect(deps.reload).not.toHaveBeenCalled();
  });
});

describe('createReloadGuard', () => {
  it('allows exactly one reload', () => {
    const guard = createReloadGuard();
    expect(guard.shouldReload()).toBe(true);
    guard.markReloaded();
    expect(guard.shouldReload()).toBe(false);
    expect(guard.shouldReload()).toBe(false);
  });
});

describe('isNewerVersion', () => {
  it('treats a different, non-empty version as an update', () => {
    expect(isNewerVersion('v1', 'v2')).toBe(true);
  });
  it('treats identical versions as up to date', () => {
    expect(isNewerVersion('v1', 'v1')).toBe(false);
  });
  it('treats missing versions as inconclusive, not an update', () => {
    expect(isNewerVersion(null, 'v2')).toBe(false);
    expect(isNewerVersion('v1', null)).toBe(false);
  });
});

describe('update.js source wiring (static checks — no DOM in this test env)', () => {
  it('posts the exact SKIP_WAITING message shape the service worker listens for', () => {
    expect(updateSource).toMatch(/postMessage\(\{\s*type:\s*['"]SKIP_WAITING['"]\s*\}\)/);
  });

  it('listens for controllerchange and guards the reload behind onControllerChange', () => {
    expect(updateSource).toMatch(/addEventListener\(['"]controllerchange['"]/);
  });

  it('re-checks on visibility change and coming back online', () => {
    expect(updateSource).toMatch(/addEventListener\(['"]visibilitychange['"]/);
    expect(updateSource).toMatch(/addEventListener\(['"]online['"]/);
  });

  it('never executes browser-only wiring when window/document are undefined (Node/vitest safety)', () => {
    expect(updateSource).toMatch(/typeof window !== 'undefined' && typeof document !== 'undefined'/);
  });

  it('dispatches mc-update-state so the header dot can react without the full widget existing', () => {
    expect(updateSource).toMatch(/dispatchEvent\(new CustomEvent\('mc-update-state'/);
  });

  it('exposes window.MCUpdate for the Admin widget and other pages to drive checks', () => {
    expect(updateSource).toMatch(/window\.MCUpdate = \{/);
  });

  it('renders the full widget UI only when its DOM elements exist (chat page has none today)', () => {
    expect(updateSource).toMatch(/if \(!widget \|\| !btn \|\| !labelEl \|\| !statusEl\) return;/);
  });
});
