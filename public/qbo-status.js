// Shared QuickBooks connection-status classifier, used by both the compact
// header badge (public/header.js) and the full status card on the Admin
// page (public/admin.js). Keeping the "what does /api/qbo/status mean"
// logic in one place means the two surfaces can never disagree.
//
// GET /api/qbo/status only requires an authenticated session (any role);
// only admins can act on it (/api/qbo/connect and /disconnect both require
// the admin role) — callers are responsible for hiding actions accordingly.
(function () {
  async function fetchQboStatus() {
    try {
      const res = await fetch('/api/qbo/status');
      if (!res.ok) return { state: 'error', label: 'Error checking connection', detail: 'Could not reach the server.' };
      const data = await res.json();
      return classify(data);
    } catch {
      return { state: 'error', label: 'Error checking connection', detail: 'Could not reach the server. Try refreshing the page.' };
    }
  }

  function classify(data) {
    if (!data.connected) {
      return {
        state: 'reconnect',
        label: 'Not connected',
        detail: 'Connect QuickBooks so staff can create invoices and record payments.',
        realmId: null,
        environment: null
      };
    }

    const refreshExpired = data.refreshTokenExpiresAt && data.refreshTokenExpiresAt < Date.now();
    if (refreshExpired) {
      return {
        state: 'reconnect',
        label: 'Reconnection required',
        detail: `QuickBooks access expired for realm ${data.realmId}.`,
        realmId: data.realmId,
        environment: data.environment
      };
    }

    return {
      state: 'connected',
      label: 'Connected',
      detail: `Realm ${data.realmId} · ${data.environment}`,
      realmId: data.realmId,
      environment: data.environment
    };
  }

  window.MCQboStatus = { fetchQboStatus, classify };
})();
