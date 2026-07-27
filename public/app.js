const SYSTEM_PROMPT = `You are an expert QuickBooks Online assistant for Mi Casa Care Homes LLC, a licensed residential care home in Kansas. Your role is to help staff record transactions correctly in QuickBooks step by step.

## About Mi Casa Care Homes LLC
Mi Casa operates licensed adult care homes. Residents pay for room, board, and personal care services. The company uses QuickBooks Online for all bookkeeping.

## Billing Cycle
- Invoices are created on the 20th of each month for the following month's services
- Payment is due on the 1st of the month
- Payments are accepted through the 5th without penalty
- After the 5th, the account enters a grace period
- Accounts not paid before the 1st of the following month are considered overdue
- Overdue reminders go out between the 6th and 15th of the month
- KanCare claims must be submitted by the end of each month

## Payment Types
- **KanCare** (Kansas Medicaid waiver): State-issued payments via the KMAP portal. Usually received mid-month. Record as a payment against the resident's invoice.
- **Private Pay**: Direct payment from resident or family by check, money order, or bank transfer.
- **LTC Insurance** (Long-Term Care Insurance): Insurance company pays directly. May require explanation of benefits (EOB) documentation.
- **Down Payments / Deposits**: Recorded as a liability (security deposit) until applied or refunded. Do not apply to income until earned.

## Chart of Accounts (Key Accounts)
**Income:**
- 4000 · Room & Board Income
- 4100 · Personal Care Services Income
- 4200 · KanCare Revenue

**Expenses:**
- 5000 · Payroll & Wages
- 5100 · Payroll Taxes
- 5200 · Food & Groceries
- 5300 · Household Supplies
- 5400 · Utilities
- 5500 · Repairs & Maintenance
- 5600 · Insurance
- 5700 · Professional Fees (accounting, legal)
- 5800 · Vehicle & Transportation
- 5900 · Medications & Medical Supplies

**Other:**
- 2000 · Accounts Payable
- 1200 · Accounts Receivable
- 2100 · Security Deposits (liability)
- 1010 · Checking Account
- 1020 · Savings Account

## Common Vendors
- Kansas Gas Service — utilities
- Evergy — electricity
- City Water Department — water/sewer
- Sam's Club / Walmart — food & supplies
- Walgreens / CVS — medications
- Payroll provider (e.g., Gusto or ADP) — payroll

## Important QuickBooks Rules
1. **Never delete a transaction** — void it instead to preserve the audit trail.
2. **Always match payments to invoices** — do not post payments directly to income accounts.
3. **KanCare payments** should be received against the customer's open invoice, not as a bank deposit to income.
4. **Deposits / security deposits** go to the liability account (2100), not income.
5. **Refunds** to residents: issue a credit memo first, then apply it or refund from checking.
6. **Expense receipts**: always record under the correct expense category. When in doubt, use the closest matching account.
7. **Reconcile** the checking account monthly after receiving the bank statement.
8. **Do not create duplicate customers** — search first before adding a new resident.

## Your Response Style
- Give numbered, step-by-step QuickBooks instructions
- Be specific: name the exact menu path, field, and value to enter
- Keep responses concise and practical
- If a transaction is unusual, note what to watch out for
- Always remind staff to save/finalize the transaction at the end`;

const ACCESS_SYSTEM_PROMPT = `You are a QuickBooks assistant for Access Mental Health, a psychiatric practice in Wichita, Kansas owned by Monica. You help staff record transactions correctly in QuickBooks Online.

PRACTICE INFO:
- Address: 902 W 29th St N Suite 102, Wichita, KS
- Services: psychiatric medication management, offered in person and via telehealth
- Patient demographic: adults 18 and older
- Insurance: accepts most major insurance providers

CLINICAL SERVICES OFFERED (for billing categorization only — never discuss clinical details):
- Psychiatric evaluation
- Diagnosis
- Medication management
- Treatment planning
- Mental status exams
- Screening tools
- Lab monitoring

IMPORTANT RULES:
- You only help with QuickBooks billing and bookkeeping questions
- NEVER discuss, store, or reference any patient clinical information, diagnoses, treatment details, or medical history — this is a strict HIPAA boundary
- If asked about anything clinical, redirect: 'I can only help with QuickBooks and billing questions. For clinical matters please use the appropriate clinical system.'
- Help categorize transactions by service type (psychiatric evaluation, medication management, telehealth visit, etc.) without ever recording specific diagnoses or clinical notes
- Keep answers concise and step-by-step
- You are not a licensed accountant — for complex tax or compliance questions recommend consulting their accountant`;

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const bannerEl = document.getElementById('banner');

