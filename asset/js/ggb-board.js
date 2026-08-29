/*
 * ggb-board.js — 统一 GeoGebra 画板交互模块
 * 供社区范例详情页(/case)、作品详情页(/work)等需要展示 GeoGebra 图形 + 命令的页面复用。
 * 功能：看图/显示命令切换、复制命令(非安全上下文降级)、自动注入 applet、可选登录门控。
 * 依赖：deployggb.js（须在本文件之前加载，提供全局 GGBApplet）。
 *
 * 登录门控（可选）：在 .ggb-container-wrapper 上设置
 *   data-require-login="true"   —— 未登录时拦截 显示命令 / 复制命令
 *   data-login-tip="请登录后再操作"  —— 拦截时弹出的提示文案
 * 同时暴露 window.ggbCheckLogin(wrapper) 供外部（如打赏按钮）复用同一套门控。
 */
(function () {
  'use strict';

  function loginBlocked(wrapper) {
    return !!(wrapper && wrapper.dataset.requireLogin === 'true');
  }
  function loginTip(wrapper) {
    return (wrapper && wrapper.dataset.loginTip) || '请登录后再操作';
  }
  // 供外部按钮（如打赏）调用：未登录返回 false（提示由调用方负责，避免弹出 alert）
  window.ggbCheckLogin = function (wrapper) {
    if (loginBlocked(wrapper)) { return false; }
    return true;
  };
  // 返回页面第一个画板 wrapper，便于外部按钮定位门控配置
  window.ggbBoardWrapper = function () {
    return document.querySelector('.ggb-container-wrapper');
  };

  // 非安全上下文(http://)下 navigator.clipboard 不可用，用 execCommand 兜底
  function fallbackCopyToClipboard(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) {
      showCopySuccess(btn);
    } else {
      alert(btn.getAttribute('data-fail') || 'Copy failed, please copy manually.');
    }
  }

  function showCopySuccess(btn) {
    var txt = btn.getAttribute('data-copied') || 'Copied';
    var old = btn.textContent;
    btn.textContent = txt;
    setTimeout(function () { btn.textContent = old; }, 1800);
  }

  // 公开：在看图(canvas) / 显示命令(commands) 视图间切换
  window.toggleGGBView = function (btn) {
    var wrapper = btn.closest('.ggb-container-wrapper');
    if (!wrapper) return;
    var target = btn.getAttribute('data-target');
    if (target === 'commands' && loginBlocked(wrapper)) {
      alert(loginTip(wrapper));
      return;
    }
    var btns = wrapper.querySelectorAll('.ggb-control-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    btn.classList.add('active');
    var canvas = wrapper.querySelector('.ggb-container');
    var cmd = wrapper.querySelector('.ggb-commands-display');
    if (target === 'commands') {
      if (canvas) canvas.style.display = 'none';
      if (cmd) cmd.style.display = 'block';
    } else {
      if (canvas) canvas.style.display = 'block';
      if (cmd) cmd.style.display = 'none';
    }
  };

  // 公开：复制命令（优先 navigator.clipboard，失败或非安全上下文降级 execCommand）
  window.copyGGBXML = function (btn) {
    var wrapper = btn.closest('.ggb-container-wrapper');
    if (loginBlocked(wrapper)) { alert(loginTip(wrapper)); return; }
    var xml = wrapper && wrapper.dataset.xmlContent;
    if (!xml) {
      alert(btn.getAttribute('data-fail') || 'Copy failed, please copy manually.');
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(xml).then(
        function () { showCopySuccess(btn); },
        function () { fallbackCopyToClipboard(xml, btn); }
      );
    } else {
      fallbackCopyToClipboard(xml, btn);
    }
  };

  function xmlFromWrapper(wrapper) {
    var ta = wrapper.querySelector('textarea.ggb-xml-data');
    if (ta) return ta.value;
    return wrapper.getAttribute('data-xml') || '';
  }

  function injectApplet(containerId, xml, height, is3d, onReady) {
    if (typeof GGBApplet === 'undefined') {
      if (typeof onReady === 'function') onReady();
      return;
    }
    var container = document.getElementById(containerId);
    if (!container) return;
    // 取主窗格真实可见宽度：inject 时 .ggb-content 仍是 display:none（子元素 clientWidth=0），
    // 故改为测量可见的 .ggb-container-wrapper；宽度占满主窗格，不再锁死 800 导致溢出/留白。
    var wrapper = container.closest('.ggb-container-wrapper');
    var availWidth = wrapper ? wrapper.getBoundingClientRect().width : 0;
    if (!availWidth || availWidth < 1) availWidth = container.clientWidth || 600;
    var width = Math.max(availWidth, 320);  // 极窄屏下限 320
    var finalHeight = height !== undefined ? height : Math.max(Math.round(width * 0.75), 320);
    var params = {
      id: containerId,
      width: width,
      height: finalHeight,
      showToolBar: false,
      showAlgebraInput: false,
      showMenuBar: false,
      // 立体几何材料改用 3D Calculator（classic 未开 3D 视图，Prism/Pyramid/z() 会失败）
      appName: is3d ? '3d' : 'classic',
      enableLabelDrags: false,
      enableShiftDragZoom: true,
      showZoomButtons: true,
      appletOnLoad: function (api) {
        try { api.setErrorDialogsActive(false); } catch (e) {}
        try { api.evalXML(xml); } catch (e) { console.error('[GeoGebra] evalXML failed:', e); }
        // 窗口/主窗格尺寸变化时同步画板尺寸。观察 .ggb-content（container 的父级，
        // 其高度由 CSS aspect-ratio:4/3 决定）：observe 后首次回调即给出初始尺寸，
        // 宽高双维度 setSize，宽度占满、高度按 4:3 自适应（与 draw_core.js 一致）。
        var contentEl = wrapper ? wrapper.querySelector('.ggb-content') : null;
        var observeTarget = contentEl || wrapper;
        if (observeTarget && typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
              var r = entries[i].contentRect;
              var nw = r.width, nh = r.height;
              if (nw > 100 && nh > 100) {
                try { api.setSize(Math.round(nw), Math.round(nh)); } catch (e2) {}
              }
            }
          });
          ro.observe(observeTarget);
        }
        if (typeof onReady === 'function') onReady();
      }
    };
    var applet = new GGBApplet(params, '5.0', containerId);
    applet.inject(containerId, 'preferHTML5');
  }

  // 加载完成：隐藏预览层，显示画板与操作控件
  function revealBoard(wrapper) {
    var preview = wrapper.querySelector('.ggb-preview');
    if (preview) preview.style.display = 'none';
    var content = wrapper.querySelector('.ggb-content');
    if (content) content.style.display = '';
    var header = wrapper.querySelector('.ggb-header');
    if (header) header.style.display = '';
  }

  function initBoards() {
    var wrappers = document.querySelectorAll('.ggb-container-wrapper');
    wrappers.forEach(function (w) {
      var container = w.querySelector('.ggb-container');
      if (!container) return;
      var xml = xmlFromWrapper(w);
      if (!xml) return;
      w.dataset.xmlContent = xml;
      // 加载前：隐藏画板与控件，显示预览图占位
      var content = w.querySelector('.ggb-content');
      if (content) content.style.display = 'none';
      var header = w.querySelector('.ggb-header');
      if (header) header.style.display = 'none';
      var hAttr = w.getAttribute('data-height');
      var h = hAttr === null || hAttr === '' ? NaN : parseInt(hAttr, 10);
      var is3d = w.getAttribute('data-is-3d') === '1';
      injectApplet(container.id, xml, isNaN(h) ? undefined : h, is3d, function () {
        revealBoard(w);
      });
    });
  }

  if (document.readyState !== 'loading') initBoards();
  else document.addEventListener('DOMContentLoaded', initBoards);
})();
