// account.js — 登录/注册页交互（login/register 共用）
// 文案由模板在 #login-form / #register-form 的 data-i18n-* 属性注入（零内联 JS）。
(function () {
  function i18n(form) {
    return {
      loading: form.dataset.i18nLoading || '',
      btn: form.dataset.i18nBtn || '',
      mismatch: form.dataset.i18nMismatch || '',
      success: form.dataset.i18nSuccess || '',
      failed: form.dataset.i18nFailed || '',
      network: form.dataset.i18nNetwork || '',
      valRequired: form.dataset.i18nValRequired || '',
      valEmail: form.dataset.i18nValEmail || '',
      valUrl: form.dataset.i18nValUrl || ''
    };
  }

  function bindValidation(form, txt) {
    var fields = form.querySelectorAll('input, textarea');
    fields.forEach(function (el) {
      el.addEventListener('invalid', function () {
        if (el.validity.valueMissing) {
          el.setCustomValidity(txt.valRequired);
        } else if (el.validity.typeMismatch) {
          if (el.type === 'email') el.setCustomValidity(txt.valEmail);
          else if (el.type === 'url') el.setCustomValidity(txt.valUrl);
          else el.setCustomValidity(txt.valRequired);
        } else {
          el.setCustomValidity('');
        }
      });
      el.addEventListener('input', function () { el.setCustomValidity(''); });
      el.addEventListener('change', function () { el.setCustomValidity(''); });
    });
  }

  // ---------- 注册页：自动检测时区 ----------
  var tzField = document.getElementById('tzField');
  if (tzField) {
    try { tzField.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  }

  // ---------- 登录页 ----------
  var loginForm = document.getElementById('login-form');
  if (loginForm) {
    var li = i18n(loginForm);
    var lBtn = document.getElementById('login-btn');
    var lBtnText = document.getElementById('login-btn-text');
    var lError = document.getElementById('auth-error');

    bindValidation(loginForm, li);

    function getRedirectUrl() {
      var params = new URLSearchParams(window.location.search);
      var redirectUrl = params.get('redirect_url');
      if (redirectUrl) {
        try {
          var decoded = decodeURIComponent(redirectUrl);
          if (decoded.startsWith('/') && !decoded.includes('..')) return decoded;
        } catch (e) { /* ignore */ }
      }
      return '/account';
    }

    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      lBtn.disabled = true;
      lBtnText.textContent = li.loading;
      lError.style.display = 'none';
      lError.textContent = '';
      var username = document.getElementById('username').value;
      var password = document.getElementById('password').value;
      fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (res) {
        if (res.ok) {
          localStorage.setItem('access_token', res.data.access_token);
          localStorage.setItem('user', JSON.stringify(res.data.user));
          window.location.href = getRedirectUrl();
        } else {
          lError.textContent = (res.data && res.data.detail) || li.failed;
          lError.style.display = 'block';
        }
      }).catch(function () {
        lError.textContent = li.network;
        lError.style.display = 'block';
      }).finally(function () {
        lBtn.disabled = false;
        lBtnText.textContent = li.btn;
      });
    });
  }

  // ---------- 注册页 ----------
  var regForm = document.getElementById('register-form');
  if (regForm) {
    var ri = i18n(regForm);
    var rBtn = document.getElementById('register-btn');
    var rBtnText = document.getElementById('register-btn-text');
    var rError = document.getElementById('auth-error');
    var rSuccess = document.getElementById('auth-success');

    bindValidation(regForm, ri);

    function showError(msg) {
      rError.textContent = msg;
      rError.style.display = 'block';
      rSuccess.style.display = 'none';
    }
    function showSuccess(msg) {
      rSuccess.textContent = msg;
      rSuccess.style.display = 'block';
      rError.style.display = 'none';
    }

    regForm.addEventListener('submit', function (e) {
      e.preventDefault();
      rBtn.disabled = true;
      rBtnText.textContent = ri.loading;
      rError.style.display = 'none';
      rSuccess.style.display = 'none';

      var username = document.getElementById('username').value;
      var email = document.getElementById('email').value;
      var password = document.getElementById('password').value;
      var confirmPassword = document.getElementById('confirmPassword').value;

      var refCode = new URLSearchParams(window.location.search).get('ref');
      if (refCode) refCode = refCode.trim();

      if (password !== confirmPassword) {
        showError(ri.mismatch);
        rBtn.disabled = false;
        rBtnText.textContent = ri.btn;
        return;
      }

      var payload = { username: username, email: email, password: password };
      if (refCode) payload.referral_code = refCode;
      var tz = tzField ? tzField.value : '';
      if (tz) payload.timezone = tz;

      fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (res) {
        if (res.ok) {
          showSuccess(ri.success);
          setTimeout(function () { window.location.href = '/login'; }, 1500);
        } else {
          showError((res.data && res.data.detail) || ri.failed);
        }
      }).catch(function () {
        showError(ri.network);
      }).finally(function () {
        rBtn.disabled = false;
        rBtnText.textContent = ri.btn;
      });
    });
  }
})();
