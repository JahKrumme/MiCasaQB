(async () => {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/login.html'; return; }
    if (!data.forcePasswordChange) {
      document.getElementById('subtitle').textContent = 'Update the password on your account.';
    }
  } catch {
    window.location.href = '/login.html';
  }
})();

const form = document.getElementById('change-form');
const errorBox = document.getElementById('error-box');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorBox.hidden = true;
  submitBtn.disabled = true;

  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();

    if (!res.ok) {
      errorBox.textContent = data.error || 'Could not change your password.';
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
