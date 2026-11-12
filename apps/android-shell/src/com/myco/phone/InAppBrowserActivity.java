package com.myco.phone;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 应用内浏览器视图（2026-10-23，手机 DSH 分享页打开用）。
 *
 * 为什么需要它（见 eval/vnet/PHONE-INAPP-BROWSER-HANDOFF-20261023.md）：
 *  - 系统浏览器（荣耀/百度 LightSearchActivity）经 vnet forward 打开 127.0.0.1 页面一律转圈；
 *  - 借主 WebView 顶层导航会被壳的 PageSeen 拉回 file:// 首页；
 *  ⇒ 只能用一个独立 WebView 承载分享入口页（带 cookie，可正常跑 SPA/WS）。
 *
 * 用法（MycoShell.openInAppBrowser(url, guardJs)）：
 *   Intent i = new Intent(ctx, InAppBrowserActivity.class);
 *   i.putExtra(InAppBrowserActivity.EXTRA_URL, url);
 *   i.putExtra(InAppBrowserActivity.EXTRA_GUARD, guardJs);   // 可选：页面加载后注入
 *   i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
 *
 * 2026-10-23（实测反馈两连）：
 *  ① 入口 URL 带 ?mt=<长票据>，卡片提示会溢出屏幕 → 展示侧截 query（见 task-open.ts）；
 *  ② DSH web 点会话会 programmatic focus 输入框 → 手机软键盘弹出挡内容。
 *     修法（应用层，两层）：
 *      a) 窗口不自动弹输入法（SOFT_INPUT_STATE_HIDDEN，主壳 2026-10-11 同款）；
 *      b) onPageFinished 注入「焦点守卫」JS（EXTRA_GUARD 传入；规则与单测在
 *         apps/phone/src/inapp-focus-guard.ts——程序聚焦 blur、用户点输入框放行）。
 *
 * 2026-10-31（用户真报案：返回 myco 再点同一张卡 → 空列表「选择工作区开始」）：
 *  - 每次点卡都 new 一个 Activity+WebView = 每次冷启动 DSH SPA；手机端偶发冷启动
 *    落到 onboarding 态（无工作区选择），列表为空（复现 3/7；PC/全新配置不复现）。
 *  - 修法（A 方案：原生复用）：**同一张分享的 WebView 跨 Activity 保留**——Back 只是
 *    脱离视图树不销毁；再点同卡直接把原页面挂回来（秒开、状态/WS 保持）。不同分享
 *    才重建 WebView。
 */
public class InAppBrowserActivity extends Activity {

    public static final String EXTRA_URL = "url";
    /** 可选：页面加载完成后注入的 JS（焦点守卫等）。空/缺省 = 不注入。 */
    public static final String EXTRA_GUARD = "guardJs";

    /** package-private：看门狗/渲染崩溃自愈（InAppReconnectWatchdog、InAppBrowserClient）要访问。 */
    WebView web;
    private String guardJs = "";

    // ── 2026-10-31 复用槽（同卡秒开 + 状态保持）──────────────────────────────
    /** 当前存活的应用内浏览器实例（为空 = 没有可复用的 Activity）。 */
    static InAppBrowserActivity sLive;
    static String sLiveKey = "";
    /** 跨 Activity 保留的 WebView（Back 后不销毁，仅脱离视图树）。 */
    static WebView sSharedWeb;
    static String sSharedKey = "";

    /** URL → 分享键：`/gw/<shareId>`；认不出时用去 query 的 URL。 */
    static String keyOf(String url) {
        if (url == null) return "";
        int i = url.indexOf("/gw/");
        if (i >= 0) {
            int j = url.indexOf('/', i + 4);
            if (j > 0) return url.substring(i, j);
            return url.substring(i);
        }
        int q = url.indexOf('?');
        return q > 0 ? url.substring(0, q) : url;
    }

