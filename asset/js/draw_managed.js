// draw_managed.js —— 受管模式（平台算力 /rag/chat + 云端历史）hook 注册。
// 依赖 draw_core.js 先加载（提供 window.GGBApp、通用 sendMessage 与共享 UI）。
// 本文件不重复定义 window.sendMessage，仅注册 hooks。
window.GGB_CHAT_MODE = 'managed';
(function () {
  const G = window.GGBApp;

  // ---- 流式内容提取（兼容 SSE data.content 与 OpenAI choices.delta/message）----
  G.extractDelta = function (data) {
    const ch = data && data.choices && data.choices[0];
    if (ch && ch.message && ch.message.content != null) return ch.message.content;
    if (ch && ch.delta && ch.delta.content != null) return ch.delta.content;
    if (data && data.data && data.data.content != null) return data.data.content;
    if (data && data.content != null) return data.content;
    return '';
  };

  // ---- SSE 解析：返回 { message, data: { content, xml } } ----
  G.parseFinal = function (sseContent) {
    const events = (sseContent || '').split('\n\n');
    const result = { message: 'ok', data: { content: '', xml: '' } };
    for (const event of events) {
      if (!event.trim()) continue;
      const lines = event.split('\n');
      let eventType = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        const parsed = JSON.parse(dataStr);
        if (eventType === 'message') {
          if (parsed.data && parsed.data.content) result.data.content += parsed.data.content;
          if (parsed.data && parsed.data.xml) result.data.xml = parsed.data.xml;
        } else if (eventType === 'xml') {
          result.data.xml = parsed.data ? parsed.data.xml : '';
        }
      } catch (e) {
        console.warn('解析 SSE 数据失败:', e);
      }
    }
    return result;
  };

  // ---- 发送实现：调用平台 /rag/chat ----
  G.sendImpl = async function ({ content, images, onStreamChunk }) {
    const selImg = G.getSelectedImageData();
    const messages = [];
    if (G.APP_CONFIG && G.APP_CONFIG.systemPrompt) {
      messages.push({ role: 'system', content: G.APP_CONFIG.systemPrompt });
    }
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
    if (images && images.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: content },
          { type: 'image_url', image_url: { url: images[0] } }
        ]
      });
    }

    const useReasoning = document.getElementById('reasoning-toggle')?.checked ||
      (window.GGB_REASONING_DEFAULT === true);
    const useWeb = document.getElementById('web-toggle')?.checked || false;

    let data;
    try {
      data = await G.createRequestWithProgress(
        '/rag/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ message: content, images: (images && images.length ? images : []), stream: false })
        },
        null,
        null
      );
    } catch (e) {
      // 后端 require_credits 校验不通过时返回 HTTP 402（已登录但积分不足）
      if (e && /402/.test(e.message || '')) {
        throw new Error(G.t('chatjs_error_insufficient_credits', 'Insufficient credits to use cloud AI.'));
      }
      throw e;
    }

    const aiContent = (data && data.data && data.data.content) || G.extractDelta(data) || '';
    const xmlContent = (data && data.data && data.data.xml) || '';
    return { content: aiContent, xmlContent };
  };

  // ---- 云端历史 hooks ----
  const CONV_BASE = '/api/chat/conversation';

  G.historyList = async function () {
    const r = await fetch(CONV_BASE + '/');
    if (!r.ok) throw new Error(G.t('chatjs_error_history_list', 'Failed to load conversation list: ') + r.status);
    const d = await r.json();
    const list = Array.isArray(d) ? d : (d.conversations || []);
    return list.map(c => ({
      id: c.conversation_id,
      title: c.title,
      messages: c.messages || [],
      updatedAt: c.created_at
    }));
  };

  G.historySave = async function (title, messages, currentId) {
    let saved;
    if (currentId) {
      const r = await fetch(CONV_BASE + '/' + currentId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, messages })
      });
      saved = await r.json();
      return { id: (saved && saved.conversation_id) || currentId };
    }
    const r = await fetch(CONV_BASE + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, messages })
    });
    saved = await r.json();
    return { id: saved && saved.conversation_id };
  };

  G.historyGet = async function (id) {
    const r = await fetch(CONV_BASE + '/' + id);
    const d = await r.json();
    return { id: d.conversation_id, title: d.title, messages: d.messages || [] };
  };

  G.historyDelete = async function (id) {
    await fetch(CONV_BASE + '/' + id, { method: 'DELETE' });
  };

  G.historySearch = async function (keyword) {
    const r = await fetch(CONV_BASE + '/search?q=' + encodeURIComponent(keyword));
    if (!r.ok) throw new Error(G.t('chatjs_error_history_search', 'Failed to search conversations: ') + r.status);
    const d = await r.json();
    const list = Array.isArray(d) ? d : (d.conversations || []);
    return list.map(c => ({
      id: c.conversation_id,
      title: c.title,
      messages: c.messages || [],
      updatedAt: c.created_at
    }));
  };
})();
