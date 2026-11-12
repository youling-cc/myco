package com.myco.phone;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * ShareWebActivity — 分享任务页的**独立 WebView**（"点卡就进"的第 ⑤ 步）。
 *
 * 为什么必须是独立 Activity，而不是主 WebView 导航过去：
 *   隧道客户端（`p2p-tunnel.ts` / `native-proxy.ts`）跑在 myco 主界面的 WebView 里，
 *   它持有本地端口与所有隧道连接。**主 WebView 一旦导航，JS 上下文被销毁**
 *   → 隧道全断、本地端口成孤儿 → 页面立刻白屏。所以分享页另开一个 Activity，
 *   主界面那个 WebView 保持存活继续搬字节。
 *
 * 页面地址形如 `http://127.0.0.1:<本地端口>/gw/<id>/?mt=…`——**localhost** 在
 * Chromium 里是可信来源（secure context），且 manifest 已开 `usesCleartextTraffic`。
 *
 * 返回键：网页能后退就后退，否则关掉本 Activity（回 myco 主界面 = 回任务卡）。
 *
 * 2026-10-09 黑屏修复（真机反馈"双击后黑屏，无法回退"）：
 *   ① 渲染进程崩溃（DSH SPA 重 + 手机内存紧）：默认 `onRenderProcessGone` 要么带走
 *      整个应用进程、要么留一块**永久的黑屏**（WebView 死了，goBack 也是空转）。
 *      → `ShareSeen.onRenderProcessGone` 收尸并回调这里：重建 WebView、重载最后
 *      地址（优雅恢复）；没有可恢复的地址就直接 finish 回主界面。
 *   ② 双击任务卡会叠两个 Activity：新开的这页背后那页隧道已被新会话接管，回头
 *      看到的就是"黑屏死页"（要按两次返回）。→ 单例护栏 `active`：新实例把旧
 *      实例 finish 掉，返回栈里永远只有活的这一页。
 *   ③ 双击/捏合缩放一律关（`setSupportZoom(false)`）：缩放视口重排是渲染进程
 *      OOM 的常见诱因；分享页是"看任务"，不需要缩放。
 *   ④ `onDestroy` 原来把 parent 硬转 `FrameLayout`（实际是 LinearLayout，必抛
 *      ClassCastException）→ `web.destroy()` 从没执行过，**每个开关周期漏一个
 *      WebView 连同渲染进程**，内存压力越攒越大，正是二次打开崩的温床。
 */
public class ShareWebActivity extends Activity {
    /** 当前活着的分享页（单例护栏）：onCreate 里收掉旧的，onDestroy 里清引用。 */
    private static ShareWebActivity active;

    private WebView web;
    private TextView bar;
    private LinearLayout root;
    /** 传进来的入口地址（带 ?mt=，崩溃恢复的兜底）。 */
    private String url0 = "";
    /** 最后一次成功开始加载的地址（崩溃恢复优先用——比入口更接近用户看到的状态）。 */
    private String lastUrl = "";
    /** 渲染进程挂过（goBack 不再信 canGoBack——死 WebView 上它不可靠）。 */
    private boolean crashed;
    /** 崩溃重建次数（超过 2 次不再硬撑——内存真不够时死循环重建只会更糟）。 */
    private int rebuilds;
    /** 页面首次加载完成时刻（回前台探针的"刚打开保护"：8s 内不判死）。 */
    long pageShownAt = 0;
    /** 连续"网络层已死"次数：1 次只安排复探，连续 2 次才退出（防瞬态误判）。 */
    private int deadProbes = 0;
    /** 系统网络回调（WiFi↔蜂窝切换即时通知页面重载；见 ShareNetCb 注释）。 */
    private ShareNetCb netCb;
    /** 网络变化防抖（系统回调会成串来）。 */
    private long lastNetChangeAt = 0;
    /** 2026-10-31 vnet 根治 P1：被节流吞掉的中间态复查（保证真实状态不依赖下一次系统回调）。 */
    private final android.os.Handler netHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean netRecheckPosted = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // 2026-10-11：本页窗口**首次**获得焦点时不弹输入法（与 manifest 同名属性同义，
        // 这里再写一次=不依赖 XML 被改）。页内切会话的自动聚焦由 ShareFocusGuard 拦。
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
            | android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        // 单例护栏：把还活着的旧实例收掉（返回栈里不再有"隧道已断"的死页）
        ShareWebActivity prev = active;
        active = this;
        if (prev != null && prev != this && !prev.isFinishing()) prev.finish();

