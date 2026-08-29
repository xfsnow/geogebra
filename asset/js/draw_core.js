window.GGBApp = window.GGBApp || {};

// ===== A5 F2：在解析期（DOMContentLoaded 之前）定义可复用工具，供 wrapper（draw_byok.js 等）
// 在解析期注册 hooks 时直接调用，避免时序问题 =====

// 统一流式解析器（兼容 OpenAI SSE + 平台 /rag/chat 的 {data:{data:{content}}} 包装 + 兜底 XML 片段）
window.GGBApp._extractDeltaDefault = function (line) {
  if (line == null) return null;
  let s = typeof line === 'string' ? line : String(line);
  s = s.replace(/^data:\s*/, '');
  if (s === '[DONE]') return '[DONE]';
  if (!s || s[0] !== '{') return null;
  try {
    const j = JSON.parse(s);
    if (j.choices && j.choices[0] && j.choices[0].delta) {
      const d = j.choices[0].delta;
      if (d.reasoning_content != null && d.reasoning_content !== '') return d.reasoning_content;
      if (d.content != null) return d.content;
      return null;
    }
    if (j.error) throw new Error(j.error.message || 'stream error');
    if (j.data && j.data.data && j.data.data.content != null) return j.data.data.content;
    return null;
  } catch (e) {
    return s.indexOf('<') >= 0 ? s : null;
  }
};
// 统一清洗 ```ggb-xml ... ``` 代码块：移除所有完整块、并截断未闭合的尾巴，
// 避免流式/最终消息里泄露出 XML 标记。返回 {text, xml}，xml 为最后一个有效 construction 块。
function stripGGBXmlBlocks(text) {
  if (!text) return { text: '', xml: null };
  let cleaned = String(text);
  let lastXml = null;

  // 1) 移除所有完整闭合的 ggb-xml 代码块，并记录最后一个有效的 construction
  cleaned = cleaned.replace(/```ggb-xml\s*([\s\S]*?)\s*```/gi, function (match, code) {
    const xml = code.trim();
    if (xml.includes('<construction') && xml.includes('</construction>')) {
      lastXml = xml;
    }
    return '';
  });

  // 2) 处理流式时未闭合的尾巴：```ggb-xml\n...（直到文本末尾）
  const openMatch = cleaned.match(/```ggb-xml\s*([\s\S]*)$/i);
  if (openMatch) {
    cleaned = cleaned.slice(0, openMatch.index).trim();
  }

  return { text: cleaned.trim(), xml: lastXml };
}
window.GGBApp._stripGGBXmlBlocks = stripGGBXmlBlocks;

window.GGBApp._parseFinalDefault = function (text) {
  const stripped = stripGGBXmlBlocks(text);
  return { message: 'ok', data: { content: stripped.text, xml: stripped.xml || '' } };
};

// HistoryBackend 轻量抽象：localStorage 实现工厂，wrapper 注册到 history* hooks
window.GGBApp.makeLocalStorageBackend = function (storageKey) {
  const load = () => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); }
    catch (e) { return []; }
  };
  const persist = (arr) => localStorage.setItem(storageKey, JSON.stringify(arr));
  return {
    list() { return load().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); },
    save(conv) {
      const arr = load();
      const i = arr.findIndex((c) => c.id === conv.id);
      if (i >= 0) arr[i] = conv; else arr.unshift(conv);
      persist(arr);
    },
    get(id) { return load().find((c) => c.id === id) || null; },
    remove(id) { persist(load().filter((c) => c.id !== id)); },
    search(q) {
      q = (q || '').toLowerCase();
      const arr = load();
      if (!q) return arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return arr.filter((c) =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q))
      ).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
  };
};

document.addEventListener('DOMContentLoaded', () => {
  let selectedImageData = null;
  let selectedImageUrl = null;
  let currentChatId = null;
  let historyCache = [];

  // ==================== i18n 助手 ====================
  const _ggbI18n = window.GGB_I18N || {};
  const _t = (key, fallback) => (_ggbI18n[key] !== undefined ? _ggbI18n[key] : fallback);
  const _lang = (window.GGB_LANG === 'zh') ? 'zh' : 'en';
  const _locale = _lang === 'zh' ? 'zh-CN' : 'en-US';

  // ==================== 应用常量 ====================
  const APP_CONFIG = {
    welcomeTitle: _t('chatjs_welcome_title', 'Welcome to the AI Math Drawing Assistant'),
    welcomeMessage: _t('chatjs_welcome_msg', 'Enter your math drawing request, and AI will generate the GeoGebra XML and draw the figure for you.'),
    defaultChatTitle: _t('chatjs_default_title', 'New chat'),
    exampleQuestions: [
      _t('chatjs_ex1', 'Draw an equilateral triangle'),
      _t('chatjs_ex2', 'Construct a tangent to a circle'),
      _t('chatjs_ex3', 'Prove the Pythagorean theorem')
    ]
  };

  function escapeHtmlForCommands(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function createCommandsDisplay(container, xmlContent) {
    if (!xmlContent || !xmlContent.trim()) return null;
    
    const contentDiv = container.parentElement;
    if (!contentDiv || !contentDiv.classList.contains('ggb-content')) {
      console.warn('[createCommandsDisplay] 未找到ggb-content容器');
      return null;
    }
    
    let commandsDiv = contentDiv.querySelector('.ggb-commands-display');
    if (commandsDiv) {
      console.log('[createCommandsDisplay] 命令显示区域已存在');
      return commandsDiv;
    }
    
    commandsDiv = document.createElement('div');
    commandsDiv.className = 'ggb-commands-display';
    
    const escapedXml = escapeHtmlForCommands(xmlContent);
    const commandItemsHtml = `<div class="ggb-command-item"><code>${escapedXml}</code></div>`;
    
    const copyIconSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
    
    commandsDiv.innerHTML = `
      <div class="ggb-commands-header">
        <div class="ggb-commands-title">GeoGebra XML</div>
        <button class="copy-btn" onclick="copyGGBCommands(this)">
          ${copyIconSvg}
          <span>${_t('chatjs_copy', 'Copy')}</span>
        </button>
      </div>
      <div class="ggb-commands-list">
        ${commandItemsHtml}
      </div>
    `;
    
    commandsDiv.dataset.xmlContent = xmlContent;
    contentDiv.appendChild(commandsDiv);
    console.log('[createCommandsDisplay] ✓ XML显示区域已创建');
    return commandsDiv;
  }

  window.copyGGBCommands = function(button) {
    const commandsDiv = button.closest('.ggb-commands-display');
    if (!commandsDiv) return;
    
    try {
      const xmlContent = commandsDiv.dataset.xmlContent;
      if (!xmlContent) {
        alert(_t('chatjs_no_xml', 'No XML data found'));
        return;
      }
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(xmlContent).then(() => {
          showCopySuccess(button);
        }).catch(err => {
          console.error('[copyGGBCommands] Clipboard API 失败:', err);
          fallbackCopyToClipboard(xmlContent, button);
        });
      } else {
        fallbackCopyToClipboard(xmlContent, button);
      }
    } catch (e) {
      console.error('[copyGGBCommands] 错误:', e);
      alert(_t('chatjs_copy_err', 'Copy error: ') + e.message);
    }
  };

  function showCopySuccess(button) {
    const originalText = button.textContent.trim();
    button.textContent = _t('chatjs_copied', 'Copied');
    button.style.borderColor = '#52c41a';
    button.style.color = '#52c41a';
    
    setTimeout(() => {
      button.textContent = originalText;
      button.style.borderColor = '';
      button.style.color = '';
    }, 2000);
  }

  function fallbackCopyToClipboard(text, button) {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.cssText = 'position: fixed; left: -9999px; top: -9999px; opacity: 0;';
      document.body.appendChild(textArea);
      
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (successful) {
        showCopySuccess(button);
      } else {
        alert(_t('chatjs_copy_fail', 'Copy failed, please select and copy manually'));
      }
    } catch (err) {
      console.error('[fallbackCopyToClipboard] 错误:', err);
      alert(_t('chatjs_copy_fail', 'Copy failed, please select and copy manually'));
    }
  }

  window.toggleGGBView = function(button) {
    const wrapper = button.closest('.ggb-container-wrapper');
    if (!wrapper) return;

    const target = button.dataset.target;
    const controls = wrapper.querySelectorAll('.ggb-control-btn');
    const canvas = wrapper.querySelector('.ggb-container');
    const commands = wrapper.querySelector('.ggb-commands-display');

    controls.forEach(btn => btn.classList.remove('active'));

    if (target === 'canvas') {
      button.classList.add('active');
      if (canvas) canvas.style.display = 'block';
      if (commands) commands.style.display = 'none';
    } else if (target === 'commands') {
      button.classList.add('active');
      if (canvas) canvas.style.display = 'none';
      if (commands) commands.style.display = 'block';
    }
  };

  window.copyGGBXML = function(button) {
    const wrapper = button.closest('.ggb-container-wrapper');
    if (!wrapper) return;

    try {
      const xmlContent = wrapper.dataset.xmlContent;
      if (!xmlContent) {
        alert(_t('chatjs_no_xml', 'No XML data found'));
        return;
      }

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(xmlContent).then(() => {
          showCopySuccess(button);
        }).catch(err => {
          console.error('[copyGGBXML] Clipboard API 失败:', err);
          fallbackCopyToClipboard(xmlContent, button);
        });
      } else {
        fallbackCopyToClipboard(xmlContent, button);
      }
    } catch (e) {
      console.error('[copyGGBXML] 错误:', e);
      alert(_t('chatjs_copy_err', 'Copy error: ') + e.message);
    }
  };

  // ==================== 发布作品（step2：按钮 + 缩略图截图；step3 补全弹窗表单） ====================
  window.publishWork = function(button) {
    const wrapper = button.closest('.ggb-container-wrapper');
    if (!wrapper) return;

    const xml = wrapper.dataset.xmlContent;
    if (!xml) {
      alert(_t('chatjs_no_xml', 'No XML data found'));
      return;
    }

    // 缩略图：从 GeoGebra API 截图（PNG base64）
    let png = '';
    const api = wrapper._ggbApi;
    if (api && typeof api.getPNGBase64 === 'function') {
      try {
        png = api.getPNGBase64(1, 400, 300);
      } catch (e) {
        console.error('[publishWork] 缩略图生成失败:', e);
      }
    } else {
      console.warn('[publishWork] GeoGebra API 尚未就绪，缩略图为空');
    }

    window.__pendingPublish = { xml: xml, png: png };
    console.info('[publishWork] 已捕获作品：xml', xml.length, '字符，缩略图', (png || '').length, '字符');

    if (typeof openPublishModal === 'function') openPublishModal();
  };

  // ==================== 发布作品弹窗（step3：表单 + 校验态） ====================
  const PUB_I18N = 'chatjs_';   // byok 文案已并入 chatjs_（A5 F2 收敛）
  let _publishState = null;     // 缓存校验态：{ loggedIn, credits, isSubscriber, unlimited, syncUsed, syncMax }
  let _lastReviewSig = null;    // 上次 AI 审核通过的内容签名（内容未变则不重复扣费）
  let _lastReviewResult = null; // 上次 AI 审核结果缓存

  async function _fetchPublishState() {
    // 登录态由后端 /api/credit 的鉴权决定（未登录返回 401），不依赖前端未注入的全局变量。
    _publishState = { loggedIn: true, credits: 0, isSubscriber: false, unlimited: false, syncUsed: 0, syncMax: 0 };
    try {
      // 归并请求：/api/credit 已内嵌 quota，打开弹窗只需一次请求
      const cRes = await fetch('/api/credit');
      if (!cRes.ok) {
        _publishState = { loggedIn: false };
        return _publishState;
      }
      const cJson = await cRes.json();
      if (cJson) {
        _publishState.credits = cJson.credits || 0;
        _publishState.isSubscriber = !!cJson.subscription_tier;
        const quota = cJson.quota;
        if (quota) {
          _publishState.isSubscriber = !!quota.is_subscriber;
          const sync = (quota.features || []).find(f => f.feature === 'cloud_sync');
          if (sync) {
            _publishState.syncUsed = sync.used || 0;
            _publishState.syncMax = sync.max || 0;
            _publishState.unlimited = !!sync.unlimited;
          }
        }
      }
    } catch (e) {
      console.error('[publish] 获取配额失败:', e);
    }
    return _publishState;
  }

  function _setConfirmEnabled(enabled) {
    const btn = document.getElementById('publish-confirm-btn');
    if (btn) {
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.5';
      btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }
  }

  function _renderPublishStatus() {
    const box = document.getElementById('publish-status');
    if (!box) return;
    if (!_publishState || !_publishState.loggedIn) {
      box.className = 'publish-status publish-status--block';
      box.innerHTML = `<span>${_t(PUB_I18N + 'publish_login_required', 'Login required to publish')}</span>`
        + ` <a class="publish-login-link" href="/login">${_t(PUB_I18N + 'publish_login_btn', 'Log in')}</a>`;
      _setConfirmEnabled(false);
      return;
    }
    const blocks = [];
    if (_publishState.credits <= 0) {
      blocks.push(_t(PUB_I18N + 'publish_credits_low', 'Not enough credits to publish (requires credits > 0)'));
    }
    if (!_publishState.unlimited && _publishState.syncMax > 0 && _publishState.syncUsed >= _publishState.syncMax) {
      blocks.push(_t(PUB_I18N + 'publish_quota_full', 'Free cloud-sync limit reached ({n} works). Subscribe for unlimited publishing.').replace('{n}', String(_publishState.syncMax)));
    }
    if (blocks.length) {
      box.className = 'publish-status publish-status--block';
      box.innerHTML = blocks.map(b => `<div class="publish-status-item">${b}</div>`).join('');
      _setConfirmEnabled(false);
    } else {
      box.className = 'publish-status publish-status--ok';
      box.innerHTML = '';
      _setConfirmEnabled(true);
    }
  }

  window.openPublishModal = async function() {
    let modal = document.getElementById('publish-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'publish-modal';
      modal.className = 'modal-overlay publish-modal-overlay';
      modal.innerHTML = `
        <div class="modal-content publish-modal-content">
          <div class="modal-header">
            <h3>${_t(PUB_I18N + 'publish_title', 'Publish work')}</h3>
            <button class="modal-close-btn" type="button" onclick="closePublishModal()">×</button>
          </div>
          <div class="modal-body publish-modal-body">
            <div class="publish-preview"><img id="publish-preview-img" src="" alt="preview"></div>
            <div id="publish-status" class="publish-status"></div>
            <div id="publish-ai-hint" class="publish-ai-hint" style="display:none;"></div>
            <div class="publish-form">
              <div class="form-group">
                <label>${_t(PUB_I18N + 'publish_title_label', 'Title')} <span class="req">*</span></label>
                <input id="publish-title" type="text" maxlength="50" placeholder="${_t(PUB_I18N + 'publish_title_ph', 'Title')}" oninput="publishUpdateCount('title')">
                <div class="form-hint"><span id="title-count">0</span>/50</div>
              </div>
              <div class="form-group">
                <label>${_t(PUB_I18N + 'publish_desc', 'Description')}</label>
                <textarea id="publish-desc" maxlength="300" rows="3" placeholder="${_t(PUB_I18N + 'publish_desc_ph', 'Description')}" oninput="publishUpdateCount('desc')"></textarea>
                <div class="form-hint"><span id="desc-count">0</span>/300</div>
              </div>
              <div class="form-group">
                <label>${_t(PUB_I18N + 'publish_tags', 'Tags')}</label>
                <input id="publish-tags" type="text" placeholder="${_t(PUB_I18N + 'publish_tags_ph', 'Tags')}" oninput="publishUpdateCount('tags')">
                <div class="form-hint"><span id="tags-count">0</span>/5</div>
              </div>
              <div class="publish-ai-write">
                <button id="publish-ai-write-btn" type="button" class="btn-ghost" onclick="publishAiWrite()">${_t(PUB_I18N + 'publish_ai_write_btn', 'AI 帮我写标题/描述/标签')}</button>
                <span class="publish-ai-write-hint">${_t(PUB_I18N + 'publish_ai_write_hint', '（每次使用消耗 1 积分）')}</span>
              </div>
            </div>
          </div>
          <div class="modal-footer publish-modal-footer">
            <button class="btn-secondary" type="button" onclick="closePublishModal()">${_t(PUB_I18N + 'publish_cancel', 'Cancel')}</button>
            <button id="publish-confirm-btn" class="btn-primary" type="button" onclick="submitPublish()">${_t(PUB_I18N + 'publish_confirm', 'Publish')}</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) closePublishModal(); });
    }
    const data = window.__pendingPublish || {};
    const img = modal.querySelector('#publish-preview-img');
    if (img && data.png) {
      // getPNGBase64 返回纯 base64（无 data: 前缀）；拼成 Data URI 避免浏览器发起 HTTP 请求（414）
      img.src = data.png.startsWith('data:') ? data.png : 'data:image/png;base64,' + data.png;
    }
    // 重置表单
    const titleEl = modal.querySelector('#publish-title');
    const descEl = modal.querySelector('#publish-desc');
    const tagsEl = modal.querySelector('#publish-tags');
    if (titleEl) titleEl.value = '';
    if (descEl) descEl.value = '';
    if (tagsEl) tagsEl.value = '';
    publishUpdateCount('title'); publishUpdateCount('desc'); publishUpdateCount('tags');
    modal.style.display = 'flex';
    // 拉取并渲染校验态（登录/积分/配额）
    _publishState = null;
    await _fetchPublishState();
    _renderPublishStatus();
    // AI 帮写改为「用户点击按钮」触发（可选，消耗 1 积分）；此处不再自动调用
    _lastReviewSig = null;
    _lastReviewResult = null;
  };

  window.publishAiWrite = async function() {
    const modal = document.getElementById('publish-modal');
    if (!modal) return;
    const btn = modal.querySelector('#publish-ai-write-btn');
    const hint = modal.querySelector('#publish-ai-hint');
    const lang = window.GGB_LANG || 'zh';
    if (!_publishState || !_publishState.loggedIn || _publishState.credits <= 0) {
      if (hint) { hint.style.display = 'flex'; hint.textContent = _t(PUB_I18N + 'publish_ai_write_blocked', '请先登录且积分 > 0 才能使用 AI 帮写'); }
      return;
    }
    if (btn) btn.disabled = true;
    if (hint) { hint.style.display = 'flex'; hint.textContent = _t(PUB_I18N + 'publish_ai_writing', 'AI 生成中…'); }
    try {
      const resp = await fetch('/api/work/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: messageHistory, lang: lang }),
      });
      if (resp.ok) {
        const s = await resp.json();
        if (typeof s.credits === 'number') _publishState.credits = s.credits;
        _applySuggestion(modal, s);
        if (hint) hint.style.display = 'none';
      } else if (resp.status === 402) {
        if (hint) hint.textContent = _t(PUB_I18N + 'publish_ai_write_need_credits', '积分不足，无法使用 AI 帮写');
      } else {
        if (hint) hint.textContent = _t(PUB_I18N + 'publish_ai_write_failed', 'AI 帮写失败，请重试');
      }
    } catch (e) {
      console.error('[publish] 获取 AI 建议失败:', e);
      if (hint) hint.textContent = _t(PUB_I18N + 'publish_ai_write_failed', 'AI 帮写失败，请重试');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  function _applySuggestion(modal, s) {
    if (!s) return;
    const titleEl = modal.querySelector('#publish-title');
    const descEl = modal.querySelector('#publish-desc');
    const tagsEl = modal.querySelector('#publish-tags');
    if (titleEl && s.title) titleEl.value = s.title;
    if (descEl && s.description) descEl.value = s.description;
    if (tagsEl) {
      if (Array.isArray(s.tags)) tagsEl.value = s.tags.join(',');
      else if (typeof s.tags === 'string') tagsEl.value = s.tags;
    }
    publishUpdateCount('title'); publishUpdateCount('desc'); publishUpdateCount('tags');
  }

  window.publishUpdateCount = function(which) {
    if (which === 'title') {
      const el = document.getElementById('publish-title');
      const c = document.getElementById('title-count');
      if (el && c) c.textContent = el.value.length;
    } else if (which === 'desc') {
      const el = document.getElementById('publish-desc');
      const c = document.getElementById('desc-count');
      if (el && c) c.textContent = el.value.length;
    } else if (which === 'tags') {
      const el = document.getElementById('publish-tags');
      const c = document.getElementById('tags-count');
      if (el && c) {
        const n = el.value.split(/[,，]/).map(s => s.trim()).filter(Boolean).length;
        c.textContent = n;
      }
    }
  };

  function _markFieldError(el) {
    if (!el) return;
    el.style.borderColor = '#e53935';
    el.focus();
    setTimeout(function () { el.style.borderColor = ''; }, 2000);
  }

  window.submitPublish = async function() {
    const data = window.__pendingPublish || {};
    if (!data.xml) { alert(_t(PUB_I18N + 'no_xml', 'No XML data found')); return; }
    if (!_publishState || !_publishState.loggedIn) { window.location.href = '/login'; return; }

    const titleEl = document.getElementById('publish-title');
    const title = (titleEl ? titleEl.value : '').trim();
    if (!title) { _markFieldError(titleEl); alert(_t(PUB_I18N + 'publish_title_required', 'Please enter a title')); return; }
    if (title.length > 50) { alert(_t(PUB_I18N + 'publish_title_too_long', 'Title cannot exceed 50 characters')); return; }

    const descEl = document.getElementById('publish-desc');
    const desc = descEl ? descEl.value.trim() : '';
    if (desc.length > 300) { alert(_t(PUB_I18N + 'publish_desc_too_long', 'Description cannot exceed 300 characters')); return; }

    const tagsEl = document.getElementById('publish-tags');
    const tagsRaw = tagsEl ? tagsEl.value.trim() : '';
    const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
    if (tags.length > 5) { alert(_t(PUB_I18N + 'publish_tags_too_many', 'Up to 5 tags allowed')); return; }

    // 校验态拦截（积分 / 配额）
    if (_publishState.credits <= 0
        || (!_publishState.unlimited && _publishState.syncMax > 0 && _publishState.syncUsed >= _publishState.syncMax)) {
      _renderPublishStatus();
      return;
    }

    // 内容审核改为发布后的 AI 延时任务（见 work_i18n.md §5）：不阻塞发布、不重复扣费。
    // 直接交给 doPublish，审核/翻译/打标签由后台 worker 单次 AI 调用完成。
    doPublish({ xml: data.xml, png: data.png, title: title, description: desc, tags: tags.join(',') });
  };

  // PNG(base64) → webp Blob：用 canvas 转码，作品预览统一存 webp
  function _pngB64ToWebpBlob(pngB64) {
    return new Promise(function(resolve) {
      if (!pngB64) { resolve(null); return; }
      var src = pngB64.indexOf('data:') === 0 ? pngB64 : ('data:image/png;base64,' + pngB64);
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function(blob) { resolve(blob); }, 'image/webp', 0.85);
      };
      img.onerror = function() { resolve(null); };
      img.src = src;
    });
  }

  // 预览图直传 R2：预签名 PUT → confirm 回填 work.icon
  // chat.htm 已注入 window.GGB_USER_ID；后端 presign 要求 user_id 参数并与 cookie 鉴权核对。
  async function _uploadWorkPreview(workId, pngB64) {
    var uid = window.GGB_USER_ID;
    console.log('[publish:preview] start', { workId: workId, uid: uid, pngLen: pngB64 ? pngB64.length : 0 });
    if (!workId || !uid) { console.warn('[publish:preview] abort: missing workId/uid'); return; }
    var blob;
    try { blob = await _pngB64ToWebpBlob(pngB64); } catch (e) { console.error('[publish:preview] webp convert error', e); return; }
    if (!blob) { console.warn('[publish:preview] abort: webp blob empty'); return; }
    console.log('[publish:preview] webp blob', blob.size);
    var qs = new URLSearchParams({
      type: 'user_work', user_id: String(uid), work_id: workId,
      filename: 'preview.webp', mime: 'image/webp', size: String(blob.size),
    });
    var pres;
    try { pres = await fetch('/api/upload-presign?' + qs.toString(), { credentials: 'include' }); }
    catch (e) { console.error('[publish:preview] presign network error', e); return; }
    if (!pres.ok) { console.warn('[publish:preview] presign failed', pres.status); return; }
    var presData = await pres.json();
    console.log('[publish:preview] presign ok key=', presData.key);
    var put;
    try {
      put = await fetch(presData.upload_url, {
        method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob,
      });
    } catch (e) { console.error('[publish:preview] R2 PUT network/CORS error', e); return; }
    console.log('[publish:preview] R2 PUT status', put.status, 'ok', put.ok);
    if (!put.ok) { console.warn('[publish:preview] R2 PUT failed', put.status); return; }
    try {
      var conf = await fetch('/api/upload-confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ type: 'user_work', key: presData.key, work_id: workId }),
      });
      console.log('[publish:preview] confirm status', conf.status, 'ok', conf.ok);
    } catch (e) { console.error('[publish:preview] confirm network error', e); }
  }

  // 真实发布：POST /api/work，成功后上传预览图并跳转作品详情页（即「发布成功页」）
  window.doPublish = async function(payload) {
    const box = document.getElementById('publish-status');
    const btn = document.getElementById('publish-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = _t(PUB_I18N + 'publish_publishing', '发布中…'); }
    try {
      const resp = await fetch('/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          xml: payload.xml,
          title: payload.title,
          description: payload.description,
          tags: payload.tags,
          // 发布语言跟随 URL 首段（/zh/→zh，/en/→en），避免 cookie 残留英文导致中文站作品源语言为英文
          lang: window.GGB_LANG || 'zh',
        }),
      });
      if (resp.status === 403) {
        const data = await resp.json().catch(() => ({}));
        if (box) {
          box.className = 'publish-status publish-status--block';
          box.innerHTML = `<div class="publish-status-item">${data.detail && data.detail.message ? data.detail.message : _t(PUB_I18N + 'publish_quota_full', 'Free cloud-sync limit reached. Subscribe for unlimited publishing.')}</div>`;
        }
        if (btn) btn.disabled = false;
        return;
      }
      if (!resp.ok) {
        if (box) {
          box.className = 'publish-status publish-status--block';
          box.innerHTML = `<div class="publish-status-item">${_t(PUB_I18N + 'publish_failed', 'Publish failed, please retry')}</div>`;
        }
        if (btn) btn.disabled = false;
        return;
      }
      const data = await resp.json();
      // 作品预览图直传 R2（webp）：失败不阻断跳转
      try { await _uploadWorkPreview(data.work_id, payload.png); }
      catch (e) { console.warn('[doPublish] 预览上传失败:', e); }
      window.location.href = data.url;  // /g/{hash} 作品详情（发布成功页）
    } catch (e) {
      console.error('[doPublish] 发布失败:', e);
      if (box) {
        box.className = 'publish-status publish-status--block';
        box.innerHTML = `<div class="publish-status-item">${_t(PUB_I18N + 'publish_failed', 'Publish failed, please retry')}</div>`;
      }
      if (btn) btn.disabled = false;
    }
  };

  window.closePublishModal = function() {
    const modal = document.getElementById('publish-modal');
    if (modal) modal.style.display = 'none';
  };

  window.ggbLibLoaded = false;
  window.ggbLibLoading = false;
  window.ggbLoadPromise = null;

  function ensureGeoGebraLoaded() {
    if (window.ggbLibLoaded) {
      return Promise.resolve(true);
    }
    
    if (window.ggbLoadPromise) {
      return window.ggbLoadPromise;
    }
    
    window.ggbLoadPromise = new Promise((resolve, reject) => {
      const startTime = Date.now();
      const timeout = 20000;
      
      const checkInterval = setInterval(() => {
        const ggbLoaded = typeof GGBApplet !== 'undefined' && typeof GGBApplet === 'function';
        
        if (ggbLoaded) {
          clearInterval(checkInterval);
          window.ggbLibLoaded = true;
          window.ggbLoadPromise = null;
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          window.ggbLoadPromise = null;
          console.error('[GeoGebra] 库加载超时');
          reject(new Error(_t('chatjs_error_ggb_timeout', 'GeoGebra library loading timed out')));
        }
      }, 200);
    });
    
    return window.ggbLoadPromise;
  }

  ensureGeoGebraLoaded().catch(() => {});

  let ggbAppletQueue = [];
  let ggbAppletProcessing = false;

  function processGGBAppletQueue() {
    if (ggbAppletProcessing || ggbAppletQueue.length === 0) return;
    
    ggbAppletProcessing = true;
    const { containerId, xmlContent, viewRange, resolve } = ggbAppletQueue.shift();
    
    createGGBAppletInternal(containerId, xmlContent, viewRange).then(result => {
      resolve(result);
      ggbAppletProcessing = false;
      setTimeout(() => processGGBAppletQueue(), 300);
    }).catch(err => {
      console.error('[GeoGebra Queue] 创建失败:', err);
      resolve(null);
      ggbAppletProcessing = false;
      setTimeout(() => processGGBAppletQueue(), 300);
    });
  }

  function queueGGBApplet(containerId, xmlContent, viewRange) {
    return new Promise(resolve => {
      ggbAppletQueue.push({ containerId, xmlContent, viewRange, resolve });
      processGGBAppletQueue();
    });
  }

  function createGGBApplet(containerId, xmlContent, viewRange) {
    return queueGGBApplet(containerId, xmlContent, viewRange);
  }

  async function createGGBAppletInternal(containerId, xmlContent, viewRange) {
    try {
      await ensureGeoGebraLoaded();
    } catch (e) {
      console.error('[GeoGebra] 库加载失败:', e);
      return null;
    }

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[createGGBApplet] 容器不存在！');
      return null;
    }

    const initWidth = Math.max(container.clientWidth || 600, 320);
    const initHeight = Math.max(container.clientHeight || 400, 240);

    const params = {
        id: containerId,
        width: initWidth,
        height: initHeight,
        showToolBar: false,
        showAlgebraInput: false,
        showMenuBar: false,
        appName: "classic",
        language: (window.GGB_CHAT_MODE === 'byok') ? 'en' : _lang,
        enableLabelDrags: false,
        enableShiftDragZoom: true,
        showZoomButtons: true,
        capturingThreshold: null,
        useBrowserForJS: false,
    };

    if (viewRange) {
      params["xmin"] = viewRange.xMin || -10;
      params["xmax"] = viewRange.xMax || 10;
      params["ymin"] = viewRange.yMin || -10;
      params["ymax"] = viewRange.yMax || 10;
    }

    try {
      const applet = new GGBApplet(params, '5.0', containerId);
      
      let ggbApi = null;
      
      params.appletOnLoad = function(api) {
        ggbApi = api;
        try {
          if (typeof api.setErrorDialogsActive === 'function') api.setErrorDialogsActive(false);
        } catch(e) {}
        
        const containerEl = document.getElementById(containerId);
        const wrapperEl = containerEl ? containerEl.parentElement : null;
        const publishWrapEl = containerEl ? containerEl.closest('.ggb-container-wrapper') : null;
        if (publishWrapEl) publishWrapEl._ggbApi = api;

        if (wrapperEl && typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
              const newWidth = entry.contentRect.width;
              const newHeight = entry.contentRect.height;

              if (newWidth > 100 && newHeight > 100) {
                api.setSize(newWidth, newHeight);
              }
            }
          });

          resizeObserver.observe(wrapperEl);
        }
      };
      
      applet.inject(containerId, 'preferHTML5');

      if (xmlContent && xmlContent.trim()) {
        createCommandsDisplay(container, xmlContent);
        
        await new Promise((resolve) => {
          const startTime = Date.now();
          const checkInterval = setInterval(() => {
            if (!ggbApi) return;
            
            try {
              ggbApi.evalCommand('testReady=(0,0)');
              ggbApi.evalCommand('Delete[testReady]');
              clearInterval(checkInterval);
              
              setTimeout(async () => {
                try {
                  ggbApi.evalXML(xmlContent);
                } catch (e) {
                  console.error('[GeoGebra] XML 执行失败:', e);
                }
                
                setTimeout(function() {
                  try {
                    if (typeof ggbApi.evalCommand === 'function') {
                      ggbApi.evalCommand("SetAxesRatio[1, 1]");
                    }

                    if (viewRange && ggbApi.setCoordSystem) {
                      let xMin = viewRange.xMin || -10;
                      let xMax = viewRange.xMax || 10;
                      let yMin = viewRange.yMin || -10;
                      let yMax = viewRange.yMax || 10;

                      const containerEl = document.getElementById(containerId);
                      if (containerEl) {
                        const canvasWidth = containerEl.clientWidth || 600;
                        const canvasHeight = containerEl.clientHeight || 500;
                        const canvasRatio = canvasWidth / canvasHeight;

                        const desiredWidth = xMax - xMin;
                        const desiredHeight = yMax - yMin;
                        const desiredRatio = desiredWidth / desiredHeight;

                        if (canvasRatio > desiredRatio) {
                          const adjustedWidth = desiredHeight * canvasRatio;
                          const xCenter = (xMin + xMax) / 2;
                          xMin = xCenter - adjustedWidth / 2;
                          xMax = xCenter + adjustedWidth / 2;
                        } else {
                          const adjustedHeight = desiredWidth / canvasRatio;
                          const yCenter = (yMin + yMax) / 2;
                          yMin = yCenter - adjustedHeight / 2;
                          yMax = yCenter + adjustedHeight / 2;
                        }
                      }

                      ggbApi.setCoordSystem(xMin, xMax, yMin, yMax);
                      
                      if (typeof ggbApi.evalCommand === 'function') {
                        ggbApi.evalCommand("SetAxesRatio[1, 1]");
                      }
                    } else if (typeof ggbApi.zoomTo === 'function') {
                      ggbApi.zoomTo(200);
                    }
                    
                    if (typeof ggbApi.refreshViews === 'function') ggbApi.refreshViews();
                  } catch (e) {
                    console.error('[GeoGebra] 调整视图失败:', e);
                  }
                }, 300);
                
                resolve();
              }, 200);
            } catch (e) {
            }
            
            if (Date.now() - startTime > 20000) {
              clearInterval(checkInterval);
              console.error('[GeoGebra] 等待 applet 就绪超时');
              resolve();
            }
          }, 250);
        });
      }
      
      return { success: true };
    } catch (error) {
      console.error('[GeoGebra] 创建失败:', error);
      return null;
    }
  }

  const sidebar = document.querySelector('.sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const SIDEBAR_BREAKPOINT = 768;

  function checkSidebarAutoCollapse() {
    if (window.innerWidth <= SIDEBAR_BREAKPOINT) {
      sidebar?.classList.add('collapsed');
      sidebarOverlay?.classList.remove('active');
    } else {
      sidebar?.classList.remove('collapsed');
      sidebarOverlay?.classList.remove('active');
    }
  }
  checkSidebarAutoCollapse();
  window.addEventListener('resize', checkSidebarAutoCollapse);

  function toggleSidebar(show) {
    if (show === undefined) {
      sidebar?.classList.toggle('collapsed');
    } else if (show) {
      sidebar?.classList.remove('collapsed');
    } else {
      sidebar?.classList.add('collapsed');
    }
    
    const isCollapsed = sidebar?.classList.contains('collapsed');
    if (window.innerWidth <= SIDEBAR_BREAKPOINT) {
      sidebarOverlay?.classList.toggle('active', !isCollapsed);
    }
  }

  document.getElementById('toggle-sidebar-btn')?.addEventListener('click', () => {
    toggleSidebar();
  });

  sidebarOverlay?.addEventListener('click', () => {
    toggleSidebar(false);
  });

  document.addEventListener('click', (e) => {
    if (window.innerWidth <= SIDEBAR_BREAKPOINT) {
      const isSidebarClick = sidebar?.contains(e.target);
      const isToggleBtnClick = e.target.closest('#toggle-sidebar-btn');
      
      if (!isSidebarClick && !isToggleBtnClick) {
        const isCollapsed = sidebar?.classList.contains('collapsed');
        if (!isCollapsed) {
          toggleSidebar(false);
        }
      }
    }
  });

  const chatTitle = document.getElementById('chat-title');
  const chatContainer = document.getElementById('chat-container');

  function resetChat() {
    saveCurrentChat().then(() => {
      currentChatId = null;
      messageHistory = [];
      selectedImageData = null;
      selectedImageUrl = null;
      hideImagePreview();

      if (chatContainer) {
        chatContainer.innerHTML = `
          <div class="welcome-message">
            <h3>${APP_CONFIG.welcomeTitle}</h3>
            <p>${APP_CONFIG.welcomeMessage}</p>
            <div class="welcome-examples">
              ${APP_CONFIG.exampleQuestions.map(q => `<button type="button" class="example-tag">${q}</button>`).join('')}
            </div>
          </div>
        `;
        bindExampleTags();
      }
      if (chatTitle) chatTitle.textContent = APP_CONFIG.defaultChatTitle;
      renderHistoryList();
    });
  }

  [document.getElementById('new-chat-header-btn'), document.getElementById('new-chat-btn')].forEach(btn => {
    btn?.addEventListener('click', resetChat);
  });

  
  // ==================== 对话历史：统一接口（按 mode 分支，由 wrapper 注册 hooks） ====================
  async function loadHistory() {
    try {
      if (window.GGBApp.historyList) {
        const list = await window.GGBApp.historyList() || [];
        if (typeof window.GGBApp.setHistoryCache === 'function') window.GGBApp.setHistoryCache(list);
      }
    } catch (e) {
      console.error('加载历史记录失败:', e);
      if (typeof window.GGBApp.setHistoryCache === 'function') window.GGBApp.setHistoryCache([]);
    }
    return typeof window.GGBApp.getHistoryCache === 'function' ? window.GGBApp.getHistoryCache() : [];
  }

  function generateChatTitle(messages) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg) return _t('chatjs_default_title', 'New chat');
    const content = firstUserMsg.content;
    const text = typeof content === 'object' ? (content.find(c => c.type === 'text')?.text || '') : content;
    const trimmed = text.trim();
    return trimmed.length > 20 ? trimmed.substring(0, 20) + '...' : (trimmed || _t('chatjs_default_title', 'New chat'));
  }

  async function saveCurrentChat() {
    if (window.GGBApp.getMessageHistory().length === 0) return;
    const title = generateChatTitle(window.GGBApp.getMessageHistory());
    if (window.GGBApp.historySave) {
      const saved = await window.GGBApp.historySave(title, window.GGBApp.getMessageHistory(), window.GGBApp.getCurrentChatId());
      if (saved && saved.id) window.GGBApp.setCurrentChatId(saved.id);
    }
    await loadHistory();
    renderHistoryList();
  }

  async function loadConversation(id) {
    if (!window.GGBApp.historyGet) return;
    try {
      const conv = await window.GGBApp.historyGet(id);
      window.GGBApp.setCurrentChatId(conv.id);
      window.GGBApp.setMessageHistory(conv.messages || []);
      if (chatTitle) chatTitle.textContent = conv.title || APP_CONFIG.defaultChatTitle;
      chatContainer.innerHTML = '';
      window.GGBApp.getMessageHistory().forEach(msg => {
        addMessageToUI(msg.content, msg.role, false);
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
      renderHistoryList();
    } catch (e) {
      console.error('加载对话失败:', e);
    }
  }

  async function deleteChat(id, event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (!confirm(_t('chatjs_confirm_delete', 'Are you sure you want to delete this conversation?'))) return;
    if (window.GGBApp.historyDelete) {
      try { await window.GGBApp.historyDelete(id); } catch (e) { console.error('删除对话失败:', e); }
    }
    if (window.GGBApp.getCurrentChatId() === id) {
      resetChat();
    } else {
      await loadHistory();
      renderHistoryList();
    }
  }

  function renderHistoryList() {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;
    const history = window.GGBApp.getHistoryCache();
    if (history.length === 0) {
      historyList.innerHTML = '<div style="padding: 12px; color: #999; font-size: 13px; text-align: center;">' + _t('chatjs_no_history', 'No history yet') + '</div>';
      return;
    }
    historyList.innerHTML = history.map(chat => `
      <div class="history-item ${String(chat.id) === String(window.GGBApp.getCurrentChatId()) ? 'active' : ''}" data-chat-id="${chat.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="history-item-title">${escapeHtml(chat.title)}</span>
        <button class="history-delete-btn" data-chat-id="${chat.id}" title="${_t('chatjs_delete', 'Delete')}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `).join('');
    historyList.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => loadConversation(item.dataset.chatId));
    });
    historyList.querySelectorAll('.history-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => deleteChat(btn.dataset.chatId, e));
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== 搜索历史记录功能 ====================
  
  function highlightSearchTerm(text, term) {
    if (!term) return escapeHtml(text);
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<span class="search-result-highlight">$1</span>');
  }
  
  async function searchHistory(keyword) {
    try {
      return await window.GGBApp.historySearch(keyword) || [];
    } catch (e) { console.warn('搜索失败:', e); return []; }
  }
  
  function openSearchModal() {
    const searchModal = document.getElementById('search-modal');
    searchModal?.classList.add('active');
  }
  
  function closeSearchModal() {
    const searchModal = document.getElementById('search-modal');
    searchModal?.classList.remove('active');
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    const searchClearBtn = document.getElementById('search-clear-btn');
    if (searchClearBtn) searchClearBtn.style.display = 'none';
  }
  
  async function renderSearchResults(keyword) {
    const resultsContainer = document.getElementById('search-results');
    if (!resultsContainer) return;
    
    if (!keyword || keyword.trim().length < 2) {
      resultsContainer.innerHTML = '';
      return;
    }
    
    const results = await searchHistory(keyword);
    
    if (results.length === 0) {
      resultsContainer.innerHTML = '<div class="search-no-results">' + _t('chatjs_no_search', 'No matching conversations found') + '</div>';
      return;
    }
    
    resultsContainer.innerHTML = results.map(chat => {
      return `
        <div class="search-result-item" data-chat-id="${chat.conversation_id}">
          <div class="search-result-title">${highlightSearchTerm(chat.title, keyword)}</div>
          <div class="search-result-preview">${highlightSearchTerm((chat.title || '').substring(0, 100), keyword)}</div>
        </div>
      `;
    }).join('');
    
    // 绑定点击事件
    resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const conversationId = parseInt(item.dataset.chatId);
        loadChat(conversationId);
        closeSearchModal();
      });
    });
  }
  
  // ==================== 绑定搜索事件 ====================
  
  const openSearchBtn = document.getElementById('open-search-btn');
  const searchInput = document.getElementById('search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');
  const closeSearchBtn = document.getElementById('close-search-btn');
  
  // 打开搜索弹窗
  openSearchBtn?.addEventListener('click', () => {
    openSearchModal();
    searchInput?.focus();
  });
  
  // 搜索输入事件
  searchInput?.addEventListener('input', (e) => {
    const keyword = e.target.value;
    if (searchClearBtn) searchClearBtn.style.display = keyword ? 'block' : 'none';
    
    if (keyword.length >= 2) {
      renderSearchResults(keyword);
    } else {
      renderSearchResults('');
    }
  });
  
  // 搜索输入回车键
  searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      renderSearchResults(e.target.value);
    }
  });
  
  // 清除搜索按钮
  searchClearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (searchClearBtn) searchClearBtn.style.display = 'none';
    renderSearchResults('');
  });
  
  // 关闭搜索弹窗
  closeSearchBtn?.addEventListener('click', closeSearchModal);
  
  // 点击弹窗背景关闭
  document.getElementById('search-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'search-modal') {
      closeSearchModal();
    }
  });

  function showImagePreview(imageUrl) {
    const previewWrapper = document.getElementById('image-preview-wrapper');
    const previewImage = document.getElementById('image-preview');
    
    previewImage.src = imageUrl;
    previewWrapper.style.display = 'block';
  }

  function hideImagePreview() {
    const previewWrapper = document.getElementById('image-preview-wrapper');
    const previewImage = document.getElementById('image-preview');
    
    previewImage.src = '';
    previewWrapper.style.display = 'none';
    selectedImageData = null;
    selectedImageUrl = null;
  }

  function handleImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert(_t('chatjs_select_image', 'Please select an image file'));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      selectedImageData = e.target.result;
      selectedImageUrl = e.target.result;
      showImagePreview(e.target.result);
    };
    reader.readAsDataURL(file);
  }

  const imageInput = document.getElementById('image-input');
  const imageAttachmentBtn = document.getElementById('image-attachment-btn');
  const closePreviewBtn = document.getElementById('close-preview');

  imageInput?.addEventListener('change', handleImageUpload);
  imageAttachmentBtn?.addEventListener('click', () => {
    imageInput?.click();
  });
  closePreviewBtn?.addEventListener('click', hideImagePreview);

  let messageHistory = [];



  function addMessageToUI(content, role, skipScroll) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (typeof content === 'object' && content !== null) {
      const textParts = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const imageParts = content.filter(c => c.type === 'image_url');
      
      let htmlContent = '';
      if (imageParts.length > 0) {
        imageParts.forEach(img => {
          htmlContent += `<img src="${img.image_url.url}" alt="${_t('chatjs_image_alt','Image')}" class="message-image" style="max-width: 300px; max-height: 300px; border-radius: 8px; margin-bottom: 8px;">`;
        });
      }
      htmlContent += parseMarkdown(textParts);
      contentDiv.innerHTML = htmlContent;
    } else {
      const formatted = formatMessage(content);
      contentDiv.innerHTML = formatted.text;
      
      if (formatted.hasGGB && role === 'assistant') {
        const ggbContainerId = 'ggb-' + Date.now() + Math.random();
        const ggbWrapper = document.createElement('div');
        ggbWrapper.className = 'ggb-container-wrapper';
        ggbWrapper.innerHTML = `
          <div class="ggb-header">
            <div class="ggb-controls">
              <button class="ggb-control-btn active" data-target="canvas" onclick="toggleGGBView(this)">${_t('chatjs_canvas','Canvas')}</button>
              <button class="ggb-control-btn" data-target="commands" onclick="toggleGGBView(this)">${_t('chatjs_commands','Commands')}</button>
            </div>
            <button class="ggb-copy-btn" onclick="copyGGBXML(this)">${_t('chatjs_copy_commands','Copy commands')}</button>
            <button class="ggb-publish-btn" type="button" onclick="publishWork(this)" title="${_t('chatjs_publish','Publish work')}">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>${_t('chatjs_publish','Publish work')}</span>
            </button>
          </div>
          <div class="ggb-content">
            <div id="${ggbContainerId}" class="ggb-container"></div>
          </div>
        `;
        ggbWrapper.dataset.xmlContent = formatted.xmlContent;
        contentDiv.appendChild(ggbWrapper);
        
        setTimeout(() => {
          createGGBApplet(ggbContainerId, formatted.xmlContent, formatted.viewRange);
        }, 100);
      }
    }
    
    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
    
    if (typeof MathJax !== 'undefined') {
      MathJax.typesetPromise([contentDiv]).catch(err => {
        console.warn('[MathJax] 渲染失败:', err);
      });
    }
    
    if (!skipScroll) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    return contentDiv;
  }

  function extractGGBCommandsFromText(text) {
    const stripped = stripGGBXmlBlocks(text);
    if (stripped.xml) {
      return {
        success: true,
        xmlContent: stripped.xml,
        viewRange: null
      };
    }
    return {
      success: false,
      xmlContent: null,
      viewRange: null
    };
  }

  function formatMessage(content, xmlContent) {
    return formatMessageFromText(content, xmlContent);
  }

  function addMessageToUI(content, role, skipScroll, xmlContent) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (typeof content === 'object' && content !== null) {
      const textParts = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const imageParts = content.filter(c => c.type === 'image_url');
      
      let htmlContent = '';
      if (imageParts.length > 0) {
        imageParts.forEach(img => {
          htmlContent += `<img src="${img.image_url.url}" alt="${_t('chatjs_image_alt','Image')}" class="message-image" style="max-width: 300px; max-height: 300px; border-radius: 8px; margin-bottom: 8px;">`;
        });
      }
      htmlContent += parseMarkdown(textParts);
      contentDiv.innerHTML = htmlContent;
    } else {
      const formatted = formatMessage(content, xmlContent);
      contentDiv.innerHTML = formatted.text;
      
      if (formatted.hasGGB && role === 'assistant') {
        const ggbContainerId = 'ggb-' + Date.now() + Math.random();
        const ggbWrapper = document.createElement('div');
        ggbWrapper.className = 'ggb-container-wrapper';
        ggbWrapper.innerHTML = `
          <div class="ggb-header">
            <div class="ggb-controls">
              <button class="ggb-control-btn active" data-target="canvas" onclick="toggleGGBView(this)">${_t('chatjs_canvas','Canvas')}</button>
              <button class="ggb-control-btn" data-target="commands" onclick="toggleGGBView(this)">${_t('chatjs_commands','Commands')}</button>
            </div>
            <button class="ggb-copy-btn" onclick="copyGGBXML(this)">${_t('chatjs_copy_commands','Copy commands')}</button>
            <button class="ggb-publish-btn" type="button" onclick="publishWork(this)" title="${_t('chatjs_publish','Publish work')}">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>${_t('chatjs_publish','Publish work')}</span>
            </button>
          </div>
          <div class="ggb-content">
            <div id="${ggbContainerId}" class="ggb-container"></div>
          </div>
        `;
        ggbWrapper.dataset.xmlContent = formatted.xmlContent;
        contentDiv.appendChild(ggbWrapper);
        
        setTimeout(() => {
          createGGBApplet(ggbContainerId, formatted.xmlContent, formatted.viewRange);
        }, 100);
      }
    }
    
    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
    
    if (typeof MathJax !== 'undefined') {
      MathJax.typesetPromise([contentDiv]).catch(err => {
        console.warn('[MathJax] 渲染失败:', err);
      });
    }
    
    if (!skipScroll) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    
    return messageDiv;
  }

  function formatMessageFromText(content, xmlContent) {
    const stripped = stripGGBXmlBlocks(content);
    let extractedXml = xmlContent && xmlContent.trim() ? xmlContent.trim() : stripped.xml;

    if (extractedXml) {
      return {
        text: parseMarkdown(stripped.text).trim(),
        hasGGB: true,
        xmlContent: extractedXml,
        viewRange: null
      };
    }

    return {
      text: parseMarkdown(stripped.text),
      hasGGB: false
    };
  }

  function parseMarkdown(text) {
    if (!text) return '';
    
    let html = text;
    
    // 先提取代码块和行内代码，用占位符替换
    const codeBlocks = [];
    const inlineCodes = [];
    
    // 提取代码块
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      codeBlocks.push({ lang, code: code.trim() });
      return `[[CODE_BLOCK_${codeBlocks.length - 1}]]`;
    });
    
    // 提取行内代码
    html = html.replace(/`([^`]+)`/g, (match, code) => {
      inlineCodes.push(code);
      return `[[INLINE_CODE_${inlineCodes.length - 1}]]`;
    });
    
    // 对普通文本进行HTML转义
    html = escapeHtml(html);
    
    // 恢复代码块
    html = html.replace(/\[\[CODE_BLOCK_(\d+)\]\]/g, (match, idx) => {
      const block = codeBlocks[parseInt(idx)];
      return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
    });
    
    // 恢复行内代码
    html = html.replace(/\[\[INLINE_CODE_(\d+)\]\]/g, (match, idx) => {
      return `<code>${escapeHtml(inlineCodes[parseInt(idx)])}</code>`;
    });
    
    // 处理表格
    html = parseMarkdownTable(html);
    
    // 处理标题
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    
    // 处理加粗和斜体
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    // 处理段落和换行
    html = html.replace(/^\s*\n/g, '');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = `<p>${html}</p>`;
    
    return html;
  }

  function parseMarkdownTable(text) {
    if (!text.includes('|')) return text;
    
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      const next = lines[i + 1] || '';

      const looksLikeTableHeader = line.indexOf('|') >= 0;
      const looksLikeSeparator = /^(\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*)$/.test(next);

      if (looksLikeTableHeader && looksLikeSeparator) {
        const headerCells = line.split('|').map(s => s.trim()).filter((v, idx, arr) => !(v === '' && (idx === 0 || idx === arr.length -1)));
        i += 2;

        const rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0) {
          const rowCells = lines[i].split('|').map(s => s.trim()).filter((v, idx, arr) => !(v === '' && (idx === 0 || idx === arr.length -1)));
          if (rowCells.length === 0) break;
          rows.push(rowCells);
          i++;
        }

        let tableHtml = '<table class="ggb-markdown-table"><thead><tr>';
        headerCells.forEach(cell => {
          tableHtml += `<th>${escapeHtml(cell)}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        rows.forEach(r => {
          tableHtml += '<tr>';
          r.forEach(cell => {
            tableHtml += `<td>${escapeHtml(cell)}</td>`;
          });
          tableHtml += '</tr>';
        });

        tableHtml += '</tbody></table>';

        out.push(tableHtml);
        continue;
      }

      out.push(line);
      i++;
    }

    return out.join('\n');
  }

  // 创建带超时和进度指示的请求
  // 发送（纸飞机）与停止（方块）图标，内联 SVG，不依赖 emoji / 外部图标库
  const SEND_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
  const STOP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect></svg>';

  function createRequestWithProgress(url, options, onProgress, onStreamChunk) {
    return new Promise((resolve, reject) => {
      // 暴露当前请求的 AbortController，供「停止」按钮中断（见 G.abortCurrent）
      G._abortController = new AbortController();
      const abortController = G._abortController;
      const timeout = 600000;
      
      const timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new Error(_t('chatjs_error_req_timeout', 'Request timed out. Please try again.')));
      }, timeout);
      
      const progressInterval = setInterval(() => {
        if (onProgress) {
          onProgress('in_progress');
        }
      }, 5000);
      
      fetch(url, {
        ...options,
        signal: abortController.signal
      })
      .then(response => {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        if (!response.ok) {
          return response.json().then(errorData => {
            const err = new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            err.status = response.status;
            throw err;
          }).catch((e) => {
            if (e && e.status) throw e;
            const err = new Error(`HTTP error! status: ${response.status}`);
            err.status = response.status;
            throw err;
          });
        }
        
        const isStream = response.headers.get('content-type')?.includes('text/event-stream');
        
        if (isStream && onStreamChunk) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          
          const readChunk = () => {
            reader.read().then(({ done, value }) => {
              if (done) {
                try {
                  const parsed = window.GGBApp.parseFinal(fullContent);
                  resolve(parsed);
                } catch (e) {
                  resolve({ choices: [{ message: { content: fullContent } }] });
                }
                return;
              }
              
              const chunk = decoder.decode(value, { stream: true });
              fullContent += chunk;
              
              const lines = chunk.split('\n');
              let doneReceived = false;
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const dataStr = line.slice(6);
                  if (dataStr.trim() === '[DONE]') {
                    doneReceived = true;
                    break;
                  }
                  try {
                    const data = JSON.parse(dataStr);
                    const content = window.GGBApp.extractDelta(data);
                    if (content) {
                      onStreamChunk(content);
                    }
                  } catch (e) {
                    console.warn('解析SSE数据失败:', e);
                  }
                }
              }
              
              if (doneReceived) {
                try {
                  const parsed = window.GGBApp.parseFinal(fullContent);
                  resolve(parsed);
                } catch (e) {
                  resolve({ choices: [{ message: { content: fullContent } }] });
                }
                return;
              }
              
              readChunk();
            }).catch(error => {
              reject(error);
            });
          };
          
          readChunk();
        } else {
          return response.json().then(data => {
            resolve(data);
          });
        }
      })
      .catch(error => {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        reject(error);
      });
    });
  }
  
  const messageInput = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  messageInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (window.sendMessage) window.sendMessage();
    }
  });
  sendBtn?.addEventListener('click', () => { if (window.sendMessage) window.sendMessage(); });

  function bindExampleTags() {
    document.querySelectorAll('.example-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        if (messageInput) {
          messageInput.value = tag.textContent;
          messageInput.focus();
        }
      });
    });
  }

  function initWelcomeMessage() {
    const welcomeMessageDiv = document.querySelector('.welcome-message');
    if (!welcomeMessageDiv) return;
    
    const titleEl = welcomeMessageDiv.querySelector('h3');
    const messageEl = welcomeMessageDiv.querySelector('p');
    const examplesContainer = welcomeMessageDiv.querySelector('.welcome-examples');
    
    if (titleEl) titleEl.textContent = APP_CONFIG.welcomeTitle;
    if (messageEl) messageEl.textContent = APP_CONFIG.welcomeMessage;
    
    if (examplesContainer) {
      examplesContainer.innerHTML = APP_CONFIG.exampleQuestions.map(q => 
        `<button type="button" class="example-tag">${q}</button>`
      ).join('');
    }
  }

  initWelcomeMessage();
  bindExampleTags();
  loadHistory().then(() => renderHistoryList());

  // ==================== 加载态（共享） ====================
  function createLoadingDiv() {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message assistant loading';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'thinking-text';
    thinkingDiv.innerHTML = '<span class="thinking-message">' + _t('chatjs_thinking', 'AI is thinking...') + '</span><span class="thinking-cursor">|</span><span class="thinking-timer">0' + _t('chatjs_sec', 's') + '</span>';
    contentDiv.appendChild(thinkingDiv);
    loadingDiv.appendChild(contentDiv);
    const container = document.getElementById('chat-container');
    if (container) { container.appendChild(loadingDiv); container.scrollTop = container.scrollHeight; }
    const timerStartTime = Date.now();
    const timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - timerStartTime) / 1000);
      const timerSpan = loadingDiv.querySelector('.thinking-timer');
      if (timerSpan) {
        if (elapsed < 60) timerSpan.textContent = elapsed + _t('chatjs_sec', 's');
        else { const m = Math.floor(elapsed / 60); const sec = elapsed % 60; timerSpan.textContent = m + _t('chatjs_min', 'm') + sec + _t('chatjs_sec', 's'); }
      }
    }, 1000);
    loadingDiv._timerInterval = timerInterval;
    return loadingDiv;
  }

  function updateLoadingDiv(loadingDiv, text) {
    if (!loadingDiv) return;
    if (loadingDiv._timerInterval) { clearInterval(loadingDiv._timerInterval); loadingDiv._timerInterval = null; }
    const contentDiv = loadingDiv.querySelector('.message-content');
    if (contentDiv) contentDiv.innerHTML = parseMarkdown(stripGGBXmlBlocks(text).text);
  }

  function removeLoadingDiv(loadingDiv) {
    if (loadingDiv && loadingDiv.parentNode) {
      if (loadingDiv._timerInterval) clearInterval(loadingDiv._timerInterval);
      loadingDiv.parentNode.removeChild(loadingDiv);
    }
  }

  // ==================== 通用发送（按 mode 由 wrapper 注册 sendImpl / history* / extractDelta / parseFinal） ====================
  async function sendMessage() {
    const input = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    if (!input || !sendBtn) return;
    const content = input.value.trim();
    const selImg = window.GGBApp.getSelectedImageData();
    if (!content && !selImg) return;
    input.value = '';
    const userContent = [];
    if (content) userContent.push({ type: 'text', text: content });
    if (selImg) { userContent.push({ type: 'image_url', image_url: { url: selImg } }); window.GGBApp.hideImagePreview(); }
    const msg = userContent.length > 1 ? userContent : content;
    window.GGBApp.getMessageHistory().push({ role: 'user', content: msg });
    addMessageToUI(msg, 'user', false);
    const loadingDiv = createLoadingDiv();
    let streamContent = '';
    // 进入「生成中」状态：发送按钮变为停止按钮，点击可中断当前请求
    enterGeneratingState(sendBtn);
    try {
      if (!window.GGBApp.sendImpl) throw new Error(_t('chatjs_error_no_impl', 'Chat module is not ready. Please refresh the page.'));
      const result = await window.GGBApp.sendImpl({
        content,
        images: selImg ? [selImg] : [],
        onStreamChunk: function (chunk) { streamContent += chunk; updateLoadingDiv(loadingDiv, streamContent); }
      });
      const aiContent = (result && result.content != null) ? result.content : streamContent;
      removeLoadingDiv(loadingDiv);
      if (aiContent) {
        window.GGBApp.getMessageHistory().push({ role: 'assistant', content: aiContent });
        addMessageToUI(aiContent, 'assistant', false, result ? result.xmlContent : undefined);
        saveCurrentChat();
      }
    } catch (error) {
      removeLoadingDiv(loadingDiv);
      // 用户主动停止（AbortError）不计入错误，提示已停止即可
      if (error && error.name === 'AbortError') {
        const stoppedContent = window.GGBApp.t('chatjs_info_stopped', '（已停止生成）');
        window.GGBApp.getMessageHistory().push({ role: 'assistant', content: stoppedContent });
        addMessageToUI(stoppedContent, 'assistant', false);
        return;
      }
      console.error(error);
      // 对服务器超时/不可用类错误(5xx、网络错误、fetch 失败)显示友好提示，不暴露 HTTP 状态码
      const isServerOrNetworkError = (error && error.status >= 500) ||
        /network|timeout|failed to fetch|gateway|504|502|503|500/i.test(String(error.message || error));
      const userMessage = isServerOrNetworkError
        ? window.GGBApp.t('chatjs_error_retry', 'Sorry, an error occurred, please try again.')
        : window.GGBApp.t('chatjs_error_prefix', 'Sorry, an error occurred: ') + (error.message || error);
      window.GGBApp.getMessageHistory().push({ role: 'assistant', content: userMessage });
      addMessageToUI(userMessage, 'assistant', false);
    } finally {
      exitGeneratingState(sendBtn);
    }
  }

  // 进入生成态：发送按钮显示停止图标，点击触发当前请求中断
  function enterGeneratingState(sendBtn) {
    sendBtn.classList.add('generating');
    sendBtn.innerHTML = STOP_ICON_SVG;
    sendBtn.disabled = false;
    sendBtn.title = window.GGBApp.t('chatjs_stop', 'Stop');
    sendBtn.setAttribute('aria-label', window.GGBApp.t('chatjs_stop', 'Stop'));
    sendBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof G.abortCurrent === 'function') G.abortCurrent();
    };
  }

  // 退出生成态：恢复发送图标与发送功能
  function exitGeneratingState(sendBtn) {
    sendBtn.classList.remove('generating');
    sendBtn.innerHTML = SEND_ICON_SVG;
    sendBtn.title = window.GGBApp.t('chatjs_send', 'Send');
    sendBtn.setAttribute('aria-label', window.GGBApp.t('chatjs_send', 'Send'));
    sendBtn.onclick = null;
    sendBtn.disabled = false;
  }
  window.sendMessage = sendMessage;

  // ==================== 暴露共享模块（供 managed/byok wrapper 注册 hooks） ====================
  window.GGBApp = window.GGBApp || {};
  const G = window.GGBApp;
  G.t = _t;
  G.lang = _lang;
  G.locale = _locale;
  G.APP_CONFIG = APP_CONFIG;
  G.MODE = function () { return window.GGB_CHAT_MODE; };
  G.createGGBApplet = createGGBApplet;
  G.createCommandsDisplay = createCommandsDisplay;
  G.copyGGBXML = copyGGBXML;
  G.toggleGGBView = toggleGGBView;
  G.publishWork = publishWork;
  G.formatMessage = formatMessage;
  G.formatMessageFromText = formatMessageFromText;
  G.extractGGBCommandsFromText = extractGGBCommandsFromText;
  G.addMessageToUI = addMessageToUI;
  G.parseMarkdown = parseMarkdown;
  G.createRequestWithProgress = createRequestWithProgress;
  // 中断当前请求（停止按钮调用）；无进行中请求时为 no-op
  G.abortCurrent = function () {
    if (G._abortController) {
      G._abortController.abort();
      G._abortController = null;
    }
  };
  G.createLoadingDiv = createLoadingDiv;
  G.updateLoadingDiv = updateLoadingDiv;
  G.removeLoadingDiv = removeLoadingDiv;
  G.resetChat = resetChat;
  G.generateChatTitle = generateChatTitle;
  G.renderHistoryList = renderHistoryList;
  G.loadHistory = loadHistory;
  G.saveCurrentChat = saveCurrentChat;
  G.loadConversation = loadConversation;
  G.deleteChat = deleteChat;
  G.hideImagePreview = hideImagePreview;
  G.getChatContainer = function () { return chatContainer; };
  G.getChatTitle = function () { return chatTitle; };
  G.getMessageHistory = function () { return messageHistory; };
  G.setMessageHistory = function (v) { messageHistory = v; };
  G.getSelectedImageData = function () { return selectedImageData; };
  G.setSelectedImageData = function (v) { selectedImageData = v; };
  G.getSelectedImageUrl = function () { return selectedImageUrl; };
  G.setSelectedImageUrl = function (v) { selectedImageUrl = v; };
  G.getCurrentChatId = function () { return currentChatId; };
  G.setCurrentChatId = function (v) { currentChatId = v; };
  G.getHistoryCache = function () { return historyCache; };
  G.setHistoryCache = function (v) { historyCache = v; };
  // hook 默认值（wrapper 已在解析期注册，这里仅在缺失时兜底，避免覆盖已注册的 hooks）
  G.sendImpl = G.sendImpl || null;

  // 统一流式解析器兜底默认值（A5 F2，函数体已在解析期定义于 window.GGBApp 上，避免时序问题）
  G.extractDelta = G.extractDelta || window.GGBApp._extractDeltaDefault;
  G.parseFinal = G.parseFinal || window.GGBApp._parseFinalDefault;

  G.historyList = G.historyList || null;
  G.historySave = G.historySave || null;
  G.historyGet = G.historyGet || null;
  G.historyDelete = G.historyDelete || null;
  G.historySearch = G.historySearch || null;
});
