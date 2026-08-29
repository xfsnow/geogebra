// draw_byok.js —— BYOK 模式（自有 API Key / 本地历史）hook 注册与设置面板。
// 依赖 draw_core.js 先加载（提供 window.GGBApp、通用 sendMessage 与共享 UI）。
// 注意：本文件在独立作用域，_t / APP_CONFIG 等核心内部符号不可见，统一用 G.t / G.APP_CONFIG。
// 保留与原始 chatxml_byok.js 一致的元素 id（api-endpoint/api-key/model-name/save-settings）
// 与 localStorage 键（chatxml_settings_<uid> / chatxml_history_<uid>），保存时弹 alert。
window.GGB_CHAT_MODE = 'byok';
(function () {
  const G = window.GGBApp;
  const t = (key, fallback) => (G.t ? G.t(key, fallback) : fallback);
  const uid = (typeof window.GGB_USER_ID !== 'undefined') ? String(window.GGB_USER_ID) : 'anonymous';
  const SETTINGS_KEY = 'chatxml_settings_' + uid;
  const HISTORY_KEY = 'chatxml_history_' + uid;
  const RAG_KEY = 'rag_system_prompt_' + uid;

  // ===== 设置读写（localStorage，按用户隔离） =====
  function getSettings() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { return defaultSettings; }
    }
    return defaultSettings;
  }
  const defaultSettings = {
    apiKey: '', endpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4o', model: 'gpt-4o', systemPrompt: '', temperature: 0.7, stream: true
  };
  async function loadRagSystemPrompt(query) {
    try {
      const resp = await fetch('/rag/context?q=' + encodeURIComponent(query || ''));
      if (resp.ok) {
        const data = await resp.json();
        if (data.system_prompt) return data.system_prompt;
      }
    } catch (e) {
      console.error('[RAG] 获取系统提示词失败:', e);
    }
    return 'You are a GeoGebra geometry drawing expert. Generate complete XML commands in one shot based on the user\'s geometric drawing needs.';
  }
  function saveRagSystemPrompt(text) {
    try { if (text) localStorage.setItem(RAG_KEY, text); } catch (e) {}
  }
  function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { console.error('保存设置失败', e); }
  }

  // ===== 接线 byok.htm 中的静态设置弹窗（与原始 chatxml_byok.js 一致） =====
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const settingsElements = {
    endpoint: document.getElementById('api-endpoint'),
    apiKey: document.getElementById('api-key'),
    modelName: document.getElementById('model-name')
  };

  function loadSettings() {
    const s = getSettings();
    if (settingsElements.endpoint) settingsElements.endpoint.value = s.endpoint || '';
    if (settingsElements.apiKey) settingsElements.apiKey.value = s.apiKey || '';
    if (settingsElements.modelName) settingsElements.modelName.value = s.modelName || '';
  }

  function openSettingsModal() {
    loadSettings();
    if (settingsModal) settingsModal.classList.add('active');
  }
  function closeSettingsModal() {
    if (settingsModal) settingsModal.classList.remove('active');
  }

  function handleSaveSettings() {
    const settings = {};
    settings.endpoint = (settingsElements.endpoint && settingsElements.endpoint.value.trim()) || 'https://api.openai.com/v1/chat/completions';
    settings.apiKey = (settingsElements.apiKey && settingsElements.apiKey.value.trim()) || '';
    settings.modelName = (settingsElements.modelName && settingsElements.modelName.value.trim()) || 'gpt-4o';
    settings.model = settings.modelName;
    saveSettings(settings);
    alert(t('chatjs_save_success', 'Settings saved'));
    closeSettingsModal();
  }

  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);
  const cancelSettingsBtn = document.getElementById('cancel-settings-btn');
  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', closeSettingsModal);
  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', handleSaveSettings);

  // ===== 暴露给核心（供 sendImpl 等使用） =====
  G.getSettings = getSettings;
  G.loadRagSystemPrompt = loadRagSystemPrompt;
  G.showSettingsModal = openSettingsModal;
  G.hideSettingsModal = closeSettingsModal;

  // ===== 流式解析统一（A5 F2） =====
  // SSE 增量解析统一复用 core 的 G.extractDelta（兼容 OpenAI /data.data 包装）。
  // 此处仅保留「非流式整体对象」的内容提取（与 SSE line 语义不同，不注册到 G.extractDelta）。
  function extractFinalContent(data) {
    if (data && data.choices && data.choices[0]) {
      const ch = data.choices[0];
      if (ch.message && ch.message.content != null) return ch.message.content;
      if (ch.delta && ch.delta.content != null) return ch.delta.content;
    }
    if (data && data.content != null) return data.content;
    return '';
  }

  // ===== 发送实现：调用用户自有 endpoint =====
  G.sendImpl = async function ({ content, images, onStreamChunk }) {
    const settings = getSettings();
    if (!settings.apiKey) {
      closeSettingsModal();
      openSettingsModal();
      throw new Error(t('chatjs_error_no_key', 'Please configure your API Key in Settings first'));
    }

    const sys = await loadRagSystemPrompt(content) || settings.systemPrompt || '';
    const messages = [];
    if (sys) messages.push({ role: 'system', content: sys });

    // 注意：核心 sendMessage 在调用 sendImpl 前已将当前用户消息 push 进 history，
    // 因此遍历全量 history 即可（含当前问题），无需再单独追加 content。
    const history = G.getMessageHistory();
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && (!m.content || m.content.trim() === '')) continue;
      if (m.role === 'user' && typeof m.content === 'object') {
        messages.push({ role: 'user', content: m.content });
        continue;
      }
      messages.push({
        role: m.role,
        content: (typeof m.content === 'object')
          ? (m.content.find(c => c.type === 'text')?.text || '')
          : m.content
      });
    }

    let fullContent = '';
    const streamHandler = (chunk) => { fullContent += chunk; if (onStreamChunk) onStreamChunk(chunk); };
    let reqUrl = settings.endpoint.trim();
    if (!/\/chat\/completions$/i.test(reqUrl)) {
      reqUrl = reqUrl.replace(/\/+$/, '') + '/chat/completions';
    }
    const data = await G.createRequestWithProgress(
      reqUrl,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + settings.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: settings.model,
          messages: messages,
          stream: settings.stream,
          temperature: settings.temperature
        })
      },
      null,
      streamHandler
    );

    const aiContent = extractFinalContent(data) || fullContent;
    return { content: aiContent, xmlContent: undefined };
  };

  // ===== 本地历史 hooks（localStorage，复用 core 的 HistoryBackend 抽象，A5 F2） =====
  const lsBackend = G.makeLocalStorageBackend(HISTORY_KEY);
  G.historyList = async function () { return lsBackend.list(); };
  G.historySave = async function (title, messages, currentId) {
    let id = currentId;
    if (id) {
      const c = lsBackend.get(id);
      if (c) { c.title = title; c.messages = messages; c.updatedAt = Date.now(); lsBackend.save(c); return { id }; }
    }
    id = 'c_' + Date.now();
    lsBackend.save({ id, title, messages, updatedAt: Date.now() });
    return { id };
  };
  G.historyGet = async function (id) {
    const c = lsBackend.get(id);
    return c ? { id: c.id, title: c.title, messages: c.messages } : { id, title: '', messages: [] };
  };
  G.historyDelete = async function (id) { lsBackend.remove(id); };
  G.historySearch = async function (keyword) { return lsBackend.search(keyword); };

  // ===== 设置按钮绑定（DOM 就绪后） =====
  document.addEventListener('DOMContentLoaded', () => {
    const settingsBtn = document.getElementById('settings-btn');
    settingsBtn?.addEventListener('click', openSettingsModal);
  });
})();