let history = [];
let currentMode = sessionStorage.getItem('qb-mode') || 'micasa';

// --- Auth guard ---

async function requireSession() {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    if (data.forcePasswordChange) {
      window.location.href = '/change-password.html';
      return;
    }
    // Only admins manage the org-wide QuickBooks connection and staff access.
    if (data.isAdmin) {
      document.getElementById('reconnect-btn').hidden = false;
      document.getElementById('admin-link').hidden = false;
    }
  } catch {
    window.location.href = '/login.html';
  }
}
requireSession();

document.getElementById('signout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// --- QuickBooks connect result banner ---

function showBanner(text, type) {
  bannerEl.textContent = text;
  bannerEl.className = type;
  bannerEl.hidden = false;
  setTimeout(() => { bannerEl.hidden = true; }, 6000);
}

(function checkQboRedirectResult() {
  const params = new URLSearchParams(window.location.search);
  const qbo = params.get('qbo');
  if (qbo === 'connected') {
    showBanner('QuickBooks connected successfully.', 'success');
  } else if (qbo === 'error') {
    showBanner('Could not connect QuickBooks. Please try again or contact your administrator.', 'error');
  }
  if (qbo) {
    params.delete('qbo');
    params.delete('reason');
    const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', clean);
  }
})();

// --- PWA install prompt ---

let deferredInstallPrompt = null;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// --- Mode toggle ---

function applyMode(mode) {
  currentMode = mode;
  sessionStorage.setItem('qb-mode', mode);
  const app = document.getElementById('app');
  const toggle = document.getElementById('mode-toggle');
  const h1 = document.querySelector('header h1');
  const sub = document.querySelector('header p');
  const orgIndicator = document.getElementById('org-indicator');
  const brandLogo = document.getElementById('brand-logo');
  const orgLogo = document.getElementById('org-logo');
  const brandLink = document.getElementById('header-brand-link');
  if (mode === 'access') {
    app.classList.add('access-mode');
    document.body.classList.add('access-mode');
    h1.textContent = 'Access QuickBooks Assistant';
    sub.textContent = 'Powered by Access Mental Health';
    toggle.textContent = 'Mi Casa';
    brandLogo.src = '/assets/brand/access-mental-health-logo.png';
    brandLogo.alt = 'Access Mental Health';
    brandLink.setAttribute('aria-label', 'Access QuickBooks Assistant — go to dashboard');
    orgLogo.src = '/assets/brand/mi-casa-icon-black.png';
    orgLogo.alt = 'Mi Casa';
    orgIndicator.hidden = false;
  } else {
    app.classList.remove('access-mode');
    document.body.classList.remove('access-mode');
    h1.textContent = 'Mi Casa QuickBooks Assistant';
    sub.textContent = 'Powered by Mi Casa Care Homes';
    toggle.textContent = 'Access Mental Health';
    brandLogo.src = '/assets/brand/mi-casa-icon-black.png';
    brandLogo.alt = '';
    brandLink.setAttribute('aria-label', 'Mi Casa QuickBooks Assistant — go to dashboard');
    orgIndicator.hidden = true;
  }
  history = [];
  messagesEl.innerHTML = '';
  const welcome = mode === 'access'
    ? "Hi! I'm your Access Mental Health QuickBooks Assistant. Ask me any QuickBooks billing or bookkeeping question and I'll walk you through it step by step."
    : "Hi! I am your Mi Casa QuickBooks Assistant. Ask me how to record any transaction and I will walk you through it step by step.";
  addBubble('assistant', welcome);
  renderSuggestedPrompts(mode);
}

const SUGGESTED_PROMPTS = {
  micasa: [
    "What's our monthly billing cycle?",
    'How do I record a security deposit?',
    'How do I handle a KanCare payment?'
  ],
  access: [
    'How do I categorize a telehealth visit?',
    "What's the billing cycle for insurance claims?",
    'How do I record a copay?'
  ]
};

function renderSuggestedPrompts(mode) {
  clearSuggestedPrompts();
  const wrap = document.createElement('div');
  wrap.className = 'suggested-prompts';
  wrap.id = 'suggested-prompts';
  const label = document.createElement('p');
  label.className = 'suggested-prompts-label';
  label.textContent = 'Try asking:';
  wrap.appendChild(label);
  for (const prompt of SUGGESTED_PROMPTS[mode] || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggested-prompt-btn';
    btn.textContent = prompt;
    btn.addEventListener('click', () => triggerAction(prompt));
    wrap.appendChild(btn);
  }
  messagesEl.appendChild(wrap);
}

function clearSuggestedPrompts() {
  document.getElementById('suggested-prompts')?.remove();
}

document.getElementById('mode-toggle').addEventListener('click', () => {
  applyMode(currentMode === 'micasa' ? 'access' : 'micasa');
});

const fmt = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });

