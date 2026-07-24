const ROLE_LABELS = { admin: 'Admin', staff: 'Staff', read_only: 'Read Only' };

const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';

const subtitleEl = document.getElementById('invite-subtitle');
const errorBox = document.getElementById('error-box');
const form = document.getElementById('accept-form');
const submitBtn = document.getElementById('submit-btn');

function showError(message) {
  subtitleEl.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
  form.hidden = true;
}

(async () => {
  if (!token) {
    showError('This invitation link is missing its token.');
    return;
  }

  try {
    const res = await fetch(`/api/invitations/${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'This invitation link is invalid.');
      return;
    }
    subtitleEl.textContent = `${data.email} — ${ROLE_LABELS[data.role] || data.role}`;
    form.hidden = false;
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
  }
})();

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorBox.hidden = true;
  submitBtn.disabled = true;

  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  try {
    const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, confirmPassword })
    });
    const data = await res.json();

    if (!res.ok) {
      errorBox.textContent = data.error || 'Could not create your account.';
      errorBox.hidden = false;
      submitBtn.disabled = false;
      return;
    }

    window.location.href = '/index.html';
  } catch {
    errorBox.textContent = 'Could not reach the server. Check your connection and try again.';
    errorBox.hidden = false;
    submitBtn.disabled = false;
  }
});
