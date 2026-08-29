// 作品编辑页交互（account_work_edit.html 引入）
// 仅编辑文字内容；画板命令只读。保存走 PUT /api/work/{id} 重审；删除走 DELETE。
(function () {
  "use strict";

  var I18N = window.I18N || {};

  function workIdFromPath() {
    // /account/work/{work_id}
    var m = location.pathname.match(/\/account\/work\/([^/]+)/);
    return m ? m[1] : "";
  }

  function currentLang() {
    var l = (document.documentElement.getAttribute("lang") || "zh").split("-")[0];
    return l === "en" ? "en" : "zh";
  }

  // 保存：文字改动 -> PUT -> 状态回到 pending（重新审核）
  window.saveWorkEdit = function () {
    var workId = workIdFromPath();
    if (!workId) return;
    var title = document.getElementById("workTitle").value.trim();
    var desc = document.getElementById("workDesc").value;
    if (!title) {
      alert(I18N.my_works_title_required || "标题不能为空");
      return;
    }
    var saveBtn = document.getElementById("workSave");
    saveBtn.disabled = true;
    fetch("/api/work/" + workId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ title: title, description: desc, lang: currentLang() }),
    })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.json().then(function (d) { throw new Error(d.detail || "error"); });
      })
      .then(function () {
        // 状态徽标更新为“待审核”
        var badge = document.querySelector(".work-edit-status");
        if (badge) {
          badge.className = "card-status status-pending work-edit-status";
          badge.textContent = (I18N.status_map && I18N.status_map.pending) || "待审核";
        }
        var hint = document.getElementById("workSaveHint");
        if (hint) hint.classList.add("success");
        saveBtn.disabled = false;
      })
      .catch(function (e) {
        saveBtn.disabled = false;
        alert((I18N.my_works_edit_failed || "保存失败：{msg}").replace("{msg}", e.message || ""));
      });
  };

  // 危险操作：删除整个作品（改命令只能重传）
  window.deleteWorkEdit = function () {
    var workId = workIdFromPath();
    if (!workId) return;
    if (!confirm(I18N.my_works_delete_confirm || "确定删除整个作品吗？此操作不可恢复。")) {
      return;
    }
    var delBtn = document.getElementById("workDelete");
    delBtn.disabled = true;
    fetch("/api/work/" + workId, { method: "DELETE", credentials: "include" })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.json().then(function (d) { throw new Error(d.detail || "error"); });
      })
      .then(function () {
        // 删除后回到列表页
        location.href = "/account/work";
      })
      .catch(function (e) {
        delBtn.disabled = false;
        alert((I18N.my_works_delete_failed || "删除失败：{msg}").replace("{msg}", e.message || ""));
      });
  };
})();
