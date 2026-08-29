// work-detail.js — 作品详情页：打赏弹窗 + 删除作品交互
// 文案与路由参数由模板在 .item-page 的 data-* 属性注入（零内联 JS）。
(function () {
  var root = document.querySelector('.item-page');
  var i18n = root ? {
    tipInvalid: root.dataset.i18nTipInvalid || '',
    tipFailed: root.dataset.i18nTipFailed || '',
    tipSuccess: root.dataset.i18nTipSuccess || '',
    delConfirm: root.dataset.i18nDelConfirm || '',
    delFailed: root.dataset.i18nDelFailed || '',
    favFailed: root.dataset.i18nFavFailed || '',
    idolFailed: root.dataset.i18nIdolFailed || '',
    loginRequired: root.dataset.i18nLoginRequired || '',
    favOn: root.dataset.i18nFavOn || 'Favorited',
    favOff: root.dataset.i18nFavOff || 'Favorite',
    idolOn: root.dataset.i18nIdolOn || 'Following',
    idolOff: root.dataset.i18nIdolOff || 'Follow'
  } : { tipInvalid: '', tipFailed: '', tipSuccess: '', delConfirm: '', delFailed: '', favFailed: '', idolFailed: '', loginRequired: '', favOn: 'Favorited', favOff: 'Favorite', idolOn: 'Following', idolOff: 'Follow' };
  var workId = root ? root.dataset.workId : '';
  var userUrl = root ? root.dataset.userUrl : '';
  var authorSlug = root ? root.dataset.authorSlug : '';
  var lang = root ? (root.dataset.lang || document.querySelector('html').lang || 'zh') : 'zh';

  function showMsg(text, ok) {
    var box = document.getElementById('item-msg');
    if (!box) return;
    box.textContent = text;
    box.className = 'item-msg ' + (ok ? 'item-msg--ok' : 'item-msg--err');
  }

  function requireLogin() {
    if (!ggbCheckLogin(ggbBoardWrapper())) {
      showMsg(i18n.loginRequired, false);
      return false;
    }
    return true;
  }

  function toggleFavorite(btn) {
    if (!requireLogin()) return;
    var icon = btn.querySelector('.fav-icon');
    var label = btn.querySelector('.fav-label');
    var countEl = btn.querySelector('.fav-count');
    var count = parseInt(countEl.textContent || '0', 10) || 0;
    var nowFav = btn.dataset.fav !== '1';
    fetch('/' + lang + '/work/' + workId + '/favorite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include'
    }).then(function (r) {
      if (r.ok) return r.json();
      throw new Error(i18n.favFailed);
    }).then(function (d) {
      btn.dataset.fav = d.is_favorited ? '1' : '0';
      icon.textContent = d.is_favorited ? '★' : '☆';
      if (label) label.textContent = d.is_favorited ? i18n.favOn : i18n.favOff;
      countEl.textContent = d.favorite_count;
    }).catch(function (e) {
      showMsg(e.message || i18n.favFailed, false);
    });
  }

  function toggleIdol(btn) {
    if (!requireLogin()) return;
    var label = btn.querySelector('.idol-label');
    fetch('/' + lang + '/user/' + authorSlug + '/idol', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include'
    }).then(function (r) {
      if (r.ok) return r.json();
      throw new Error(i18n.idolFailed);
    }).then(function (d) {
      btn.dataset.idol = d.is_idol ? '1' : '0';
      if (label) label.textContent = d.is_idol ? i18n.idolOn : i18n.idolOff;
    }).catch(function (e) {
      showMsg(e.message || i18n.idolFailed, false);
    });
  }

  // 暴露给模板内联 onclick 属性
  window.toggleFavorite = toggleFavorite;
  window.toggleIdol = toggleIdol;

  function openTip() {
    var modal = document.getElementById('tip-modal');
    if (modal) modal.style.display = 'flex';
    var msg = document.getElementById('tip-msg');
    if (msg) msg.textContent = '';
    fetch('/api/credit').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var bal = document.getElementById('tip-balance');
      if (bal) bal.textContent = d ? (d.credits || 0) : '--';
    }).catch(function () {});
  }

  function closeTip() {
    var modal = document.getElementById('tip-modal');
    if (modal) modal.style.display = 'none';
  }

  function selectTip(n) {
    var el = document.getElementById('tip-custom');
    if (el) el.value = n;
  }

  function submitTip() {
    var el = document.getElementById('tip-custom');
    var amount = parseInt((el ? el.value : '') || '0', 10);
    if (!amount || amount < 1) {
      document.getElementById('tip-msg').textContent = i18n.tipInvalid;
      return;
    }
    var btn = document.getElementById('tip-confirm-btn');
    btn.disabled = true;
    fetch('/api/work/' + workId + '/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ amount: amount })
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().then(function (e) { throw new Error(e.detail || e.message || i18n.tipFailed); });
    }).then(function () {
      closeTip();
      showMsg(i18n.tipSuccess, true);
    }).catch(function (e) {
      document.getElementById('tip-msg').textContent = e.message || i18n.tipFailed;
    }).finally(function () { btn.disabled = false; });
  }

  function deleteWork() {
    if (!confirm(i18n.delConfirm)) return;
    fetch('/api/work/' + workId, { method: 'DELETE', credentials: 'include' })
      .then(function (r) {
        if (r.ok) { window.location.href = userUrl; }
        else { showMsg(i18n.delFailed, false); }
      })
      .catch(function () { showMsg(i18n.delFailed, false); });
  }

  // 暴露给模板内联 onclick 属性
  window.showMsg = showMsg;
  window.openTip = openTip;
  window.closeTip = closeTip;
  window.selectTip = selectTip;
  window.submitTip = submitTip;
  window.deleteWork = deleteWork;
})();
