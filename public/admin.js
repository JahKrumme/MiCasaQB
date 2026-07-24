(async () => {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/login.html'; return; }
    if (data.forcePasswordChange) { window.location.href = '/change-password.html'; return; }
    if (!data.isAdmin) { window.location.href = '/index.html'; return; }
  } catch {
    window.location.href = '/login.html';
  }
})();

const ROLE_LABELS = { admin: 'Admin', staff: 'Staff', read_only: 'Read Only' };

function showToast(elId, msg, type) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; el.style.display = 'none'; }, 6000);
}

function showRevealToast(elId, label, value) {
  const el = document.getElementById(elId);
  el.className = 'success';
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'reveal-box';
  const labelEl = document.createElement('span');
  labelEl.className = 'reveal-label';
  labelEl.textContent = label + ' (shown once — copy it now)';
  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  box.appendChild(labelEl);
  box.appendChild(valueEl);
  el.appendChild(box);
  clearTimeout(el._t);
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString();
}

async function loadAll() {
  await Promise.all([loadUsersAndInvitations(), loadAuditLog()]);
}

// --- QuickBooks connection status ---

const ICON_CHECK = '<circle cx="12" cy="12" r="9"></circle><path d="M8 12l3 3 5-6"></path>';
const ICON_WARNING = '<path d="M12 3l9 16H3z"></path><path d="M12 9v4"></path><path d="M12 16h.01"></path>';
const ICON_LOADING = '<circle cx="12" cy="12" r="9" stroke-dasharray="42" stroke-dashoffset="14"></circle>';

function setQboStatus({ state, label, detail, icon, actions }) {
  const box = document.getElementById('qbo-status');
  const iconEl = document.getElementById('qbo-status-icon');
  const labelEl = document.getElementById('qbo-status-label');
  const detailEl = document.getElementById('qbo-status-detail');
  const actionsEl = document.getElementById('qbo-status-actions');

  box.className = 'qbo-status is-' + state;
  iconEl.innerHTML = icon;
  labelEl.textContent = label;
  detailEl.textContent = detail || '';
  actionsEl.innerHTML = '';
  for (const action of actions || []) {
    actionsEl.appendChild(action);
  }
}

function connectLink(text) {
  const a = document.createElement('a');
  a.className = 'btn-connect';
  a.href = '/api/qbo/connect';
  a.textContent = text;
  return a;
}

function disconnectButton() {
  const btn = document.createElement('button');
  btn.className = 'btn-disconnect';
  btn.textContent = 'Disconnect';
  btn.addEventListener('click', async () => {
    if (!confirm('Disconnect QuickBooks? Staff will not be able to create invoices or record payments until an admin reconnects.')) return;
    btn.disabled = true;
    try {
      await api('/api/qbo/disconnect', { method: 'POST' });
      loadQboStatus();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
    }
  });
  return btn;
}

async function loadQboStatus() {
  setQboStatus({ state: 'refreshing', label: 'Checking connection…', icon: ICON_LOADING });
  try {
    const res = await fetch('/api/qbo/status');
    const data = await res.json();

    if (!data.connected) {
      setQboStatus({
        state: 'reconnect',
        label: 'Not connected',
        detail: 'Connect QuickBooks so staff can create invoices and record payments.',
        icon: ICON_WARNING,
        actions: [connectLink('Connect QuickBooks')]
      });
      return;
    }

    const refreshExpired = data.refreshTokenExpiresAt && data.refreshTokenExpiresAt < Date.now();
    if (refreshExpired) {
      setQboStatus({
        state: 'reconnect',
        label: 'Reconnection required',
        detail: `QuickBooks access expired for realm ${data.realmId}.`,
        icon: ICON_WARNING,
        actions: [connectLink('Reconnect QuickBooks')]
      });
      return;
    }

    setQboStatus({
      state: 'connected',
      label: 'Connected',
      detail: `Realm ${data.realmId} · ${data.environment}`,
      icon: ICON_CHECK,
      actions: [connectLink('Reconnect'), disconnectButton()]
    });
  } catch {
    setQboStatus({
      state: 'error',
      label: 'Error checking connection',
      detail: 'Could not reach the server. Try refreshing the page.',
      icon: ICON_WARNING,
      actions: [connectLink('Connect QuickBooks')]
    });
  }
}

async function loadUsersAndInvitations() {
  const userTbody = document.getElementById('user-list');
  const inviteTbody = document.getElementById('invitation-list');
  try {
    const data = await api('/api/admin/users');
    renderUsers(data.users || []);
    renderInvitations(data.invitations || []);
  } catch {
    userTbody.innerHTML = '<tr><td class="empty text-danger">Failed to load staff accounts.</td></tr>';
    inviteTbody.innerHTML = '<tr><td class="empty text-danger">Failed to load invitations.</td></tr>';
  }
}

