// feedback.js — 用户反馈表单提交（需登录）
(function () {
  var form = document.getElementById('feedback-form');
  if (!form) return;

  var msg = document.getElementById('feedback-msg');
  var btn = form.querySelector('.feedback-submit');
  var ta = form.querySelector('#fb-content');
  var counter = document.getElementById('fb-count');
  var i18n = {
    success: form.dataset.i18nSuccess || 'Thanks!',
    failed: form.dataset.i18nFailed || 'Failed',
    loginRequired: form.dataset.i18nLoginRequired || 'Please log in first.',
    tooShort: form.dataset.i18nShort || 'Please write a little more.'
  };

  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'feedback-msg ' + kind;
    msg.hidden = false;
  }

  if (ta && counter) {
    ta.addEventListener('input', function () {
      counter.textContent = String(ta.value.length);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.hidden = true;

    var payload = {
      type: form.querySelector('#fb-type').value,
      target_type: form.querySelector('#fb-target-type').value,
      target_id: form.querySelector('#fb-target-id').value.trim(),
      content: ta.value.trim()
    };
    if (payload.content.length < 5) {
      showMsg(i18n.tooShort, 'err');
      return;
    }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '…';

    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (res.status === 401) {
          showMsg(i18n.loginRequired, 'err');
          return null;
        }
        if (!res.ok) {
          showMsg(i18n.failed, 'err');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (data && data.feedback_id) {
          showMsg(i18n.success, 'ok');
          ta.value = '';
          form.querySelector('#fb-target-id').value = '';
          if (counter) counter.textContent = '0';
        }
      })
      .catch(function () {
        showMsg(i18n.failed, 'err');
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
  });
})();
