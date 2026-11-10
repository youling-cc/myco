package com.myco.phone;

import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * InAppBrowserActivity 的 WebViewClient（2026-10-23）。
 *
 * 为什么是独立顶层类而不是内部/匿名类：本仓的 d8 对「InAppBrowserActivity 里的嵌套类」
 * 一律报 CompilationFailedException internal error（匿名类覆写 deprecated 方法、命名内部类
 * 都踩过），而主壳的 PageSeen（独立文件）从来没出过问题 ⇒ 跟它同款。
 *
 * 职责：页面加载完成后注入「焦点守卫」JS（EXTRA_GUARD 传入；规则与单测在
 * apps/phone/src/inapp-focus-guard.ts）：DSH web 点会话会 programmatic focus 输入框，
 * 手机上会把软键盘弹出来挡内容——守卫把"非用户点输入框引发的聚焦"blur 掉。
 */
final class InAppBrowserClient extends WebViewClient {

    private final String guardJs;
    private final InAppBrowserActivity host;

    InAppBrowserClient(String guardJs, InAppBrowserActivity host) {
        this.guardJs = guardJs == null ? "" : guardJs;
        this.host = host;
    }

    /**
     * 渲染进程崩溃（2026-10-24 用户实测黑屏现场）：DSH 分享页吃内存，renderer 被杀后
     * 本 Activity 会停在黑屏；而壳的主 WebView 与它**共用同一 renderer 进程**，一起黑。
     * 这里直接收掉应用内浏览器（回主界面），主壳侧由 PageSeen.onRenderProcessGone 重建。
     */
    @Override
    public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        Log.w("MycoInApp", "renderer gone -> finish in-app browser");
        // 2026-10-31：复用槽保留的 WebView 已死——先清槽，否则下次同卡复用会挂回死页。
        try { host.onRendererGone(); } catch (Throwable ignored) { }
        try { host.finish(); } catch (Throwable ignored) { }
        return true;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        // 2026-10-25 修：null 回调在本机 WebView 上静默不执行（TunnelJs 头注释实证）——
        // 焦点守卫此前一次都没真正注入过。换非 null 空回调。
        if (!guardJs.isEmpty()) {
            view.evaluateJavascript(guardJs, JsNoOpCb.IT);
            Log.d("MycoInApp", "focus-guard injected @ " + url);
        }
        // 2026-10-31 状态契约（driftSignals）：页面加载完 8s 仍停在 DSH 引导空态
        // （暂无会话+选择工作区）→ 原生侧兜底 reload 一次。见 host 侧注释。
        if (host != null) {
            try { host.scheduleEmptyStateCheck(view); } catch (Throwable ignored) { }
        }
        // 2026-10-27 真案停用原生「重连中」watchdog：大 DSH 分享首载 3.5MB control +
        // 6.1MB follow，页面 6-12s 仍可能显示“重新连接中”，原生层无法看到 gateway
        // 注入的 remote.mux 状态，会把正常首载 reload 掉。页面内 gateway watchdog
        // 已按 __mux/__muxLastMsg 真实 WS 态决策；这里不再重复武装。
        // if (host != null && host.watchdog != null) {
        //     host.watchdog.arm();
        // }
    }
}