function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    .replace(/^# (.+)$/gm, '<strong>$1</strong>')
    .replace(/^\d+\.\s+(.+)$/gm, (_, item) => `<li>${item}</li>`)
    .replace(/^[-*]\s+(.+)$/gm, (_, item) => `<li>${item}</li>`)
    .replace(/(<li>.*<\/li>)/gs, match => `<ul>${match}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

function addBubble(role, text, opts = {}) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.innerHTML = `<p>${renderMarkdown(text)}</p>`;
  if (role === 'error' && opts.onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'bubble-retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      opts.onRetry();
    });
    div.appendChild(retryBtn);
  }
  messagesEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'typing';
  div.id = 'typing-indicator';
  div.setAttribute('role', 'status');
  div.innerHTML = '<span class="visually-hidden">Mi Casa Assistant is typing…</span><span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span>';
  messagesEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function removeTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

// --- Invoice preview card ---

async function showInvoicePreview() {
  const card = document.createElement('div');
  card.className = 'preview-card';
  card.innerHTML = '<p class="preview-status">Fetching invoice preview from QuickBooks…</p>';
  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });

  try {
    const res = await fetch('/api/qbo/preview-invoices', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      card.innerHTML = `<p class="preview-status text-danger">${data.error || 'Could not load preview.'}</p>`;
      return;
    }

    const { preview, invoiceDate, dueDate, total } = data;
    const allInvoiced = preview.every(r => r.alreadyInvoiced || !r.customerId);

    const rows = preview.map(r => {
      let statusClass, statusText;
      if (r.alreadyInvoiced) { statusClass = 'status-already'; statusText = 'Already invoiced'; }
      else if (!r.customerId) { statusClass = 'status-missing'; statusText = 'Not found'; }
      else { statusClass = 'status-found'; statusText = 'Ready'; }
      return `
        <tr class="${r.alreadyInvoiced ? 'row-dimmed' : ''}">
          <td>${r.name}</td>
          <td class="amount">${fmt(r.amount)}</td>
          <td>${r.dueDate}</td>
          <td class="${statusClass}">${statusText}</td>
        </tr>`;
    }).join('');

    const pendingTotal = preview.filter(r => r.customerId && !r.alreadyInvoiced).reduce((sum, r) => sum + r.amount, 0);

    const actionsHTML = allInvoiced
      ? `<div class="preview-all-done">All residents have already been invoiced this month.</div>`
      : `<button class="btn-confirm">Confirm — Create Invoices</button><button class="btn-cancel">Cancel</button>`;

    card.innerHTML = `
      <div class="preview-title">Monthly Invoice Preview</div>
      <div class="preview-meta">Invoice date: <strong>${invoiceDate}</strong> &nbsp;·&nbsp; Due date: <strong>${dueDate}</strong></div>
      <table class="preview-table">
        <thead><tr><th>Resident</th><th class="amount">Amount</th><th>Due Date</th><th>QB Status</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td><strong>${allInvoiced ? 'Total' : 'Pending total'}</strong></td>
          <td class="amount"><strong>${fmt(allInvoiced ? total : pendingTotal)}</strong></td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
      <div class="preview-actions">${actionsHTML}</div>`;

    card.scrollIntoView({ behavior: 'smooth', block: 'end' });

    if (!allInvoiced) {
      card.querySelector('.btn-confirm').addEventListener('click', () => confirmCreateInvoices(preview, card));
      card.querySelector('.btn-cancel').addEventListener('click', () => cancelInvoices(card));
    }
  } catch (e) {
    card.innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

async function confirmCreateInvoices(preview, card) {
  const actionsEl = card.querySelector('.preview-actions');
  actionsEl.innerHTML = '<p class="preview-status">Creating invoices in QuickBooks…</p>';

  try {
    const res = await fetch('/api/qbo/create-invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview })
    });
    const data = await res.json();

    if (!res.ok) {
      actionsEl.innerHTML = `<p class="preview-status text-danger">${data.error || 'Failed to create invoices.'}</p>`;
      return;
    }

    const skipped = data.results.filter(r => r.status === 'skipped' || r.status === 'error');
    let msg = `✓ ${data.created} invoice${data.created !== 1 ? 's' : ''} created — ${fmt(data.total)} total.`;
    if (skipped.length) msg += ` ${skipped.length} skipped (customer not found in QB).`;

    actionsEl.innerHTML = `<div class="preview-success">${msg}</div>`;
    history.push({ role: 'assistant', content: msg });
  } catch (e) {
    actionsEl.innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

function cancelInvoices(card) {
  card.querySelector('.preview-actions').innerHTML = '<p class="preview-cancelled">Invoice creation cancelled.</p>';
  history.push({ role: 'assistant', content: 'Invoice creation cancelled.' });
}

// --- Payment card ---

async function showPaymentCard(paymentData) {
  const card = document.createElement('div');
  card.className = 'preview-card';
  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  renderPaymentForm(card, paymentData?.customerName || '', paymentData?.amount || '');
}

function renderPaymentForm(card, prefillName, prefillAmount) {
  card.innerHTML = `
    <div class="preview-title">Record a Payment</div>
    <div class="payment-form">
      <label>Customer Name</label>
      <input type="text" class="payment-name-input" value="${prefillName}" placeholder="e.g. Beverly Herrell">
      <label>Payment Amount ($)</label>
      <input type="number" class="payment-amount-input" value="${prefillAmount || ''}" placeholder="e.g. 5885">
    </div>
    <div class="preview-actions">
      <button class="btn-confirm">Find Invoice</button>
      <button class="btn-cancel">Cancel</button>
    </div>`;

  card.querySelector('.btn-confirm').addEventListener('click', async () => {
    const name = card.querySelector('.payment-name-input').value.trim();
    const amount = parseFloat(card.querySelector('.payment-amount-input').value) || null;
    if (!name) return;
    await lookupPaymentInvoice(card, name, amount);
  });

  card.querySelector('.btn-cancel').addEventListener('click', () => cancelPayment(card));
}

async function lookupPaymentInvoice(card, customerName, amount) {
  card.innerHTML = `<p class="preview-status">Looking up open invoice for ${customerName}…</p>`;

  try {
    const res = await fetch('/api/qbo/preview-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName, amount })
    });
    const data = await res.json();

    if (!res.ok || !data.found) {
      const msg = data.message || `No open invoice found for ${customerName}.`;
      card.innerHTML = `<p class="preview-status text-danger">${msg}</p>`;
      history.push({ role: 'assistant', content: msg });
      return;
    }

    renderPaymentPreview(card, data);
  } catch (e) {
    card.innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

function renderPaymentPreview(card, data) {
  card.innerHTML = `
    <div class="preview-title">Payment Preview</div>
    <div class="preview-meta">Review before recording in QuickBooks</div>
    <table class="preview-table"><tbody>
      <tr><td>Customer</td><td><strong>${data.customerName}</strong></td></tr>
      <tr><td>Invoice #</td><td>#${data.invoiceNumber}</td></tr>
      <tr><td>Invoice Balance</td><td>${fmt(data.invoiceBalance)}</td></tr>
      <tr><td>Payment Amount</td><td><strong class="text-success">${fmt(data.paymentAmount)}</strong></td></tr>
      <tr><td>Payment Date</td><td>${data.paymentDate}</td></tr>
    </tbody></table>
    <div class="preview-actions">
      <button class="btn-confirm">Confirm — Record Payment</button>
      <button class="btn-cancel">Cancel</button>
    </div>`;

  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  card.querySelector('.btn-confirm').addEventListener('click', () => confirmRecordPayment(data, card));
  card.querySelector('.btn-cancel').addEventListener('click', () => cancelPayment(card));
}

async function confirmRecordPayment(data, card) {
  card.querySelector('.preview-actions').innerHTML = '<p class="preview-status">Recording payment in QuickBooks…</p>';

  try {
    const res = await fetch('/api/qbo/record-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: data.customerId,
        invoiceId: data.invoiceId,
        paymentAmount: data.paymentAmount,
        paymentDate: data.paymentDate
      })
    });
    const result = await res.json();

    if (!res.ok) {
      card.querySelector('.preview-actions').innerHTML = `<p class="preview-status text-danger">${result.error || 'Failed to record payment.'}</p>`;
      return;
    }

    const msg = `✓ Payment of ${fmt(data.paymentAmount)} recorded for ${data.customerName} (Invoice #${data.invoiceNumber})`;
    card.querySelector('.preview-actions').innerHTML = `<div class="preview-success">${msg}</div>`;
    history.push({ role: 'assistant', content: msg });
  } catch (e) {
    card.querySelector('.preview-actions').innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

function cancelPayment(card) {
  card.querySelector('.preview-actions').innerHTML = '<p class="preview-cancelled">Payment recording cancelled.</p>';
  history.push({ role: 'assistant', content: 'Payment recording cancelled.' });
}

// --- New resident card ---

const today = new Date().toISOString().split('T')[0];

function showNewResidentCard() {
  const card = document.createElement('div');
  card.className = 'preview-card';
  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  renderNewResidentForm(card);
}

function renderNewResidentForm(card) {
  card.innerHTML = `
    <div class="preview-title">Add New Resident</div>
    <div class="payment-form">
      <label>Full Name</label>
      <input type="text" class="res-name" placeholder="e.g. Jane Smith">
      <label>Payment Type</label>
      <select class="res-type">
        <option value="Private Pay">Private Pay</option>
        <option value="KanCare">KanCare</option>
        <option value="Long-term Care Insurance">Long-term Care Insurance</option>
      </select>
      <label>Monthly Rate ($)</label>
      <input type="number" class="res-rate" placeholder="e.g. 3500">
      <label>Move-in Date</label>
      <input type="date" class="res-date" value="${today}">
    </div>
    <div class="preview-actions">
      <button class="btn-confirm">Preview</button>
      <button class="btn-cancel">Cancel</button>
    </div>`;

  card.querySelector('.btn-confirm').addEventListener('click', async () => {
    const name = card.querySelector('.res-name').value.trim();
    const paymentType = card.querySelector('.res-type').value;
    const monthlyRate = parseFloat(card.querySelector('.res-rate').value);
    const moveInDate = card.querySelector('.res-date').value;
    if (!name || !monthlyRate) {
      card.querySelector('.res-name').style.borderColor = name ? '' : '#9b0000';
      card.querySelector('.res-rate').style.borderColor = monthlyRate ? '' : '#9b0000';
      return;
    }
    await previewResident(card, { name, paymentType, monthlyRate, moveInDate });
  });

  card.querySelector('.btn-cancel').addEventListener('click', () => cancelResident(card));
}

async function previewResident(card, residentData) {
  card.innerHTML = '<p class="preview-status">Checking QuickBooks for duplicates…</p>';

  try {
    const res = await fetch('/api/qbo/preview-resident', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(residentData)
    });
    const data = await res.json();

    if (!res.ok) {
      card.innerHTML = `<p class="preview-status text-danger">${data.error || 'Preview failed.'}</p>`;
      return;
    }

    renderResidentPreview(card, data);
  } catch (e) {
    card.innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

function renderResidentPreview(card, data) {
  const duplicateWarning = data.isDuplicate
    ? `<div class="preview-status text-warning mb-12">⚠ A customer named "${data.name}" already exists in QuickBooks. Creating another will result in a duplicate.</div>`
    : '';

  card.innerHTML = `
    <div class="preview-title">New Resident Preview</div>
    <div class="preview-meta">Review before adding to QuickBooks</div>
    ${duplicateWarning}
    <table class="preview-table"><tbody>
      <tr><td>Name</td><td><strong>${data.name}</strong></td></tr>
      <tr><td>Payment Type</td><td>${data.paymentType}</td></tr>
      <tr><td>Monthly Rate</td><td><strong class="text-success">${fmt(data.monthlyRate)}/month</strong></td></tr>
      <tr><td>Move-in Date</td><td>${data.moveInDate}</td></tr>
    </tbody></table>
    <div class="preview-actions">
      <button class="btn-confirm">Confirm — Add to QuickBooks</button>
      <button class="btn-cancel">Cancel</button>
    </div>`;

  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  card.querySelector('.btn-confirm').addEventListener('click', () => confirmCreateResident(data, card));
  card.querySelector('.btn-cancel').addEventListener('click', () => cancelResident(card));
}

async function confirmCreateResident(data, card) {
  card.querySelector('.preview-actions').innerHTML = '<p class="preview-status">Adding resident to QuickBooks…</p>';

  try {
    const res = await fetch('/api/qbo/create-resident', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();

    if (!res.ok) {
      card.querySelector('.preview-actions').innerHTML = `<p class="preview-status text-danger">${result.error || 'Failed to create resident.'}</p>`;
      return;
    }

    const msg = `✓ New resident ${result.name} has been added to QuickBooks at ${fmt(result.monthlyRate)}/month`;
    card.querySelector('.preview-actions').innerHTML = `<div class="preview-success">${msg}</div>`;
    history.push({ role: 'assistant', content: msg });
  } catch (e) {
    card.querySelector('.preview-actions').innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

function cancelResident(card) {
  card.querySelector('.preview-actions').innerHTML = '<p class="preview-cancelled">New resident creation cancelled.</p>';
  history.push({ role: 'assistant', content: 'New resident creation cancelled.' });
}

// --- Overdue summary card ---

async function showOverdueSummary() {
  const card = document.createElement('div');
  card.className = 'preview-card';
  card.innerHTML = '<p class="preview-status">Fetching overdue invoices from QuickBooks…</p>';
  messagesEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });

  try {
    const res = await fetch('/api/qbo/overdue-summary', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      card.innerHTML = `<p class="preview-status text-danger">${data.error || 'Could not load overdue invoices.'}</p>`;
      return;
    }

    if (!data.count) {
      card.innerHTML = `<div class="preview-title">Overdue Invoices</div><p class="preview-all-done mt-8">No overdue invoices. All residents are current!</p>`;
      return;
    }

    const rows = data.items.map(inv => {
      const urgencyClass = inv.daysOverdue > 30 ? 'text-danger bold' : inv.daysOverdue > 14 ? 'text-warning bold' : 'text-default';
      return `
        <tr>
          <td>${inv.customerName}</td>
          <td>#${inv.invoiceNumber}</td>
          <td class="${urgencyClass}">${inv.daysOverdue}d overdue</td>
          <td class="amount ${urgencyClass}">${fmt(inv.balance)}</td>
        </tr>`;
    }).join('');

    card.innerHTML = `
      <div class="preview-title">Overdue Invoices</div>
      <div class="preview-meta">${data.count} invoice${data.count !== 1 ? 's' : ''} past due</div>
      <table class="preview-table">
        <thead><tr><th>Resident</th><th>Invoice #</th><th>Days Overdue</th><th class="amount">Balance</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3"><strong>Total Outstanding</strong></td><td class="amount"><strong class="text-danger">${fmt(data.total)}</strong></td></tr></tfoot>
      </table>`;

    card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  } catch (e) {
    card.innerHTML = `<p class="preview-status text-danger">Error: ${e.message}</p>`;
  }
}

// --- Quick action buttons ---

function triggerAction(action) {
  inputEl.value = action;
  inputEl.dispatchEvent(new Event('input'));
  sendMessage();
}

document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => triggerAction(btn.dataset.action));
});

// --- Main send flow ---

function setSendingState(isSending) {
  sendBtn.disabled = isSending;
  inputEl.disabled = isSending;
  sendBtn.textContent = isSending ? 'Sending…' : 'Send';
  document.getElementById('input-row').setAttribute('aria-busy', String(isSending));
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearSuggestedPrompts();
  addBubble('user', text);
  await attemptSend(text, null);
}

// Sends (or resends, on retry) one user message. `priorErrorBubble` is the
// error bubble the retry button was clicked from, if any — removed once a
// new attempt starts so failed retries don't stack up.
async function attemptSend(text, priorErrorBubble) {
  if (priorErrorBubble) priorErrorBubble.remove();
  setSendingState(true);
  history.push({ role: 'user', content: text });

  showTyping();

  try {
    const activePrompt = currentMode === 'access' ? ACCESS_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, system: activePrompt, mode: currentMode })
    });

    const data = await res.json();
    removeTyping();

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error || 'Something went wrong. Please try again.';
      history.pop();
      let bubble;
      bubble = addBubble('error', errMsg, { onRetry: () => attemptSend(text, bubble) });
    } else if (data.intent && currentMode !== 'access') {
      if (data.intent === 'create-invoices') showInvoicePreview();
      else if (data.intent === 'record-payment') showPaymentCard(data.paymentData);
      else if (data.intent === 'add-resident') showNewResidentCard();
      else if (data.intent === 'overdue-summary') showOverdueSummary();
    } else {
      const reply = data?.text || '(No response)';
      history.push({ role: 'assistant', content: reply });
      addBubble('assistant', reply);
    }
  } catch (e) {
    removeTyping();
    history.pop();
    let bubble;
    bubble = addBubble('error', 'Could not reach the server. Check your connection and try again.', {
      onRetry: () => attemptSend(text, bubble)
    });
  }

  setSendingState(false);
  inputEl.focus();
}

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

applyMode(currentMode);
inputEl.focus();
