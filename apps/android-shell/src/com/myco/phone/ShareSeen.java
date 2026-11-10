package com.myco.phone;

import android.graphics.Bitmap;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 分享页的进度探针（顶层类）：把 URL/title 写进 ShareWebActivity 的字段，
 * 经 `/api/state`（EnvServer 走 MainActivity）不方便读——这里只用于**真机取证的
 * 页面标题**：adb 侧靠 `dumpsys`/截图看不到 WebView 标题，但 Activity 里可以
 * 通过 EnvServer 的 `snap`/`eval` 之外的方式读到。当前实现把标题推到标题栏，
 * 截图即可见（最简单的取证通道）。
 *
 * 2026-10-09 黑屏修复：加 `onRenderProcessGone`（真机"双击后黑屏、无法回退"
 * 的对症回调）。默认实现在 API 26+ 会**带走整个应用进程**（或留一块永久黑屏，
 * 死 WebView 上 goBack/canGoBack 全是空转）。这里改为：通知 Activity 收尸重建
 * （`ShareWebActivity.onRendererGone`：换新 WebView + 重载最后地址），并
 * return true 告诉系统"我们自己处理了"。minSdk 24/25 上框架不会调这个回调，
 * 覆写无害。
 *
 * 2026-10-12 取证三件套（"PC 刚重启后第一次打开白屏数分钟"那一轮，root cause
 * 一直钉不死就是因为页面上什么都不留）：
 *   · `onReceivedHttpError`：反代上游非 2xx → gw-http 行（哪个资源、什么码、
 *     主框架还是子资源——401 静默吃掉就是白页的形状）；
 *   · `onReceivedError`：网络层失败（拒连/超时/DNS）→ gw-net 行；
 *   · `onPageFinished`：问一句 body 可见文本长度 → gw-body 行（≈0 即"壳到了、
 *     SPA 没渲染"的白屏铁证签名），每次加载/重载都会留一行，序列一眼可读。
 *   只读不改行为——回调里全部 try/catch 吞掉，留证绝不反噬页面本身。
 */
public class ShareSeen extends WebViewClient {
    private final ShareWebActivity act;
    public ShareSeen(ShareWebActivity act) { this.act = act; }

    @Override public void onPageStarted(WebView v, String url, Bitmap favicon) {
        act.noteUrl(url);
        act.setStatus("加载中…");
        try { GwLog.note(act, "gw page start " + GwLog.shortUrl(url)); } catch (Exception ignored) { }
        // 焦点闸尽早装（越早越好——赶在 SPA 首次自动聚焦之前挂上监听）。
        // 此处文档可能还没建好 → 脚本可能落空，onPageFinished 再装一次兜底（幂等）。
        ShareFocusGuard.install(v);
    }

    @Override public void onPageFinished(WebView v, String url) {
        String t = act.pageTitle();
        act.setStatus(t == null || t.isEmpty() ? "任务" : t);
        // 2026-10-18：记页面加载完成时刻——回前台探针的"刚打开 8s 内不判死"宽限用它
        act.pageShownAt = System.currentTimeMillis();
        try {
            GwLog.note(act, "gw page finish " + GwLog.shortUrl(url));
            // 正文长度探针：壳到了、SPA 没渲染 = body≈0（白屏铁证签名）。
            // \\s 在 Java 串里是 \s——正则去空白后数长度。
            v.evaluateJavascript(
                    "(function(){try{return (document.body&&document.body.innerText||'').replace(/\\s+/g,'').length}catch(e){return 'ERR'}})()",
                    new ShareBodyLen(act, url));
        } catch (Exception ignored) { }
        // 兜底再装一次：装载期已经自己弹出来的键盘，由守卫末尾的三次定时 blur 清掉。
        ShareFocusGuard.install(v);
    }

    /** 上游非 2xx（401/5xx…）——API 23+ 签名，minSdk 24 ✓。 */
    @Override
    public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse resp) {
        try {
            GwLog.note(act, "gw http " + resp.getStatusCode()
                    + (req.isForMainFrame() ? " MAIN " : " sub ") + GwLog.shortUrl(req.getUrl()));
        } catch (Exception ignored) { }
    }

    /** 网络层失败（拒连/超时/DNS）——API 23+ 签名。 */
    @Override
    public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
        // 2026-10-18：**只有主框架**失败才改标题。子资源（favicon/插件 chunk/字体…）
        // 失败不代表任务打不开——真案：/favicon.ico 404 被写成"打不开这个任务（连接对方的
        // 设备失败）"，用户被误导（手机后台恢复调查取证）。
        if (req.isForMainFrame()) {
            // 2026-10-21（O06）：裸错误页不给用户看——交给 Activity 尝试恢复/回列表
            try { act.onMainFrameError(String.valueOf(err.getDescription())); } catch (Throwable ignored) { }
        }
        try {
            GwLog.note(act, "gw net " + err.getErrorCode() + " " + err.getDescription()
                    + (req.isForMainFrame() ? " MAIN " : " sub ") + GwLog.shortUrl(req.getUrl()));
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        try { GwLog.note(act, "gw render-gone crashed=" + detail.didCrash()); } catch (Exception ignored) { }
        act.onRendererGone();
        return true;
    }
}