        String url = getIntent() == null ? "" : String.valueOf(getIntent().getStringExtra("url"));
        String title = getIntent() == null ? "任务" : String.valueOf(getIntent().getStringExtra("title"));
        if (url != null && url.startsWith("http")) url0 = url;

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // 极简标题栏（返回 + 标题 + 连接状态），不给分享页加壳功能，只给"回得去"
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setBackgroundColor(0xFF191D29);
        head.setPadding(dp(10), dp(8), dp(10), dp(8));

        TextView back = new TextView(this);
        back.setText("‹ 返回");
        back.setTextColor(0xFFE8ECF5);
        back.setTextSize(15);
        back.setPadding(dp(6), dp(6), dp(14), dp(6));
        back.setOnClickListener(new ShareBackClick(this));
        head.addView(back);

        bar = new TextView(this);
        bar.setText(title);
        bar.setTextColor(0xFFE8ECF5);
        bar.setTextSize(15);
        bar.setSingleLine(true);
        bar.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.setLayoutParams(lp);
        head.addView(bar);

        root.addView(head, new LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));

        web = buildWeb();
        root.addView(web, new LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        // 2026-10-18：系统网络变化直通（WiFi↔蜂窝切换即时通知页面；见 onNetChanged）
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                netCb = new ShareNetCb(this);
                cm.registerNetworkCallback(new android.net.NetworkRequest.Builder().build(), netCb);
            }
        } catch (Exception ignored) { }
        // 2026-11-12 设备域干净 URL：`http://<设备别名>.localhost:<口>/<分享别名>/`
        // ——*.localhost 恒解析回环（本机隧道口），Host 只用于网关路由；与 mt//gw/
        // 同一安全面（都是"只能打到自己机器的隧道口"），放行。
        boolean deviceOrigin = false;
        try {
            java.net.URL u = new java.net.URL(url0);
            deviceOrigin = u.getProtocol().equals("http")
                && u.getHost() != null && u.getHost().endsWith(".localhost");
        } catch (Exception ignored) { }
        if (url0.startsWith("http://") && (url0.contains("mt=") || url0.contains("/gw/") || deviceOrigin)) {
            // 带 mt（入门票）或 /gw/（网关路径）或设备域别名（.localhost）的 http URL 放行：
            // 覆盖 localhost 代理、LAN 直连、中继服务器三种场景。
            // 其它任意 URL 仍然拒绝（防被塞浏览器用）。
            web.loadUrl(url0);
        } else {
            bar.setText("打不开这个任务（地址不合法）");
        }
    }

    /** 系统网络变化（ShareNetCb 回调）：**binder 线程**——只做防抖与投递，WebView 操作
     *  必须 post 到 UI 线程（直接调 evaluateJavascript 会抛 "All WebView methods must be
     *  called on the same thread"，被吞掉后页面永远收不到通知；真机实测踩到）。
     *
     *  2026-10-31：入参只有 NetGate 判定为"真拓扑变化"的事件才会走到这里
     *  （capabilities 抖动/同网络重复回调已被闸门丢弃，见 ShareNetCb/NetGate）。 */
    void onNetChanged(NetGate.Kind kind) {
        if (netCb == null) return;
        long now = System.currentTimeMillis();
        GwLog.note(null, "share-net 页面重载原因=" + kind + " 打开时长=" + (pageShownAt == 0 ? 0 : now - pageShownAt) + "ms");
        if (pageShownAt == 0 || now - pageShownAt < 5000) return;
        if (now - lastNetChangeAt < 2000) return;
        lastNetChangeAt = now;
        final android.webkit.WebView w = web;
        if (w == null) return;
        try { w.post(new ShareNetNotify(this)); } catch (Exception ignored) { }
    }

    /** 节流吞掉中间态后的复查（UI 线程 1.2s 后回读真实网络状态）。 */
    void scheduleNetRecheck() {
        if (netRecheckPosted) return;
        netRecheckPosted = true;
        try {
            netHandler.postDelayed(new Runnable() {
                @Override public void run() {
                    netRecheckPosted = false;
                    ShareNetCb cb = netCb;
                    if (cb != null) cb.recheck();
                }
            }, 1200);
        } catch (Throwable t) {
            netRecheckPosted = false;
        }
    }

    /** UI 线程执行：先探页面是否装了新 handler（日志留证），再通知页面 1.2s 后重载
     *  （让 dsh-open 先重连好隧道，再用新隧道口加载）。真机实测：只靠页面自探要 30s+
     *  （旧隧道口请求每次挂 ~10s 才超时）；原生回调即时。 */
    void applyNetReload() {
        try {
            if (web == null) return;
            web.evaluateJavascript("String(typeof window.__mycoNetChanged)", new ShareNetProbe(this));
        } catch (Exception ignored) { }
    }

    /** UI 线程执行（ShareNetProbe 回调里）：真正发出通知。 */
    void applyNetReload2() {
        try {
            GwLog.note(null, "share-page 系统网络变化 → 通知页面 1.2s 后重载（走新隧道口）");
            if (web != null) web.evaluateJavascript("window.__mycoNetChanged&&window.__mycoNetChanged(1200)", null);
        } catch (Exception ignored) { }
    }

    /** 从 URL / Content-Disposition 猜文件名（下载用，简单解析避免正则转义坑）。 */
    private static String guessFileName(String url, String cd) {
        String name = "";
        try {
            if (cd != null) {
                int i = cd.toLowerCase().indexOf("filename=");
                if (i >= 0) {
                    String rest = cd.substring(i + 9).trim();
                    if (rest.startsWith("\"")) {
                        int j = rest.indexOf('"', 1);
                        if (j > 1) name = rest.substring(1, j);
                    } else {
                        int j = rest.indexOf(';');
                        name = (j >= 0 ? rest.substring(0, j) : rest).trim();
                    }
                }
            }
            if (name.isEmpty() && url != null) {
                String p = url;
                int q = p.indexOf('?');
                if (q >= 0) p = p.substring(0, q);
                int i = p.lastIndexOf('/');
                if (i >= 0 && i + 1 < p.length()) name = p.substring(i + 1);
            }
        } catch (Exception ignored) { }
        if (name == null || name.isEmpty()) name = "download.bin";
        return name;
    }


    /** 造一个配置好的 WebView（onCreate 与崩溃恢复共用同一套配置，防止配置漂移）。 */
    private WebView buildWeb() {
        WebView w = new WebView(this);
        // 2026-10-20 设备侧 R 指标取数：dev 包开 WebView DevTools（见 DevFlags）
        try { if (DevFlags.WEBVIEW_DEBUG) WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable ignored) { }
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 双击/捏合缩放一律关（真机黑屏排查项之一）：DSH SPA 重，缩放触发的视口
        // 重排是渲染进程 OOM 的常见诱因；分享页只读不缩放。
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 2026-11-12 白屏终修（真机实锤）：分享页全部走本机隧道 127.0.0.1:<port>，
        // 端口每次重建都可能变（25910 起顺序分配）。Chromium 按 URL 缓存响应——
        // 旧隧道口死掉时的 404/黑洞响应被缓存后，隧道恢复同一 URL 也拿缓存错误，
        // 模块加载（/myco-assets/plugins/??…&rev=…）连环失败、页面退化成 46 条
        // 错误清单且刷新无效（系统浏览器独立缓存=正常，对照实证）。
        // 分享页是隧道动态面，缓存是纯负担 → 一律不缓存。
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // 2026-10-12：控制台留证（白屏现场第一手日志落 gw-net.log；不带媒体授权）
        w.setWebChromeClient(new ShareChrome(this));
        w.setWebViewClient(new ShareSeen(this));
        // 2026-10-22 myco 自更新通道：下载监听（APK 下完弹安装）。独立类避开 d8 匿名类 NPE。
        w.setDownloadListener(new ShareDownloader(this));
        return w;
    }

    /** 主框架网络错误恢复计数（2026-10-21 O06：后台恢复后 WebView 裸错误页）。 */
    private int mainFrameErrs = 0;
    private long lastMainFrameErrAt = 0;

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    /** ShareSeen.onPageStarted 回调：记下最后地址（崩溃恢复用）。 */
    void noteUrl(String u) {
        if (u != null && u.startsWith("http")) lastUrl = u;
    }

    /**
     * 渲染进程挂了（`ShareSeen.onRenderProcessGone` 回调，API 26+ 才会触发）：
     * 不黑屏——重建 WebView 并重载最后地址；没有可恢复的地址（还没加载成功过）
     * 或 Activity 已在收尾，就 finish 回主界面。**返回 true 语义**：我们自己处理，
     * 系统不必带走整个应用进程。
     */
    void onRendererGone() {
        crashed = true;
        if (rebuilds >= 2) {
            // 反复崩（内存真不够）：不再硬撑，回主界面——返回键永远能退出
            finish();
            return;
        }
        rebuilds++;
        String u = lastUrl.length() > 0 ? lastUrl : url0;
        LinearLayout r = root;
        if (r == null || u.length() == 0 || isFinishing()) {
            finish();
            return;
        }
        // View.post 自身线程安全（内部转 UI 线程），承 TunnelJs 的纪律；
        // 状态文案也放进 Runnable 里写（回调线程不敢直接碰 View）。
        r.post(new ShareWebRebuild(this, u));
    }

    /** 在 UI 线程上把死 WebView 换成新的并重载（`ShareWebRebuild` 的执行体）。 */
    void rebuildWeb(String u) {
        if (isFinishing()) return;
        try {
            if (web != null) {
                android.view.ViewParent p = web.getParent();
                if (p instanceof ViewGroup) ((ViewGroup) p).removeView(web);
                web.destroy();
            }
        } catch (Exception ignored) { }
        web = buildWeb();
        crashed = false;
        if (root != null) {
            root.addView(web, new LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            web.loadUrl(u);
            setStatus("加载中…");
        } else {
            finish();
        }
    }

    void goBack() {
        // 渲染进程挂过且还没恢复完：死页不恋战，直接回主界面（返回键永远有效）
        if (crashed || web == null) {
            finish();
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        // 2026-10-20（用户追加指标「返回再开 <1s」）：返回列表时**保留本页**（WebView 与隧道
        // 都活着），主界面再点同一张卡可直接复用 → 秒开。真正销毁发生在：切换到别的卡
        // （onCreate 单例护栏）、渲染崩溃重试超限、进程被系统回收。
        try {
            android.content.Intent i = new android.content.Intent(this, MainActivity.class);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        } catch (Throwable t) {
            finish();
        }
    }

    /** 供顶层 Runnable 触发的 reload（web 是 private，顶层类不能直接访问）。 */
    void reloadWebNow() {
        try {
            if (web != null && !isFinishing()) web.reload();
        } catch (Throwable ignored) { }
    }

    /** 主框架网络错误（ERR_EMPTY_RESPONSE/连接断开…）：
     *  第 1 次 → 提示 + 稍后 reload 恢复；短时间内第 2 次 → Toast + finish 回列表
     *  （下次点卡是全新打开，会重建隧道）。**不让用户看到 WebView 的裸错误页。**
     *  2026-10-21 真案（O06）：myco 后台 90s 后再点全权卡 → 页面 URL 指向旧隧道口
     *  ERR_EMPTY_RESPONSE，用户看到「网页无法打开」。 */
    void onMainFrameError(String desc) {
        long now = System.currentTimeMillis();
        if (pageShownAt > 0 && now - pageShownAt < 8000) {
            GwLog.note(null, "share-page 主框架错误但页面刚加载（宽限）: " + desc);
            return;
        }
        if (now - lastMainFrameErrAt > 8000) mainFrameErrs = 0;
        lastMainFrameErrAt = now;
        mainFrameErrs++;
        GwLog.note(null, "share-page 主框架错误（第 " + mainFrameErrs + " 次）: " + desc);
        setStatus("连接已断开，正在重试…");
        if (mainFrameErrs == 1) {
            try { web.postDelayed(new ShareRecoverReload(this), 1200); } catch (Throwable ignored) { }
            return;
        }
        try {
            android.widget.Toast.makeText(this, "连接已断开，请重新点开这个任务", android.widget.Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) { }
        finish();
    }

    /** 从页面 URL 抠本地端口（`http://127.0.0.1:45859/gw/...` → 45859）。 */
    static int portOfUrl(String u) {
        if (u == null) return 0;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("127\\.0\\.0\\.1:(\\d{2,5})/").matcher(u);
        if (m.find()) {
            try { return Integer.parseInt(m.group(1)); } catch (Throwable ignored) { }
        }
        return 0;
    }

    /** 本地端口是否可连（250ms 超时；任何异常都算死）。 */
    static boolean localPortAlive(int port) {
        java.net.Socket s = null;
        try {
            s = new java.net.Socket();
            s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 250);
            return true;
        } catch (Throwable ignored) {
            return false;
        } finally {
            if (s != null) { try { s.close(); } catch (Throwable ignored) { } }
        }
    }

    /** 关闭当前活着的分享页（R10 计量清场用；与"返回保活"不同，这是真关闭）。 */
    static void closeActive() {
        ShareWebActivity cur = active;
        if (cur != null && !cur.isFinishing()) {
            try {
                cur.finish();
            } catch (Throwable ignored) { }
        }
    }

    /** 从 URL 抠分享 id（`/gw/sh-xxxx/…`）。 */
    static String shareIdOf(String u) {
        if (u == null) return "";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("/gw/(sh-[0-9a-f]+)").matcher(u);
        return m.find() ? m.group(1) : "";
    }

    /** 复用当前活着的分享页（同 shareId）。2026-10-21：返回可诊断原因（NOACT/MISMATCH:<id>/ERR）。 */
    public static String reuseForIdDiag(String shareId) {
        ShareWebActivity cur = active;
        if (cur == null || cur.isFinishing()) return "NOACT";
        if (shareId == null || shareId.isEmpty()) return "NOID";
        String curUrl = cur.url0.length() > 0 ? cur.url0 : cur.lastUrl;
        String curId = shareIdOf(curUrl);
        if (!shareId.equals(curId)) return "MISMATCH:" + curId;
        // 2026-10-21（O06 修复）：页面保活不等于数据面活着——复用前先探页面指向的
        // 本地隧道口；口子死了就销毁页面（避免复用后看到 ERR_EMPTY_RESPONSE 裸错误页），
        // 返回 STALE，让 JS 走完整"新开"链路重建隧道。
        int pagePort = portOfUrl(curUrl);
        if (pagePort > 0 && !localPortAlive(pagePort)) {
            GwLog.note(null, "复用被拒：页面隧道口 " + pagePort + " 已死 → STALE（走新开）");
            try { cur.finish(); } catch (Throwable ignored) { }
            return "STALE";
        }
        try {
            android.content.Intent i = new android.content.Intent(cur, ShareWebActivity.class);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
            cur.startActivity(i);
            return "OK";
        } catch (Throwable t) {
            return "ERR:" + t.getClass().getSimpleName();
        }
    }

    public static boolean reuseForId(String shareId) {
        return "OK".equals(reuseForIdDiag(shareId));
    }

    /** 复用当前活着的分享页（同 shareId）：把它带到前台，不重建、不重取票。 */
    public static boolean reuseForIdOld(String shareId) {
        ShareWebActivity cur = active;
        if (cur == null || cur.isFinishing() || shareId == null || shareId.isEmpty()) return false;
        String curUrl = cur.url0.length() > 0 ? cur.url0 : cur.lastUrl;
        if (!shareId.equals(shareIdOf(curUrl))) return false;
        try {
            android.content.Intent i = new android.content.Intent(cur, ShareWebActivity.class);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
            cur.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    protected void onNewIntent(android.content.Intent it) {
        super.onNewIntent(it);
        setIntent(it); // SINGLE_TOP 复用：不再 onCreate，页面保持原样
    }

    void setStatus(String s) {
        if (bar != null && s != null && !s.isEmpty()) bar.setText(s);
    }

    String pageTitle() {
        try { return web == null ? "" : String.valueOf(web.getTitle()); } catch (Exception e) { return ""; }
    }

    String pageUrl() {
        try { return web == null ? "" : String.valueOf(web.getUrl()); } catch (Exception e) { return ""; }
    }

    @Override
    public void onBackPressed() {
        goBack();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 后台时冻结这一页的排版/解析（省电省内存）。注意**不能**用
        // WebView.pauseTimers()——那是全局的，会把主界面里跑隧道的 JS 一起冻死。
        if (web != null) { try { web.onPause(); } catch (Exception ignored) { } }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) { try { web.onResume(); } catch (Exception ignored) { } }
        // 2026-10-12 切会话/回前台自愈（用户报："切会话很容易断连，DSH 页显示重新
        // 连接，又连不上"）：onPause 期间这一页的 JS 被冻结，DSH 页面自身的 WS
        // 重试上限很快用尽 → 回来时停在死状态、不再自愈。这里主动探一次数据面
        //（与注入心跳同口径），不通就整页 reload——隧道本地口已持久化
        //（TunnelProxyServer 的 tunnel-port.txt），reload 即恢复。
        probeAndMaybeReload();
        if (Build.VERSION.SDK_INT >= 30) {
            // 分享页是全屏工作区：隐藏状态栏图标会更清爽，但不强制（避免影响返回手势）
        }
    }

    /** 回前台探活的节流（毫秒）：来回切会话不反复整页重载。 */
    private long lastResumeProbeAt = 0;

    /** 探针：三态且**区分"网络层死"与"上游 401/503 瞬态"**（2026-10-18 真机回归：
     *  页面刚打开 1.5s 就判死直接退出——实际 2s 后就连上了；401 忙窗里 HEAD 也会失败）。
     *    '1' HEAD 当前页 2xx（数据面正常，什么都不做）
     *    '2' 拿到 HTTP 响应但非 2xx / 或网关 ping 有响应（瞬态，reload 有意义）
     *    '0' **网络层**两个探针都抛异常（隧道端口真死）——还要"连续两次"才退出 */
    private static final String PROBE_JS =
        "(function(){try{window.__mycoProbe='';"
        + "var p=location.pathname||'/';"
        + "var m=p.match(/^\\/gw\\/[^\\/?#]+\\//);"
        + "var pre=m?m[0]:'/';"
        + "var ping=function(cb){fetch(location.origin+pre+'ping?h='+Date.now(),{cache:'no-store'})"
        + ".then(function(){cb('2')}).catch(function(){cb('0')});};"
        + "fetch(location.origin+p+'?_='+Date.now(),{method:'HEAD',cache:'no-store'})"
        + ".then(function(r){if(r.ok){window.__mycoProbe='1';}else{ping(function(v){window.__mycoProbe=v;})}})"
        + ".catch(function(){ping(function(v){window.__mycoProbe=v;})});"
        + "return 'go'}catch(e){window.__mycoProbe='2';return 'go'}})()";

    /** 读回探针结果（与探针同一个调用批）。 */
    private static final String READ_JS = "String(window.__mycoProbe||'')";

    private void probeAndMaybeReload() {
        if (web == null || url0.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (now - lastResumeProbeAt < 4000) return;
        lastResumeProbeAt = now;
        final android.webkit.WebView w = web;
        try {
            w.evaluateJavascript(PROBE_JS, null);
            w.postDelayed(new ShareProbeRead(this), 1500);
        } catch (Exception ignored) { }
    }

    /** 读回探针结果（ShareProbeRead 顶层类延时调用）。 */
    void readProbe() {
        if (web == null) return;
        try {
            web.evaluateJavascript(READ_JS, new ShareProbeCallback(this));
        } catch (Exception ignored) { }
    }

    /** 复探一次（ShareProbeRetry 顶层类延时调用；绕过 4s 节流）。 */
    void retryProbeOnce() {
        lastResumeProbeAt = 0;
        probeAndMaybeReload();
    }

    /** 探针读回后的动作（包级可见——ShareProbeCallback 顶层类回调用）。 */
    void onProbeValue(String value) {
        // evaluateJavascript 回的是 JSON 字面量（如 "\"0\""）
        if (value == null || web == null) return;
        String v = value.replace("\"", "").trim();
        if ("1".equals(v) || v.isEmpty()) { deadProbes = 0; return; }   // 数据面正常
        if ("2".equals(v)) {
            // 瞬态（上游 401/503 忙窗、或页面在加载中）：保留页面，reload 同 origin 有意义
            deadProbes = 0;
            GwLog.note(null, "share-page 回前台探活：瞬态失败 → reload 恢复");
            try { web.reload(); } catch (Exception ignored) { }
            return;
        }
        // '0' 网络层失败：先给页面加载宽限，再要求**连续两次**才判定通道真死
        long age = pageShownAt == 0 ? 0 : (System.currentTimeMillis() - pageShownAt);
        if (pageShownAt == 0 || age < 8000) {
            GwLog.note(null, "share-page 回前台探活：网络层失败但页面刚加载（age=" + age + "ms）→ 不判死");
            return;
        }
        deadProbes++;
        if (deadProbes < 2) {
            GwLog.note(null, "share-page 回前台探活：网络层失败（第 1 次）→ 2s 后复探");
            try { web.postDelayed(new ShareProbeRetry(this), 2000); } catch (Exception ignored) { }
            return;
        }
        GwLog.note(null, "share-page 回前台探活失败（连续两次网络层失败）→ 回主界面重开分享");
        try {
            android.widget.Toast.makeText(this, "连接已断开，请重新点开这个任务", android.widget.Toast.LENGTH_LONG).show();
        } catch (Exception ignored) { }
        try { finish(); } catch (Exception ignored) { }
    }

    @Override
    protected void onDestroy() {
        // 页面走了 → 主界面的隧道客户端会收到本地连接关闭并自行收敛；
        // 这里只释放 WebView（不 stop 隧道：主界面可能还在用别的连接）。
        if (active == this) active = null;
        if (netCb != null) {
            try {
                android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(netCb);
            } catch (Exception ignored) { }
            netCb = null;
        }
        if (web != null) {
            try {
                // 修复（2026-10-09）：原来硬转 FrameLayout 必抛 ClassCastException
                // → destroy() 从没执行过 → 每个开关周期漏一个 WebView + 渲染进程。
                android.view.ViewParent p = web.getParent();
                if (p instanceof ViewGroup) ((ViewGroup) p).removeView(web);
                web.destroy();
            } catch (Exception ignored) { }
            web = null;
        }
        super.onDestroy();
    }
}

/** 主框架错误后的延迟 reload（顶层 Runnable——d8 8.2.2-dev 对匿名/内嵌类 NPE 纪律）。 */
final class ShareRecoverReload implements Runnable {
    private final ShareWebActivity act;
    ShareRecoverReload(ShareWebActivity a) { this.act = a; }
    @Override public void run() {
        act.reloadWebNow();
    }
}

/**
 * 崩溃恢复的重建动作（顶层 Runnable——d8 8.2.2-dev 对匿名/内嵌类 NPE，承
 * `TunnelJs`/`ShareBackClick` 的既有纪律）。
 */
class ShareWebRebuild implements Runnable {
    private final ShareWebActivity act;
    private final String url;
    ShareWebRebuild(ShareWebActivity a, String u) { this.act = a; this.url = u; }
    @Override public void run() {
        act.setStatus("页面崩了，正在恢复…");
        act.rebuildWeb(url);
    }

}
