package com.myco.phone;

import android.graphics.Bitmap;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** 页面可见状态记录(顶层类——R8):onPageFinished 把 url/title 写进 MainActivity
 *  的 volatile 字段,EnvServer 直接读字段——既不碰 UI 线程(轮询卡死),也不用
 *  WebView getter(非主线程返回 null,2026-09-04 实测回归)。 */
public class PageSeen extends WebViewClient {
    private final MainActivity act;
    public PageSeen(MainActivity act) { this.act = act; }
    @Override public void onPageFinished(WebView v, String url) {
        act.lastUrl = url == null ? "" : url;
        try { act.lastTitle = v.getTitle() == null ? "" : v.getTitle(); } catch (Exception e) { act.lastTitle = ""; }
        // 2026-10-28 深链接登录（DL-Auth）：页面加载完 → 注入 pending 的 myco:// URI
        act.injectDeepLinkIfPending();
    }
    @Override public void onPageStarted(WebView v, String url, Bitmap favicon) {
        act.lastUrl = url == null ? "" : url;
    }

    /**
     * 渲染进程崩溃自愈（2026-10-10，真机"开卡后主界面 JS 永久死"修复）：
     * DSH 分享流程内存压力大时 renderer 被杀，默认行为是整个 WebView 变死页
     * （evaluateJavascript 永远超时、物理 tap 无响应、画面停在最后一帧）。
     * 返回 true 阻止系统杀应用进程，然后在 UI 线程重建 WebView 内容（重载主页面）。
     * 重建委托给 MainActivity 的公共方法（顶层类纪律：不做匿名内嵌 Runnable）。
     */
    @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
        act.onMainRenderGone(v);
        return true;
    }
}
