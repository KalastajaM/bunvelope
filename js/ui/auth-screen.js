// js/ui/auth-screen.js — pre-app sign-in screen for cloud mode.
// Mounted when window.__BUNVELOPE_MODE.kind === 'cloud' and /api/me returns
// 401. In default OAuth mode the button redirects to /auth/google. When the
// server boots with BYPASS_GOOGLE=true, window.__BUNVELOPE_MODE.bypassGoogle
// is true and a password form posts to /auth/password instead.

import { t } from './i18n.js';

async function enterGuestMode() {
  const { openGuestBudgetPicker } = await import('./guest-budget-picker.js');
  openGuestBudgetPicker();
}

function isBypassMode() {
  return !!window.__BUNVELOPE_MODE?.bypassGoogle;
}

export function renderAuthScreen(container, { authFailed = false, encryptionError = false } = {}) {
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page';
  page.style.cssText = 'display:flex; align-items:center; justify-content:center; min-height: calc(100vh - 100px);';

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:420px; padding:40px 32px;';

  const emoji = document.createElement('div');
  emoji.style.cssText = 'font-size:48px; margin-bottom:16px; text-align:center;';
  emoji.textContent = '🔐';
  card.append(emoji);

  const h1 = document.createElement('h1');
  h1.style.cssText = 'font-size:22px; font-weight:700; margin-bottom:10px; text-align:center;';
  h1.textContent = isBypassMode() ? t('auth.bypassTitle') : 'Sign in to Bunvelope';
  card.append(h1);

  const lede = document.createElement('p');
  lede.style.cssText = 'color:var(--muted); margin-bottom:24px; line-height:1.5; text-align:center;';
  lede.textContent = isBypassMode()
    ? t('auth.bypassLede')
    : 'Your budgets are stored in the cloud and synced across devices.';
  card.append(lede);

  if (authFailed) {
    const err = document.createElement('p');
    err.style.cssText = 'color:var(--danger-text); margin-bottom:16px; text-align:center; font-size:13px;';
    err.textContent = t('auth.signInFailed');
    card.append(err);
  }

  if (encryptionError) {
    // The session was ended rather than continued without a key. Say why —
    // signing in again is the fix, and silence here reads as a random logout.
    const err = document.createElement('p');
    err.style.cssText = 'color:var(--danger-text); margin-bottom:16px; text-align:center; font-size:13px;';
    err.textContent = t('security.err.unlockUnavailable');
    card.append(err);
  }

  if (isBypassMode()) {
    card.append(buildPasswordForm(card));
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-accent';
    btn.style.cssText = 'width:100%;justify-content:center;padding:12px;';
    btn.textContent = t('auth.signInGoogle');
    btn.addEventListener('click', () => {
      window.location.assign('/auth/google');
    });
    card.append(btn);

    const footer = document.createElement('p');
    footer.style.cssText = 'margin-top:16px; font-size:12px; color:var(--muted); text-align:center;';
    footer.textContent = t('auth.googleScopeNote');
    card.append(footer);
  }

  const divider = document.createElement('div');
  divider.style.cssText = 'display:flex;align-items:center;gap:8px;margin:20px 0 12px;color:var(--muted);font-size:12px;';
  const line1 = document.createElement('div');
  line1.style.cssText = 'flex:1;height:1px;background:var(--border);';
  const line2 = line1.cloneNode();
  const or = document.createElement('span');
  or.textContent = t('auth.or');
  divider.append(line1, or, line2);
  card.append(divider);

  const guestBtn = document.createElement('button');
  guestBtn.type = 'button';
  guestBtn.className = 'btn btn-ghost';
  guestBtn.style.cssText = 'width:100%;justify-content:center;padding:10px;';
  guestBtn.textContent = t('loadBudget.guestButton');
  guestBtn.addEventListener('click', async () => {
    guestBtn.disabled = true;
    try { await enterGuestMode(); }
    catch (err) {
      console.error('guest session failed:', err);
      guestBtn.disabled = false;
    }
  });
  card.append(guestBtn);

  const guestHint = document.createElement('p');
  guestHint.style.cssText = 'margin-top:8px; font-size:12px; color:var(--muted); text-align:center;';
  guestHint.textContent = t('loadBudget.guestHint');
  card.append(guestHint);

  page.append(card);
  container.append(page);
}

