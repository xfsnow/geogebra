// mathjax-config.js — 聊天页/BYOK 页的 MathJax 配置
// 须在 MathJax CDN 脚本（tex-mml-chtml.min.js）之前加载，
// 由 chat.htm / byok.htm 的 extra_head 引用（原内联配置外提）。
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']]
  },
  svg: { fontCache: 'global' }
};