function renderUsers(users) {
  const tbody = document.getElementById('user-list');
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td class="empty">No staff accounts yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');

    const emailTd = document.createElement('td');
    emailTd.className = 'email-cell';
    emailTd.textContent = u.email;
    if (u.forcePasswordChange) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-force-pw';
      badge.textContent = 'Must change password';
      emailTd.appendChild(document.createTextNode(' '));
      emailTd.appendChild(badge);
    }
    tr.appendChild(emailTd);

    const roleTd = document.createElement('td');
    roleTd.className = 'role-cell';
    const select = document.createElement('select');
    select.dataset.id = u.id;
    for (const [value, label] of Object.entries(ROLE_LABELS)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === u.role) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => changeRole(u.id, select.value));
    roleTd.appendChild(select);
    tr.appendChild(roleTd);

    const statusTd = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge ' + (u.disabled ? 'badge-disabled' : 'badge-active');
    statusBadge.textContent = u.disabled ? 'Disabled' : 'Active';
    statusTd.appendChild(statusBadge);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-secondary';
    toggleBtn.textContent = u.disabled ? 'Reactivate' : 'Disable';
    toggleBtn.addEventListener('click', () => toggleDisabled(u.id, !u.disabled));
    actionsTd.appendChild(toggleBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn-secondary';
    resetBtn.textContent = 'Reset Password';
    resetBtn.addEventListener('click', () => resetPassword(u.id));
    actionsTd.appendChild(resetBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeUser(u.id));
    actionsTd.appendChild(removeBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

function renderInvitations(invitations) {
  const tbody = document.getElementById('invitation-list');
  if (invitations.length === 0) {
    tbody.innerHTML = '<tr><td class="empty">No pending invitations.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const inv of invitations) {
    const tr = document.createElement('tr');

    const emailTd = document.createElement('td');
    emailTd.className = 'email-cell';
    emailTd.textContent = `${inv.email} (${ROLE_LABELS[inv.role] || inv.role})`;
    tr.appendChild(emailTd);

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (inv.status === 'expired' ? 'badge-expired' : 'badge-pending');
    badge.textContent = inv.status === 'expired' ? 'Expired' : 'Pending';
    statusTd.appendChild(badge);
    const expiry = document.createElement('span');
    expiry.className = 'audit-time';
    expiry.textContent = 'Expires ' + formatDate(inv.expiresAt);
    statusTd.appendChild(expiry);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-cell';

    const resendBtn = document.createElement('button');
    resendBtn.className = 'btn-secondary';
    resendBtn.textContent = 'Resend';
    resendBtn.addEventListener('click', () => resendInvitation(inv.id));
    actionsTd.appendChild(resendBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-remove';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cancelInvitation(inv.id));
    actionsTd.appendChild(cancelBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }
}

async function loadAuditLog() {
  const list = document.getElementById('audit-list');
  try {
    const data = await api('/api/admin/audit-log');
    const entries = data.entries || [];
    if (entries.length === 0) {
      list.innerHTML = '<li class="empty">No activity yet.</li>';
      return;
    }
    list.innerHTML = '';
    for (const e of entries) {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'audit-time';
      time.textContent = formatDate(e.createdAt);
      const text = document.createElement('span');
      const actor = e.actorEmail || 'system';
      const target = e.target ? ` — ${e.target}` : '';
      text.textContent = `${actor}: ${e.action.replace(/_/g, ' ')}${target}`;
      li.appendChild(time);
      li.appendChild(text);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="empty text-danger">Failed to load activity.</li>';
  }
}

document.getElementById('invite-btn').addEventListener('click', async () => {
  const emailInput = document.getElementById('invite-email');
  const roleSelect = document.getElementById('invite-role');
  const email = emailInput.value.trim().toLowerCase();
  if (!email) return;

  const btn = document.getElementById('invite-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/admin/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: roleSelect.value })
    });
    if (data.emailSent) {
      showToast('invite-toast', `Invitation sent to ${email}.`, 'success');
    } else {
      showRevealToast('invite-toast', 'Email failed to send — share this link manually', data.inviteUrl);
    }
    emailInput.value = '';
    loadAll();
  } catch (e) {
    showToast('invite-toast', e.message, 'error');
  }
  btn.disabled = false;
});

async function resendInvitation(id) {
  try {
    const data = await api(`/api/admin/invitations/${id}/resend`, { method: 'POST' });
    if (data.emailSent) showToast('invite-toast', 'Invitation resent.', 'success');
    else showRevealToast('invite-toast', 'Email failed to send — share this link manually', data.inviteUrl);
    loadAll();
  } catch (e) {
    showToast('invite-toast', e.message, 'error');
  }
}

async function cancelInvitation(id) {
  try {
    await api(`/api/admin/invitations/${id}`, { method: 'DELETE' });
    showToast('invite-toast', 'Invitation cancelled.', 'success');
    loadAll();
  } catch (e) {
    showToast('invite-toast', e.message, 'error');
  }
}

async function changeRole(id, role) {
  try {
    await api(`/api/admin/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    showToast('toast', 'Role updated.', 'success');
    loadAll();
  } catch (e) {
    showToast('toast', e.message, 'error');
    loadUsersAndInvitations();
  }
}

async function toggleDisabled(id, disable) {
  try {
    await api(`/api/admin/users/${id}/${disable ? 'disable' : 'reactivate'}`, { method: 'PATCH' });
    showToast('toast', disable ? 'Account disabled.' : 'Account reactivated.', 'success');
    loadAll();
  } catch (e) {
    showToast('toast', e.message, 'error');
  }
}

async function resetPassword(id) {
  try {
    const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
    showRevealToast('toast', 'Temporary password', data.temporaryPassword);
    loadAll();
  } catch (e) {
    showToast('toast', e.message, 'error');
  }
}

async function removeUser(id) {
  try {
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    showToast('toast', 'Account removed.', 'success');
    loadAll();
  } catch (e) {
    showToast('toast', e.message, 'error');
  }
}

document.getElementById('test-email-btn').addEventListener('click', async () => {
  const btn = document.getElementById('test-email-btn');
  btn.disabled = true;
  try {
    await api('/api/admin/send-test-email', { method: 'POST' });
    showToast('test-email-toast', 'Test email sent — check your inbox.', 'success');
  } catch (e) {
    showToast('test-email-toast', e.message, 'error');
  }
  btn.disabled = false;
});

loadAll();
loadQboStatus();
