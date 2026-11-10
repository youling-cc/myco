/**
 * 应用内浏览器「焦点守卫」（2026-10-23，用户报：DSH web 每次点会话都自动弹软键盘）。
 *
 * 现象定位：DSH web 在切换会话时会 programmatic `.focus()` 到输入框——桌面端合理，
 * 手机端（InAppBrowserActivity 的 WebView）会把软键盘顶出来，挡住会话内容。
 *
 * 规则（`shouldBlurFocus`）：focus 目标是可编辑元素、但用户**最后一次触摸不是点在
 * 可编辑元素上**（= 程序聚焦而非用户主动点输入框）→ blur 掉，键盘不弹。
 * 用户直接点输入框（lastTouchEditable=true）→ 放行，键盘正常弹出。
 *
 * 交付形态：`INAPP_FOCUS_GUARD_JS` 是自包含脚本，由 `task-open.ts` 经
 * `MycoShell.openInAppBrowser(url, guardJs)` 传入，`InAppBrowserActivity` 在
 * `onPageFinished` 时注入——逻辑只在 TS 这一份，Java 不复制。
 * 测试见 `inapp-focus-guard.test.ts`（含对注入脚本本身的行为测试）。
 */

/** 纯决策函数：是否应把这次 focus blur 掉。 */
export function shouldBlurFocus(focusEditable: boolean, lastTouchEditable: boolean): boolean {
  return focusEditable === true && lastTouchEditable === false
}

/** 注入脚本：自包含、幂等（重复注入返回 'already'）、不依赖外部符号。 */
export const INAPP_FOCUS_GUARD_JS = `(function () {
  if (window.__mycoFocusGuard) return 'already';
  window.__mycoFocusGuard = 1;
  var EDIT_SELECTOR = 'input,textarea,[contenteditable]';
  function editable(el) {
    return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
  }
  var lastTouchEditable = false;
  document.addEventListener('touchend', function (e) {
    var t = e.target;
    lastTouchEditable = !!(t && t.closest && t.closest(EDIT_SELECTOR));
  }, true);
  document.addEventListener('focusin', function (e) {
    if (editable(e.target) && !lastTouchEditable) {
      try { e.target.blur(); } catch (x) { /* ignore */ }
      window.__mycoFocusGuardBlocked = (window.__mycoFocusGuardBlocked || 0) + 1;
    }
  }, true);
  return 'ok';
})()`
