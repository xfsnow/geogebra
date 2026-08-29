// 账户面板通用交互逻辑（dashboard.html 引入，所有子页复用）
// 依赖：dashboard.html 注入的 window.I18N（按语言的中文案字典）
(function () {
  "use strict";

  var I18N = window.I18N || {};

  // 将 ledger 接口返回的 UTC ISO 时间格式化为本地 "YYYY-MM-DD HH:MM"
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 局部重渲染积分明细表格（不刷新整页）
  function renderLedger(items, direction) {
    var body = document.getElementById("ledgerBody");
    if (!body) return;
    body.innerHTML = "";
    var empty = document.getElementById("ledgerEmpty");
    if (!items || items.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    var isOut = direction === "out";
    items.forEach(function (it) {
      var tr = document.createElement("tr");

      var tdTime = document.createElement("td");
      tdTime.className = "ledger-date";
      tdTime.textContent = fmtTime(it.created_at);

      var tdDelta = document.createElement("td");
      tdDelta.className = "ledger-delta " + (isOut ? "out" : "in");
      tdDelta.textContent = (isOut ? "" : "+") + it.delta;

      var tdReason = document.createElement("td");
      tdReason.className = "ledger-reason";
      tdReason.textContent = it.reason_label || it.reason;

      tr.appendChild(tdTime);
      tr.appendChild(tdDelta);
      tr.appendChild(tdReason);
      body.appendChild(tr);
    });
  }

  // 拉取最新明细并渲染
  async function refreshLedger(direction) {
    try {
      var r = await fetch("/api/credit/ledger?direction=" + (direction || "in"), { credentials: "include" });
      if (!r.ok) return;
      var data = await r.json();
      renderLedger(data.items || [], direction || "in");
    } catch (e) {
      // 明细刷新失败不影响签到结果本身
    }
  }

  // 安全复制：优先 navigator.clipboard（需安全上下文），否则 execCommand 兜底
  // 注：http:// 等非安全上下文 navigator.clipboard 为 undefined，必须降级
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  // 邀请链接：生成二维码 + 点击复制（referral 页）
  function bindReferral() {
    var copyBtn = document.getElementById("copyLinkBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var input = document.getElementById("inviteLink");
        if (!input) return;
        input.select();
        copyText(input.value).then(function () {
          var old = copyBtn.textContent;
          copyBtn.textContent = I18N.copied || "已复制";
          setTimeout(function () { copyBtn.textContent = old; }, 1500);
        }).catch(function () {});
      });
    }
    var qrBox = document.getElementById("qrcode");
    var linkEl = document.getElementById("inviteLink");
    var link = linkEl ? linkEl.value : "";
    if (qrBox && link && typeof QRCode !== "undefined") {
      new QRCode(qrBox, { text: link, width: 128, height: 128 });
    }
  }

  // 每日签到：成功后局部更新余额/连续天数，并刷新当天明细
  function bindCheckin() {
    var btn = document.getElementById("checkinBtn");
    if (!btn || btn.disabled) return;
    btn.addEventListener("click", async function () {
      this.disabled = true;
      try {
        var r = await fetch("/api/credit/daily-checkin", { method: "POST", credentials: "include" });
        var data = await r.json();
        if (r.ok && data && data.ok) {
          var bal = document.getElementById("creditBalance");
          if (bal) bal.textContent = data.balance;
          var sb = document.getElementById("streakBox");
          if (sb) {
            sb.hidden = false;
            sb.textContent = (I18N.streak || "连续签到 {n} 天").replace("{n}", data.login_streak);
          }
          this.textContent = I18N.checkinDone || "今日已签到";
          alert((I18N.checkinOk || "签到成功，获得 {n} 积分").replace("{n}", data.credits_awarded));
          // 不刷新整页，仅局部刷新签到明细
          await refreshLedger("in");
        } else {
          this.textContent = I18N.checkinDone || "今日已签到";
          alert(I18N.checkinDone || "今日已签到");
        }
      } catch (e) {
        this.disabled = false;
        alert(I18N.checkinDone || "今日已签到");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { bindCheckin(); bindReferral(); });
  } else {
    bindCheckin();
    bindReferral();
  }
})();