    /**
     * 同一张分享且实例还活着 → REORDER_TO_FRONT 直接回前台（onNewIntent 不会再 loadUrl）。
     * 返回 true = 已复用，调用方不要再 new。
     */
    static boolean tryBringToFront(android.content.Context ctx, String url) {
        InAppBrowserActivity a = sLive;
        if (a == null || a.isFinishing() || a.isDestroyed()) return false;
        if (!keyOf(url).equals(sLiveKey)) return false;
        try {
            Intent i = new Intent(ctx, InAppBrowserActivity.class);
            i.putExtra(EXTRA_URL, url);
            i.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 渲染进程崩溃：复用槽里的 WebView 已不可用，清槽（InAppBrowserClient 调用）。 */
    void onRendererGone() {
        WebView w = sSharedWeb;
        sSharedWeb = null;
        sSharedKey = "";
        if (w != null) {
            try { ViewGroup p = (ViewGroup) w.getParent(); if (p != null) p.removeView(w); } catch (Throwable ignored) { }
            try { w.destroy(); } catch (Throwable ignored) { }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // ① 不自动弹输入法（主壳 2026-10-11 同款处理；配合注入守卫，键盘只对用户主动点输入框弹出）
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
        Intent it = getIntent();
        String url = it == null ? null : it.getStringExtra(EXTRA_URL);
        String g = it == null ? null : it.getStringExtra(EXTRA_GUARD);
        guardJs = g == null ? "" : g;
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }
        String key = keyOf(url);
        WebView shared = sSharedWeb;
        if (shared != null && key.equals(sSharedKey)) {
            // 复用：把保留的 WebView 挂回视图树（页面/WS 状态原样，秒开）
            web = shared;
            try {
                ViewGroup p = (ViewGroup) web.getParent();
                if (p != null) p.removeView(web);
            } catch (Throwable ignored) { }
            Log.i("MycoInApp", "reuse shared webview: " + key);
        } else {
            if (shared != null) {
                // 不同分享：旧 WebView 退役
                try {
                    ViewGroup p = (ViewGroup) shared.getParent();
                    if (p != null) p.removeView(shared);
                } catch (Throwable ignored) { }
                try { shared.destroy(); } catch (Throwable ignored) { }
                sSharedWeb = null;
                sSharedKey = "";
            }
            web = new WebView(this);
            try {
                web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            } catch (Throwable ignored) { }
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            // 2026-11-12 白屏终修同款：分享面走隧道动态口，Chromium 按 URL 缓存会把
            // 旧隧道的 404 钉死（系统浏览器正常/应用内 46 条模块错误，对照实证）。
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);
            // 分享入口要用 cookie（302 Set-Cookie）；主壳已放开，这里保持一致
            try {
                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setAcceptThirdPartyCookies(web, true);
            } catch (Throwable ignored) { }
        }
        // ② 焦点守卫注入点：每页加载完注入（客户端是独立顶层类——d8 对本类嵌套类报
        //    internal error，见 InAppBrowserClient 的说明）。复用实例时重设 client，
        //    保证 host 指向本次 Activity（防旧 Activity 已销毁仍被回调）。
        web.setWebViewClient(new InAppBrowserClient(guardJs, this));
        setContentView(web);
        if (web != shared) {
            web.loadUrl(url);
        }
        sSharedWeb = web;
        sSharedKey = key;
        sLive = this;
        sLiveKey = key;
        // 2026-10-31 状态契约（driftSignals 观察者）：空态兜底每次打开只重载一次。
        emptyStateReloads = 0;
        // 2026-10-27：保留 dormant watchdog 对象（生命周期 dispose 兼容），但不再 arm。
        // 大 DSH 分享首载 6-12s 可能仍显示“重新连接中”；页面内 gateway watchdog 才能看到
        // remote.mux 真实状态，原生层不能按正文关键词重复 reload。
        watchdog = new InAppReconnectWatchdog(this);
    }

    // ══ 2026-10-31 空态兜底（状态契约 driftSignals：观察者 + 一次恢复动作）══
    // 真案：客户端 dsh.sessions.current 指针丢失（升级清理/落盘竞态）→ DSH SPA 冷启动
    // 停在「选择工作区」空态（深色 = 用户看到的黑屏），页面自身决策核把这种态判为
    // online 不重载。网关侧已有指针种子兜底（dsh_share.rs 的 MOST_RECENT_SESSION）；
    // 这里再从原生侧观察：页面加载完 8s 仍空态 → reload 一次，给种子/数据第二次
    // 生效机会。每次打开最多一次；两次都空 = 数据真没有，交还用户（不做循环）。
    private int emptyStateReloads = 0;
    private final android.os.Handler emptyStateHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    /** 页面探针：正文同时含「暂无会话」+「选择工作区」= DSH 引导空态。返回 "1"/""。 */
    private static final String EMPTY_STATE_PROBE =
            "(function(){try{var t=document.body?document.body.innerText:'';"
            + "return (t.indexOf('\\u6682\\u65e0\\u4f1a\\u8bdd')>=0"
            + "&&t.indexOf('\\u9009\\u62e9\\u5de5\\u4f5c\\u533a')>=0)?'1':'';"
            + "}catch(e){return '';}})()";

    /** 空态兜底第二步：清掉陈旧/无效的会话指针（DSH SPA 的 key），
     *  让网关 bootstrap 的「最近活跃会话」种子在下次加载时重新预置。 */
    private static final String CLEAR_SESSION_POINTER_JS =
            "(function(){try{localStorage.removeItem('dsh.sessions.current');return '1';}"
            + "catch(e){return '';}})()";

    /** 由 InAppBrowserClient.onPageFinished 调：安排一次延迟空态检查。
     *  Runnable/ValueCallback 用**顶层类**（InAppEmptyStateCheck / InAppEmptyProbeCb）——
     *  本仓 d8 对本 Activity 的嵌套/匿名类报 internal error（见 InAppBrowserClient 头注释）。 */
    void scheduleEmptyStateCheck(final android.webkit.WebView view) {
        if (emptyStateReloads >= 1) return;
        emptyStateHandler.postDelayed(new InAppEmptyStateCheck(this, view), 8000);
    }

    /** 探针执行（顶层 Runnable 回调进来；宿主/视图一致性校验后才探测）。 */
    void runEmptyStateProbe(android.webkit.WebView view) {
        if (isFinishing() || isDestroyed()) return;
        if (web == null || web != view) return; // 已换页/换实例：放弃本次
        try {
            view.evaluateJavascript(EMPTY_STATE_PROBE, new InAppEmptyProbeCb(this, view));
        } catch (Throwable ignored) { }
    }

    /** 探针结果：空态且未兜底过 → **先清陈旧指针**再 reload 一次。
     *  2026-10-31 真案补漏：只 reload 不够——指针是"存在但陈旧/无效"时，
     *  网关种子（只在缺失时写）不会接管，重载后仍是同一空态（真机 22:36/22:38
     *  两次 inapp-empty-reload 后页面依旧空）。清掉指针 → 重载 → 网关 bootstrap
     *  以「最近活跃会话」重新预置 → SPA 直接进会话。每次打开最多一次，不做循环。 */
    void onEmptyStateProbe(android.webkit.WebView view, String v) {
        if (isFinishing() || isDestroyed()) return;
        if (web == null || web != view) return;
        if (v != null && v.contains("\"1\"") && emptyStateReloads < 1) {
            emptyStateReloads++;
            try {
                GwLog.note(this, "inapp-empty-fix 空态兜底：清陈旧会话指针后重载（观察者触发）");
            } catch (Throwable ignored) { }
            try {
                view.evaluateJavascript(CLEAR_SESSION_POINTER_JS, new InAppEmptyFixCb(this, view));
            } catch (Throwable ignored) { }
        }
    }

    /** 清指针完成后的重载（由顶层 InAppEmptyFixCb 回调）。 */
    void reloadAfterEmptyFix(android.webkit.WebView view) {
        if (isFinishing() || isDestroyed()) return;
        if (web == null || web != view) return;
        try { view.reload(); } catch (Throwable ignored) { }
    }

    /** 复用路径：REORDER_TO_FRONT 回来时走这里。同分享不重载；换分享才 loadUrl。 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = intent == null ? null : intent.getStringExtra(EXTRA_URL);
        String key = keyOf(url);
        if (url == null || url.isEmpty() || web == null) return;
        if (!key.isEmpty() && !key.equals(sSharedKey)) {
            sSharedKey = key;
            sLiveKey = key;
            web.loadUrl(url);
            Log.i("MycoInApp", "reuse switch share: " + key);
        }
    }

    /** 看门狗（package-private：InAppReconnectWatchdog / InAppReconnectCheck 访问）。 */
    InAppReconnectWatchdog watchdog;
    /** 已自动 reload 次数（看门狗上限闸）。 */
    int reconnectReloads;

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (watchdog != null) {
            watchdog.dispose();
            watchdog = null;
        }
        WebView w = web;
        web = null;
        if (w != null) {
            try {
                ViewGroup p = (ViewGroup) w.getParent();
                if (p != null) p.removeView(w);
            } catch (Throwable ignored) { }
            if (w != sSharedWeb) {
                // 非复用槽实例（换分享时被退役的那只）→ 销毁
                try { w.destroy(); } catch (Throwable ignored) { }
            }
            // 复用槽实例：不销毁，页面与 WS 保持，下次同卡秒开
        }
        if (sLive == this) {
            sLive = null;
            sLiveKey = "";
        }
        super.onDestroy();
    }
}
