// layout.js — 全站共用交互：移动端菜单开合 + 语言切换
// （原 layout.htm 内联脚本外提；须在 DOM 渲染后加载，layout.htm 将其置于 body 末尾）
(function () {
  // ---------- 移动端菜单 ----------
  var toggle = document.getElementById('menuToggle');
  var nav = document.getElementById('mobileNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () { nav.classList.toggle('open'); });
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { nav.classList.remove('open'); });
    });
  }

  // ---------- 语言切换：写 lang cookie 并重定向/刷新 ----------
  var switches = ['langSwitchFooter']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  function setLang(lang) {
    document.cookie = 'lang=' + lang + '; path=/; max-age=31536000';
    // 带语言前缀的页面（如 /zh/work、/en/work/xxx）以 URL 段为准，
    // 仅写 cookie 并 reload 不会生效，需改写首段语言并重定向。
    var seg = window.location.pathname.split('/'); // ['', 'zh'|'en', ...]
    if (seg.length > 1 && (seg[1] === 'zh' || seg[1] === 'en')) {
      seg[1] = lang;
      var newPath = seg.join('/');
      window.location.href = newPath + (window.location.search || '');
    } else {
      // 无语言前缀的页面（/chat、/byok、/login…）以 cookie 为准，重载即可。
      window.location.reload();
    }
  }

  switches.forEach(function (sw) {
    var btn = sw.querySelector('.lang-btn');
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        switches.forEach(function (o) { if (o !== sw) o.classList.remove('open'); });
        sw.classList.toggle('open');
      });
    }
    sw.querySelectorAll('.lang-menu button').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.dataset.lang); });
    });
  });
  document.addEventListener('click', function () {
    switches.forEach(function (sw) { sw.classList.remove('open'); });
  });
})();
