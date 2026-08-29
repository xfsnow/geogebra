(function () {
  'use strict';
  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function ggbBoardWrapper() { return undefined; }

  var root = document.querySelector('.item-page');
  if (!root) return;
  var i18n = {
    favFailed: root.dataset.i18nFavFailed || '',
    loginRequired: root.dataset.i18nLoginRequired || '',
    favOn: root.dataset.i18nFavOn || 'Favorited',
    favOff: root.dataset.i18nFavOff || 'Favorite'
  };
  var caseSlug = root.dataset.caseSlug || '';
  var lang = root.dataset.lang || (document.querySelector('html') && document.querySelector('html').lang) || 'zh';

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

  window.toggleCaseFavorite = function (btn) {
    if (!requireLogin()) return;
    var icon = btn.querySelector('.fav-icon');
    var label = btn.querySelector('.fav-label');
    var countEl = btn.querySelector('.fav-count');
    fetch('/' + lang + '/case/' + caseSlug + '/favorite', {
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
  };
})();
