// Shared 3-zone application header — used by index.html (chat) and
// admin.html so both pages get byte-identical markup, styling, and
// behavior for branding, organization switching, QuickBooks connection
// status, and the account menu. Keeping this in one file is what makes
// "Mi Casa and Access Mental Health headers use the same alignment
// structure" true by construction instead of by coincidence.
//
// Usage: `<div id="app-header-root"></div>` somewhere in <body>, then
// `MCHeader.mount(sessionData)` once the page's own auth guard has a
// resolved, authenticated session (sessionData is whatever
// /api/auth/session returned — {email, isAdmin, themePreference, ...}).
// Mounting reads/writes the same 'qb-mode' sessionStorage key app.js has
// always used, so switching organizations here and on the chat page stays
// in sync.
(function () {
  const MODE_STORAGE_KEY = 'qb-mode';

  const BRAND = {
    micasa: {
      title: 'Mi Casa QuickBooks Assistant',
      subtitle: 'Powered by Mi Casa Care Homes',
      switchLabel: 'Mi Casa',
      ariaLabel: 'Mi Casa QuickBooks Assistant — go to dashboard',
      logo: { light: '/assets/brand/mi-casa-icon-black.png', dark: '/assets/brand/mi-casa-icon-white.png' },
      alt: 'Mi Casa'
    },
    access: {
      title: 'Access QuickBooks Assistant',
      subtitle: 'Powered by Access Mental Health',
      switchLabel: 'Access Mental Health',
      ariaLabel: 'Access QuickBooks Assistant — go to dashboard',
      logo: { light: '/assets/brand/access-mental-health-logo.png', dark: '/assets/brand/access-mental-health-logo-dark.png' },
      alt: 'Access Mental Health'
    }
  };

  function getMode() {
    return sessionStorage.getItem(MODE_STORAGE_KEY) === 'access' ? 'access' : 'micasa';
  }

  function currentResolvedTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  function render(root) {
    root.appendChild(
      el(`
      <header class="app-header">
        <div class="app-header-inner app-shell">
          <div class="header-zone header-zone-left">
            <a href="/" id="header-brand-link" class="header-brand">
              <img id="brand-logo" class="brand-logo" src="" alt="">
              <span class="brand-text">
                <span class="brand-title" id="brand-title"></span>
                <span class="brand-subtitle" id="brand-subtitle"></span>
              </span>
            </a>
          </div>
          <div class="header-zone header-zone-center">
            <div class="org-switcher" role="group" aria-label="Organization">
              <button type="button" class="org-switch-btn" id="org-switch-micasa">Mi Casa</button>
              <button type="button" class="org-switch-btn" id="org-switch-access">Access Mental Health</button>
            </div>
          </div>
          <div class="header-zone header-zone-right">
            <span class="qbo-badge" id="qbo-badge" hidden>
              <span class="qbo-dot" id="qbo-dot" aria-hidden="true"></span>
              <span class="qbo-badge-label" id="qbo-badge-label">Checking connection…</span>
              <a href="/api/qbo/connect" class="qbo-badge-action" id="qbo-badge-action" hidden>Reconnect</a>
            </span>
            <details class="account-menu" id="account-menu">
              <summary class="account-menu-trigger" aria-label="Account menu">
                <span class="account-avatar" id="account-avatar" aria-hidden="true">?</span>
                <span class="update-dot" id="update-dot" hidden aria-hidden="true"></span>
              </summary>
              <div class="account-menu-panel" role="menu">
                <div class="account-menu-email" id="account-menu-email" role="none"></div>
                <a href="/admin.html" class="account-menu-item" id="account-menu-admin" role="menuitem" hidden>Admin</a>
                <button type="button" class="account-menu-item" id="install-menu-item" role="menuitem" hidden>Install App</button>
                <button type="button" class="account-menu-item account-menu-signout" id="signout-btn" role="menuitem">Sign Out</button>
                <div class="account-menu-orgs" id="account-menu-orgs" role="none">
                  <div class="account-menu-org-label" role="none">Organization</div>
                  <button type="button" class="account-menu-item" id="org-menu-micasa" role="menuitemradio">Mi Casa</button>
                  <button type="button" class="account-menu-item" id="org-menu-access" role="menuitemradio">Access Mental Health</button>
                </div>
              </div>
            </details>
          </div>
        </div>
      </header>
    `)
    );
  }

  function applyBranding(mode) {
    const brand = BRAND[mode];
    const theme = currentResolvedTheme();
    document.getElementById('brand-logo').src = brand.logo[theme];
    document.getElementById('brand-logo').alt = brand.alt;
    document.getElementById('brand-title').textContent = brand.title;
    document.getElementById('brand-subtitle').textContent = brand.subtitle;
    document.getElementById('header-brand-link').setAttribute('aria-label', brand.ariaLabel);
    document.title = brand.title;

    const micasaBtn = document.getElementById('org-switch-micasa');
    const accessBtn = document.getElementById('org-switch-access');
    micasaBtn.classList.toggle('is-active', mode === 'micasa');
    micasaBtn.setAttribute('aria-pressed', String(mode === 'micasa'));
    accessBtn.classList.toggle('is-active', mode === 'access');
    accessBtn.setAttribute('aria-pressed', String(mode === 'access'));

    // Mirrored inside the account menu for narrow viewports (see the
    // max-width: 480px rule in styles.css) — same state, different control.
    const micasaMenuBtn = document.getElementById('org-menu-micasa');
    const accessMenuBtn = document.getElementById('org-menu-access');
    micasaMenuBtn.classList.toggle('is-active', mode === 'micasa');
    micasaMenuBtn.setAttribute('aria-checked', String(mode === 'micasa'));
    accessMenuBtn.classList.toggle('is-active', mode === 'access');
    accessMenuBtn.setAttribute('aria-checked', String(mode === 'access'));

    document.body.classList.toggle('access-mode', mode === 'access');
    document.getElementById('app')?.classList.toggle('access-mode', mode === 'access');
  }

  function switchMode(mode) {
    sessionStorage.setItem(MODE_STORAGE_KEY, mode);
    applyBranding(mode);
    window.dispatchEvent(new CustomEvent('mc-org-change', { detail: { mode } }));
  }

  async function loadQboBadge(isAdmin) {
    const badge = document.getElementById('qbo-badge');
    const label = document.getElementById('qbo-badge-label');
    const dot = document.getElementById('qbo-dot');
    const action = document.getElementById('qbo-badge-action');
    if (!window.MCQboStatus) return;

    badge.hidden = false;
    const status = await window.MCQboStatus.fetchQboStatus();
    badge.className = 'qbo-badge is-' + status.state;
    label.textContent = status.label;
    badge.title = status.detail || '';
    if (isAdmin && status.state === 'reconnect') {
      action.hidden = false;
      action.textContent = status.label === 'Not connected' ? 'Connect' : 'Reconnect';
    } else {
      action.hidden = true;
    }
    void dot;
  }

  function wireAccountMenu(sessionData) {
    document.getElementById('account-menu-email').textContent = sessionData.email || '';
    const initial = (sessionData.email || '?').trim().charAt(0).toUpperCase() || '?';
    document.getElementById('account-avatar').textContent = initial;

    const adminItem = document.getElementById('account-menu-admin');
    adminItem.hidden = !sessionData.isAdmin;

    document.getElementById('signout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

    // Close the <details> menu on outside click / Escape / item activation —
    // native <details> gives us keyboard toggling and focus for free, this
    // just adds the "closes like a normal menu" polish on top.
    const menu = document.getElementById('account-menu');
    document.addEventListener('click', e => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
    menu.querySelectorAll('.account-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        menu.open = false;
      });
    });
  }

  function setInstallAvailable(onInstallClick) {
    const item = document.getElementById('install-menu-item');
    item.hidden = false;
    item.onclick = onInstallClick;
  }

  function hideInstall() {
    document.getElementById('install-menu-item').hidden = true;
  }

  function setUpdateIndicator(isAvailable) {
    document.getElementById('update-dot').hidden = !isAvailable;
  }

  function mount(sessionData) {
    const root = document.getElementById('app-header-root');
    if (!root) return;
    render(root);

    const mode = getMode();
    applyBranding(mode);

    document.getElementById('org-switch-micasa').addEventListener('click', () => switchMode('micasa'));
    document.getElementById('org-switch-access').addEventListener('click', () => switchMode('access'));
    document.getElementById('org-menu-micasa').addEventListener('click', () => switchMode('micasa'));
    document.getElementById('org-menu-access').addEventListener('click', () => switchMode('access'));

    wireAccountMenu(sessionData);
    loadQboBadge(sessionData.isAdmin);

    window.addEventListener('mc-theme-change', () => applyBranding(getMode()));
    window.addEventListener('mc-update-state', e => setUpdateIndicator(e.detail && e.detail.state === 'available'));
  }

  window.MCHeader = { mount, getMode, switchMode, setInstallAvailable, hideInstall };
})();
