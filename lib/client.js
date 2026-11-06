// 浏览器半身(v0.10.0):把「空会话手动 /restart」留下的空结果命令卡从聊天流里摘掉。
//
// 宿主侧在空会话里把 /restart 的成功结果改成 SILENT_COMMAND_TEXT(一个零宽空格):
// command/run + command/done 仍照常落盘(命令生命周期不能缺),但正文不可见。
// dsh-client-ui-chat 的通用命令卡只按「有 outcome」渲染,空正文仍会留下一张卡;
// 这张卡会跟着空会话留到以后,和"直接新建会话"不一样。
//
// 为什么用 DOM 观察而不是 conversation.chat.commandview 槽位:
//   槽位按命令名("restart")命中,注册后就会替换掉**所有** restart 卡;非空会话的
//   restart 卡要保留(它写着会打断谁、交接存没存下),替换就得把整套卡片 UI 再实现一遍。
//   dsh-diagram 的实时路径同样用 MutationObserver,这里只做"摘掉带标记的卡"。
//
// 识别:命令流节点里的卡片 data-state="ok" 且正文含零宽标记(与宿主
// SILENT_COMMAND_TEXT 同一个字符;不靠标题,因为分页窗口可能只加载到 command/done,
// 那时 node.name 为 null,标题会退化成"指令")。
//
// 注:客户端改动在宿主重启后刷新页面即生效(模块系统按包提供 bundle)。
window.__ModuleLoader__.load({
  id: "dsh-host-restart",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 与宿主 lib/index.js 的 SILENT_COMMAND_TEXT 必须逐字符一致(零宽空格)。 */
    var SILENT_MARK = "\u200B";
    var HIDDEN_ATTR = "data-dsh-restart-silent";
    var STYLE_ID = "dsh-host-restart-silent-style";
    var CARD_SELECTOR = '[data-variant="others"]';

    var observer = null;
    var style = null;
    var scheduled = false;

    function ensureStyle() {
      if (typeof document === "undefined" || document.head === null) return;
      if (style !== null && style.isConnected) return;
      style = document.getElementById(STYLE_ID);
      if (style !== null) return;
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = "[" + HIDDEN_ATTR + "]{display:none!important}";
      document.head.appendChild(style);
    }

    /** 一张已结算、正文含零宽哨兵的命令卡 ⇒ 空会话 /restart 留下的空卡。 */
    function isSilentRestartCard(card) {
      if (card === null || card === undefined) return false;
      if (typeof card.getAttribute !== "function") return false;
      if (card.getAttribute("data-state") !== "ok") return false; // 运行中/失败卡保留
      var text = card.textContent;
      if (typeof text !== "string" || text.indexOf(SILENT_MARK) === -1) return false;
      // 只认重启卡:正常标题是 restart;分页只加载 command/done 时标题退化成通用「指令/Command」。
      var head = text.trim();
      return head.indexOf("restart") === 0 || head.indexOf("指令") === 0 || head.indexOf("Command") === 0;
    }

    function hideRow(row) {
      if (row.getAttribute(HIDDEN_ATTR) === "") return;
      row.setAttribute(HIDDEN_ATTR, "");
      row.hidden = true;
    }

    function scan(root) {
      if (typeof document === "undefined") return;
      ensureStyle();
      var scope = root !== null && root !== undefined && typeof root.querySelectorAll === "function" ? root : document;
      var rows = scope.querySelectorAll('[data-chat-flow-kind="command"]');
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].getAttribute("data-chat-flow-kind") !== "command") continue;
        var card = rows[i].querySelector(CARD_SELECTOR);
        if (isSilentRestartCard(card)) hideRow(rows[i]);
      }
    }

    function scheduleScan() {
      if (scheduled) return;
      scheduled = true;
      var flush = function () { scheduled = false; scan(document); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    }

    function apply(ctx) {
      if (typeof document === "undefined") return;
      scan(document);
      if (typeof MutationObserver !== "function") return;
      var target = document.body !== null ? document.body : document.documentElement;
      if (target === null || target === undefined) return;
      observer = new MutationObserver(scheduleScan);
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () {
            if (observer !== null) { observer.disconnect(); observer = null; }
            if (style !== null) { if (typeof style.remove === "function") style.remove(); style = null; }
            scheduled = false;
          };
        }, "restart: hide silent command card");
      }
    }

    exports.apply = apply;
    exports.inject = [];
    exports.__test = { isSilentRestartCard: isSilentRestartCard };
    return module.exports;
  },
});
