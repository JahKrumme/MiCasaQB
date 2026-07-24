document.getElementById('year').textContent = new Date().getFullYear();

// If already signed in, skip the login form entirely.
(async () => {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (data.authenticated) window.location.href = data.forcePasswordChange ? '/change-password.html' : '/index.html';
  } catch {
    // Ignore — show the login form.
  }
})();

const form = document.getElementById('login-form');
const errorBox = document.getElementById('error-box');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorBox.hidden = true;
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorBox.textContent = data.error || 'Sign in failed.';
      errorBox.hidden = false;
      submitBtn.disabled = false;
      return;
    }

    window.location.href = data.forcePasswordChange ? '/change-password.html' : '/index.html';
  } catch {
    errorBox.textContent = 'Could not reach the server. Check your connection and try again.';
    errorBox.hidden = false;
    submitBtn.disabled = false;
  }
});