function buildPasswordForm(card) {
  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'form-input';
  input.required = true;
  input.autocomplete = 'current-password';
  input.placeholder = t('auth.bypassPlaceholder');
  form.append(input);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent';
  submit.style.cssText = 'width:100%;justify-content:center;padding:12px;';
  submit.textContent = t('auth.bypassSubmit');
  form.append(submit);

  const errEl = document.createElement('p');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin:4px 0 0;text-align:center;display:none;';
  form.append(errEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    submit.disabled = true;
    try {
      const resp = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        if (data?.mustChangePassword && card) {
          renderChangePassword(card, { currentPassword: input.value });
          return;
        }
        window.location.assign('/');
        return;
      }
      if (resp.status === 429) {
        errEl.textContent = t('auth.bypassRateLimited');
      } else {
        errEl.textContent = t('auth.bypassFailed');
      }
      errEl.style.display = 'block';
      input.value = '';
      input.focus();
    } catch (err) {
      console.error('bypass login failed:', err);
      errEl.textContent = t('auth.bypassFailed');
      errEl.style.display = 'block';
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

// Force-rotate flow. Mounted on the same card as the login form when the
// server returned mustChangePassword — i.e. the user authenticated with the
// env-var bootstrap value and it's shorter than the policy floor. The
// current password is carried over from the login form so the user only
// has to type the new one.
function renderChangePassword(card, { currentPassword }) {
  card.innerHTML = '';

  const emoji = document.createElement('div');
  emoji.style.cssText = 'font-size:48px; margin-bottom:16px; text-align:center;';
  emoji.textContent = '🔐';
  card.append(emoji);

  const h1 = document.createElement('h1');
  h1.style.cssText = 'font-size:22px; font-weight:700; margin-bottom:10px; text-align:center;';
  h1.textContent = t('auth.changePasswordTitle');
  card.append(h1);

  const lede = document.createElement('p');
  lede.style.cssText = 'color:var(--muted); margin-bottom:24px; line-height:1.5; text-align:center;';
  lede.textContent = t('auth.changePasswordLede');
  card.append(lede);

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const newInput = document.createElement('input');
  newInput.type = 'password';
  newInput.className = 'form-input';
  newInput.required = true;
  newInput.autocomplete = 'new-password';
  newInput.minLength = 16;
  newInput.placeholder = t('auth.newPasswordPlaceholder');
  form.append(newInput);

  const confirmInput = document.createElement('input');
  confirmInput.type = 'password';
  confirmInput.className = 'form-input';
  confirmInput.required = true;
  confirmInput.autocomplete = 'new-password';
  confirmInput.minLength = 16;
  confirmInput.placeholder = t('auth.confirmPasswordPlaceholder');
  form.append(confirmInput);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent';
  submit.style.cssText = 'width:100%;justify-content:center;padding:12px;';
  submit.textContent = t('auth.changePasswordSubmit');
  form.append(submit);

  const errEl = document.createElement('p');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin:4px 0 0;text-align:center;display:none;';
  form.append(errEl);

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';

    if (newInput.value.length < 16) {
      showError(t('auth.changePasswordTooShort'));
      newInput.focus();
      return;
    }
    if (newInput.value !== confirmInput.value) {
      showError(t('auth.changePasswordMismatch'));
      confirmInput.focus();
      return;
    }

    submit.disabled = true;
    try {
      const resp = await fetch('/auth/password/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: currentPassword, new: newInput.value }),
      });
      if (resp.ok) {
        window.location.assign('/');
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 429) {
        showError(t('auth.bypassRateLimited'));
      } else if (data?.error === 'password_too_short') {
        showError(t('auth.changePasswordTooShort'));
      } else {
        showError(t('auth.changePasswordFailed'));
      }
    } catch (err) {
      console.error('bypass password change failed:', err);
      showError(t('auth.changePasswordFailed'));
    } finally {
      submit.disabled = false;
    }
  });

  card.append(form);
  newInput.focus();
}
