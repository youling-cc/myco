package com.myco.phone;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Myco 手机 APK:WebView 壳(design/04-agent/fleet-division-and-node-federation.md §3)。
 * 与 PWA 同一 URL 同一身份(localStorage 隔离=独立 agent,origin 标签"手机")。
 * 返航键=网页后退,沉浸全屏。
 *
 * 2026-09-03 常驻长连接+自更新:
 *  - MycoShell JS bridge:isApk()/keepAlive()(前台服务保进程——WebView 的 SSE/
 *    WebRTC/presence 心跳退后台不断,与 PC/笔记本同形态)+ downloadApkUpdate()
 *    (DownloadManager 拉 latest.json 指定的新 APK → 装好即触发安装意图;
 *    APK 自更新走 myco 自己的发布通道,不经应用商店)。
 *  - identity/签名全在 WebView 的 PWA 里——原生层不持密钥(二期 Keystore 再议)。
 */
public class MainActivity extends Activity {
    // 离线壳(2026-09-05):前端资产打进 APK assets——断云也能开 app(云只做 API/信令,
    // identity.ts 的 DID_BASE 在非同源时自动走绝对地址,已兼容)。云 PWA 仍在 8321 热更。
    private static final String URL = "file:///android_asset/www/index.html";
    WebView web;  // package-private: MycoShell 自截屏要画它
    volatile String lastUrl = "", lastTitle = "";  // EnvServer 直读(PageSeen 维护)
    // 2026-10-15：进程级引用——KeepAliveService 的隧道 tick 从这里拿 WebView 注 JS
    // （单 activity app，随进程存亡；真机实测：主 WebView 被 DSH 页盖住后 Chromium
    // 限流隐藏页定时器 → 隧道重拨停摆，后台探隧道口 0 字节，回前台 0.54s 复活）。
    static volatile WebView sWeb;
    /** 2026-10-20 B1：AlarmManager 唤醒后，JS 桥回执置 true（证明 WebView JS 真跑起来了）。 */
    static volatile boolean sAlarmWakeAck = false;
    /**
     * 2026-10-26：本进程启动时的 package versionCode。
     * 自更新装完 APK 后，Android 不一定杀掉旧进程——旧 WebView/旧 Java 服务继续跑，
     * 表现为「版本号已经 177，但 DSH/RDP 全断」，force-stop 后才恢复。
     * onCreate 首次记录，onResume 对比；包已换而本进程没换 → 主动结束旧进程。
     */
    private static volatile long sProcessVersionCode = -1;
    /** DSH 应用内浏览器的固定 origin（手机本地 23911 口）。 */
    private static final String DSH_LOCAL_ORIGIN = "http://127.0.0.1:23911";
    /** 跨版本首启清理 DSH 缓存的持久版本记录。 */
    private static final String PREFS_APP = "myco_app";
    private static final String KEY_LAST_VERSION_CODE = "last_version_code";
    /** 2026-10-31 状态契约：记录上次版本名（"0.3.194"），用于判定"只有补丁位变了"。
     *  补丁位更新不再清 DSH origin——那次清理会顺手删掉 DSH SPA 的会话指针
     *  （dsh.sessions.current），冷启动就落「选择工作区」空态（手机黑屏真案）。 */
    private static final String KEY_LAST_VERSION_NAME = "last_version_name";

    /** 版本的主.次段（"0.3.194"→"0.3"；解析失败返回原串）。 */
    private static String minorPart(String v) {
        if (v == null) return "";
        int a = v.indexOf('.');
        int b = a >= 0 ? v.indexOf('.', a + 1) : -1;
        return b > a ? v.substring(0, b) : v;
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {

        // 2026-10-28 深链接登录（DL-Auth）：检查启动 Intent 是否是 myco://auth
        handleDeepLink(getIntent());

        // 2026-10-24：亮屏/解锁主动恢复（Honor 息屏冻结 WebView/进程；d8 不吃匿名类，用顶层 ScreenOnReceiver）
        try {
            screenOnReceiver = new ScreenOnReceiver(this);
            IntentFilter sf = new IntentFilter();
            sf.addAction(Intent.ACTION_SCREEN_ON);
            sf.addAction(Intent.ACTION_USER_PRESENT);
            registerReceiver(screenOnReceiver, sf);
        } catch (Throwable ignored) { }
        super.onCreate(b);
        // 记录本进程启动时的版本（只首次赋值：同一个旧进程即使 Activity 重建，也不会把新包版号写进来）
        if (sProcessVersionCode < 0) {
            try { sProcessVersionCode = currentVersionCode(); } catch (Throwable ignored) { }
        }
        // 2026-10-11 UX：不自动弹输入法——切会话/开页面时 WebView 自动聚焦
        // 第一个 input 导致键盘弹出，但用户先看内容。此标志只在窗口首次获得
        // 焦点时隐藏键盘，用户点输入框后正常弹出（微信/Telegram 同款）。
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
        web = new WebView(this);
        try { web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false); } catch (Throwable ignored) { }  // 2026-10-20 B 保活：后台时渲染进程仍 IMPORTANT
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true); // assets 离线壳需要(API30+ 默认 false)
        // file:// 下 ES module(vite 产物)默认被 CORS 拦(origin null)——放开本 file 域,
        // 云 API 是 http fetch 跨 origin,服务器 CORS 已放 *,与此开关无关。
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        web.setWebViewClient(new PageSeen(this));
        // WebView getUserMedia（扫码摄像头）必需：无 WebChromeClient 时 onPermissionRequest
        // 无人应答，页面拿到的就是 NotAllowedError: Permission denied（2026-09-19 真机实测）。
        // file:// 属 Chromium 判定的可信来源，grant 后摄像头可用；回调本身在 UI 线程，直接 grant。
        // 2026-10-12 换 ShellChrome（extends PermChrome）：权限/文件选择器原样保留，
        // 另接 console → gw-net.log（[dsh-open] 重试/自愈轨迹从此真机可读）。
        // 麦克风（2026-10-16 设计定稿移除）：原此处首启无条件申请 RECORD_AUDIO（为
        // "语音输入/录音"预留）——但该功能未上线，新用户首启被麦克风弹窗搞懵。
        // 语音功能真上线时再回来：manifest 声明 + **用时**按需申请（不要首启骚扰）。
        web.setWebChromeClient(new ShellChrome(this));
        // 2026-10-23（手机 DSH 分享入口打不开的修）：壳是 file:// 上下文，导航到
        // http://127.0.0.1:<端口>/gw/<shareId>/?mt=… 时 WebView 会把该 302 的
        // Set-Cookie 当第三方 cookie 丢掉，随后 /app/ 直接报
        // "no valid share cookie (open the share entry first)"（真机实测）。
        // 放开 cookie + 第三方 cookie 后，应用内 WebView 才能承载分享页。
        try {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(web, true);
        } catch (Throwable ignored) { }
        // WebView getUserMedia 还要求进程持有 CAMERA 运行时权限（manifest 声明不够）——首启请求一次。
        if (checkSelfPermission(android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, 47001);
        }
        // 批四：聊天系统通知（MycoShell.notifyChat）需要 Android 13+ 运行时通知权限——
        // manifest 已声明 POST_NOTIFICATIONS（KeepAliveService 前台服务），这里补运行时申请。
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 47002);
        }
        web.addJavascriptInterface(new MycoShell(this), "MycoShell");
        // 2026-10-29 DL-Auth：深链接 PULL 桥（JS 轮询拉取，不依赖 evaluateJavascript 推送）
        web.addJavascriptInterface(new DeepLinkBridge(), "MycoDeepLinkBridge");
        // vnet 固定口监听的 JS 回执通道（与分享页 __mycoTunnel 分开命名空间）
        ForwardListener.setSink(new ForwardCallbacks(web));
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        web.loadUrl(URL);
        setContentView(web);
        sWeb = web;
        // 自截屏循环启动:普通 java.lang.Thread 每 3s 跑一次 SnapTask(诊断期常驻;
        // 纯 Java 线程不进 UI,web.draw 在 UI 线程安全——WebView 线程检查只在画内部)。
        new Thread(new SnapTask(this, web), "myco-selfsnap").setDaemon(true);
        // 常驻长连接:进程提到前台优先级(WebView JS/SSE 退后台继续跑)
        startKeepAlive();
        // 2026-10-26：Honor/Huawei 新装机环境闸门——引导用户开启
        // 自启动/关联启动/后台活动（厂商私有开关，App 只能引导）
        StartupEnvGate.showIfNeeded(this);
        // 诊断:启动 4s 后自截屏(顶层类 SnapTask+SelfSnap,不嵌套——R8 对内嵌类炸)
        new android.os.Handler().postDelayed(new SnapTask(this, web), 4000);
        snapCam = new SnapCam(this, "MycoShell");
        sSnapCam = snapCam;
    }

    private SnapCam snapCam;
    private static volatile SnapCam sSnapCam;  // 取景页后台线程直投用(进程级)

    /** 取景页 ScanProcess 结果直投入口(不依赖 activity 回传,消竞态)。 */
    static SnapCam snapRef() { return sSnapCam; }

    /** 相机直拍回执:SnapCam 收图经 JS bridge 喂 PWA(不走系统文件选择器——
     *  Android 13+ WebView <input capture> 在部分机器上点不弹)。 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // 2026-09-29：HTML input[type=file] 选择结果（PermChrome.onShowFileChooser
        // 开出的系统选择器）——不路由回去 input 永远收不到 change 事件。
        if (requestCode == PermChrome.REQ_FILE_CHOOSER) {
            PermChrome.onFileChooserResult(resultCode, data);
            return;
        }
        if (snapCam != null) snapCam.onResult(requestCode, resultCode, data);
    }

    /** 相机直拍入口(MycoShell 桥转发;包可见,避开桥内部类直接摸 snapCam 字段)。 */
    String snapCamCapture() { return snapCam != null ? snapCam.capture() : "ERR: snapCam null"; }

    /** 图库选图入口(桥转发,同 snapCamCapture 模式)。 */
    String snapCamPick() { return snapCam != null ? snapCam.pick() : "ERR: snapCam null"; }

    private void startKeepAlive() {
        Intent i = new Intent(this, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
        // 环境交互面(2026-09-04 aop 思路):状态可感知+可执行,调试不再改代码重装
        new EnvServer(this).start();
    }

    /** 保活状态快照(EnvServer /api/state 用;不用导入服务类)。 */
    String keepAliveState() {
        return "started";
    }

    /** 版本号(EnvServer /api/state 用;不依赖 MycoShell 类可见性)。 */
    String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) { return ""; }
    }

    /** 当前安装包的 versionCode（自更新进程守卫用）。 */
    private long currentVersionCode() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Throwable e) {
            return -1;
        }
    }

    /**
     * 跨版本首启清理 DSH 应用内浏览器缓存（2026-10-31 状态契约改造：管理操作 = 带条件的状态转移）。
     *
     * 为什么不能只放在 killLegacyProcessAfterPackageUpdate：
     * 正常更新后系统会给出**新进程**，进程版本 == 安装版本，旧进程守卫不会触发；
     * 但 InAppBrowser 的 localStorage 仍从旧版本留在盘上，DSH 会把旧会话标题缓存
     * 显示成大量“未命名”。所以用持久化的版本记录判断。
     *
     * 2026-10-31 修正（手机黑屏真案）：旧逻辑「任何 versionCode 变化都清 origin」
     * 是一次**没有转移设计的越权删除**——它顺手删掉了 DSH SPA 拥有的
     * dsh.sessions.current 会话指针，冷启动落「选择工作区」空态（用户看到黑屏），
     * 且没有任何角色负责重建。现在：**只有主.次版本（0.x）变更才清**（防旧缓存
     * 污染的原始目的仍保留）；补丁位更新（0.3.194→0.3.195）保留本地状态。
     * 指针万一仍丢失（清仓/竞态），由网关 bootstrap 的「最近活跃会话」种子兜底
     * （dsh_share.rs 的 MOST_RECENT_SESSION）——删除方不再独自承担恢复。
     */
    private void resetInAppBrowserCacheOnVersionChange() {
        final long current = currentVersionCode();
        final String curName = versionName() == null ? "" : versionName();
        if (current <= 0) return;
        try {
            android.content.SharedPreferences p = getSharedPreferences(PREFS_APP, MODE_PRIVATE);
            final long last = p.getLong(KEY_LAST_VERSION_CODE, 0L);
            final String lastName = p.getString(KEY_LAST_VERSION_NAME, "");
            if (last == current && curName.equals(lastName)) return;
            if (last != 0L) {
                boolean minorChanged = !minorPart(lastName).equals(minorPart(curName));
                if (minorChanged) {
                    android.webkit.WebStorage.getInstance().deleteOrigin(DSH_LOCAL_ORIGIN);
                    GwLog.note(this, "app-update 主/次版本变更 " + lastName + "→" + curName
                            + "，已清理 DSH 缓存 origin=" + DSH_LOCAL_ORIGIN
                            + "（指针由网关种子兜底）");
                } else {
                    GwLog.note(this, "app-update 仅补丁位更新 " + lastName + "→" + curName
                            + "，保留 DSH 本地状态（含会话指针 dsh.sessions.current）");
                }
            } else if (packageWasUpdatedInPlace()) {
                // 2026-10-26：旧版本（<=0.3.178）没有 last_version_code 记录。
                // 用 lastUpdateTime != firstInstallTime 识别“覆盖安装/升级”，
                // 首次跑到本方法时补清一次，避免升级用户继续吃旧 DSH 标题缓存。
                android.webkit.WebStorage.getInstance().deleteOrigin(DSH_LOCAL_ORIGIN);
                GwLog.note(this, "app-update 首次记录版本 " + current
                        + "（覆盖安装），已清理 DSH 缓存 origin=" + DSH_LOCAL_ORIGIN);
            }
            p.edit().putLong(KEY_LAST_VERSION_CODE, current)
                    .putString(KEY_LAST_VERSION_NAME, curName).apply();
        } catch (Throwable ignored) { }
    }

    /** 包是否经历过覆盖安装（lastUpdateTime 晚于 firstInstallTime；旧版本没有版本记录时用）。 */
    private boolean packageWasUpdatedInPlace() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.lastUpdateTime > pi.firstInstallTime + 5000L;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 自更新后的旧进程守卫。
     *
     * 真机事故（0.3.177 安装后）：包已经换成 177，但原进程没被系统杀——旧 WebView
     * 继续跑旧 bundle，`:tunnel` 旧服务继续占着 23389，DSH/RDP 全部表现为断链；
     * force-stop 再打开才恢复。这里在 onResume 对比「进程启动版本」与「当前安装版」：
     * 不一致 = 本进程是更新前遗留的旧进程，主动停服务并结束自己，让用户下次点开即新进程。
     */
    private void killLegacyProcessAfterPackageUpdate() {
        final long current = currentVersionCode();
        final long born = sProcessVersionCode;
        if (current <= 0 || born <= 0 || current == born) return;
        try {
            GwLog.note(this, "app-update 检测到包已更新（进程=" + born + "，安装=" + current
                    + "）——结束旧进程，避免旧 WebView/旧隧道服务继续运行");
        } catch (Throwable ignored) { }
        // 2026-10-31 状态契约（单一写者）：本方法**不再**清 DSH origin。
        // 原来这里在旧进程守卫里无条件 deleteOrigin——与 resetInAppBrowserCacheOnVersionChange
        // 形成两个写者，且不看版本粒度（补丁位更新也清），把 DSH SPA 的会话指针
        // （dsh.sessions.current）一并删掉，冷启动落空态（手机黑屏真案）。
        // 现在 DSH origin 的清理只归 resetInAppBrowserCacheOnVersionChange 一个写者，
        // 且只在主.次版本变更时执行；旧进程只负责退出自己。
        try {
            GwLog.note(this, "app-update 旧进程退出（不清 DSH origin——清理职责归版本守卫）");
        } catch (Throwable ignored) { }
        try { stopService(new Intent(this, TunnelProcessService.class)); } catch (Throwable ignored) { }
        try { stopService(new Intent(this, KeepAliveService.class)); } catch (Throwable ignored) { }
        try { finishAffinity(); } catch (Throwable ignored) { }
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /**
     * 渲染进程崩溃自愈（PageSeen.onRenderProcessGone 回调，UI 线程）：
     * 真机"开分享卡后主界面 JS 永久死"——DSH 流程内存压力大时 renderer 被杀，
     * WebView 变死页（evaluateJavascript 超时、tap 无响应、画面冻结）。
     * 这里在 UI 线程重载主页面（file:///android_asset/www/index.html）：
     * WebView 实例本身可以复用（cleared 状态的 renderer 会随 loadUrl 重建），
     * localStorage/登录态在盘上（DomStorage），重载后 app 自愈回任务列表。
     */
    /**
     * 渲染进程崩溃自愈（2026-10-24 二次修，真机黑屏现场）：
     * 旧实现是对**已崩溃的 WebView** 再 loadUrl——Chromium 崩溃后该实例已不可用，
     * loadUrl 无效 → 用户看到整屏黑（native 活着、JS eval 全空）。
     * 现在改成重建 Activity（连带新 WebView + 页面重载），这是崩溃后唯一可靠路径。
     */
    public void onMainRenderGone(WebView v) {
        v.post(new RenderGoneRecreate(this));
    }

    /** 顶层类（d8 纪律：不用匿名内嵌 Runnable——R8 NPE）。 */
    private static class RenderGoneRecreate implements Runnable {
        private final MainActivity act;
        RenderGoneRecreate(MainActivity a) { this.act = a; }
        @Override public void run() {
            try { act.recreate(); } catch (Throwable ignored) { }
        }
    }

    /** 下载完成→安装意图(具名类:d8 8.2 对匿名类 class 文件解析 NPE,绕开)。 */
    private static class InstallOnDone extends BroadcastReceiver {
        private final Activity act;
        private final DownloadManager dm;
        private final long id;
        InstallOnDone(Activity a, DownloadManager dm, long id) { act = a; this.dm = dm; this.id = id; }
        @Override public void onReceive(Context c, Intent i) {
            if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
            Uri u = dm.getUriForDownloadedFile(id);
            if (u == null) return;
            Intent inst = new Intent(Intent.ACTION_VIEW);
            inst.setDataAndType(u, "application/vnd.android.package-archive");
            inst.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try { act.startActivity(inst); } catch (Exception ignored) { }
            try { act.unregisterReceiver(this); } catch (Exception ignored) { }
        }
    }

    /**
     * 2026-10-23：回前台恢复（真机问题：退后台再切回来连不上——RDP 卡转圈/聊天"重新连接"卡死）。
     *
     * 背景：荣耀等机型后台压制 WebView 网络与定时器（B1 实测后台 23min 0 请求），
     * 且本 Activity 之前没有 onPause/onResume → 页面可能拿不到 visibilitychange，
     * JS 不知道环境变了、不会重建半开连接。这里在 onResume 显式注入恢复钩子
     * （JS 侧 window.__mycoHostResume：刷新 presence / 重武装 vnet 转发 / 广播 online）。
     */
    /** 2026-10-24：熄屏休眠后亮屏不自愈（Honor 冻结 WebView/进程，EnvServer 20s 超时、转发全挂）→
     *  监听亮屏/解锁广播，主动注入恢复钩子。 */
    private ScreenOnReceiver screenOnReceiver;

    /** 亮屏/解锁回调（由 ScreenOnReceiver 调用）：注入 JS 恢复钩子 + 补一刀。 */
    void onScreenWake() {
        final WebView w = web;
        if (w == null) return;
        try { w.onResume(); } catch (Throwable ignored) { }
        try {
            w.evaluateJavascript(
                    "try{if(window.__mycoHostResume){window.__mycoHostResume();}}catch(e){}", null);
        } catch (Throwable ignored) { }
        try { new DelayedResumeKick(w).schedule(1500); } catch (Throwable ignored) { }
    }

    // ═══ 2026-10-28 深链接登录（DL-Auth）：myco://auth?ticket=<t>&callback=<url> ═══
    // Android intent filter 捕获 → 存静态字段 → onPageFinished 注入 JS。
    // JS 侧（deep-link.ts）监听 __mycoDeepLink 事件 → 弹确认 → 签名 → 回调浏览器登录。
    private static String sPendingDeepLink = null;
    /** DeepLinkBridge 读写的公共窗口（JS PULL 模型）。 */
    public static volatile String sPendingDeepLinkPublic = null;

    /** onCreate / onNewIntent 都调这里；解析 myco:// URI 存入静态字段。 */
    private void handleDeepLink(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        String scheme = data.getScheme();
        if (scheme == null || !scheme.equals("myco")) return;
        String url = data.toString();
        // 只放行 myco://auth（登录确认），其他 myco:// 子路径后续扩展
        if (url.startsWith("myco://auth")) {
            sPendingDeepLink = url;
            sPendingDeepLinkPublic = url; // DeepLinkBridge（JS PULL）同步
            android.util.Log.i("MycoDeepLink", "received: " + url.substring(0, Math.min(80, url.length())));
        }
    }

    /** singleTask 模式下 app 已在跑时收到深链接 → onNewIntent（不在 onCreate 路径）。 */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
        // 2026-10-29 修：延迟注入等 WebView 解冻
        if (sPendingDeepLink != null && web != null) {
            web.postDelayed(new DeepLinkInjectTask(this), 600);
            // 二次兜底：2 秒后再试一次
            web.postDelayed(new DeepLinkInjectTask(this), 2000);
        }
    }

    /** 顶层类（d8 纪律）：延迟注入深链接（等 WebView 解冻）。 */
    private static class DeepLinkInjectTask implements Runnable {
        private final MainActivity act;
        DeepLinkInjectTask(MainActivity act) { this.act = act; }
        @Override public void run() { act.injectDeepLinkIfPending(); }
    }

    /** WebView 加载完成后注入深链接（onPageFinished 调 + onNewIntent 即时调）。 */
    void injectDeepLinkIfPending() {
        final String dl = sPendingDeepLink;
        if (dl == null || web == null) return;
        // 2026-10-29 修：不再提前清——WebView 冻结时 evaluateJavascript 会静默丢，
        // 清了就永远丢了。改为 JS 侧收到后回调清除（window.__mycoDeepLinkAck）。
        // Java 侧兜底：30 秒后自动清（防重复注入死循环）。
        final String js = "try{if(window.__mycoDeepLink===" + jsonStr(dl) + "){}"
                + "else{window.__mycoDeepLink=" + jsonStr(dl) + ";"
                + "window.dispatchEvent(new CustomEvent('myco-deep-link',{detail:{url:" + jsonStr(dl) + "}}));}"
                + "}catch(e){}";
        try {
            // 2026-10-29 修：evaluateJavascript 在部分 Honor WebView 冻结恢复后静默丢。
            // 双通道：evaluateJavascript + loadUrl(javascript:)——总有一个能到。
            web.evaluateJavascript(js, null);
            web.loadUrl("javascript:" + js);
            android.util.Log.i("MycoDeepLink", "injected(dual): " + dl.substring(0, Math.min(40, dl.length())));
            // 30 秒后清（JS 已有机会收到）
            web.postDelayed(() -> { if (dl.equals(sPendingDeepLink)) sPendingDeepLink = null; }, 30000);
        } catch (Throwable t) {
            android.util.Log.w("MycoDeepLink", "inject failed: " + t);
        }
    }

    /** Java 字符串 → JSON 字符串字面量（URL 场景：只需转义反斜杠和引号）。 */
    private static String jsonStr(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 2026-10-29 修（onNewIntent 在部分 Honor 机型不可靠）：onResume 直接读 intent data。
        try {
            Intent ri = getIntent();
            if (ri != null) {
                Uri rd = ri.getData();
                if (rd != null && "myco".equals(rd.getScheme()) && rd.toString().startsWith("myco://auth")) {
                    sPendingDeepLink = rd.toString();
                    sPendingDeepLinkPublic = rd.toString(); // 2026-10-29 修：漏设 public 字段（桥读的是这个）
                }
            }
        } catch (Throwable ignored) { }
        if (sPendingDeepLink != null && web != null) {
            web.postDelayed(new DeepLinkInjectTask(this), 500);
            web.postDelayed(new DeepLinkInjectTask(this), 1500);
        }
        // 跨版本首启：先清 DSH 应用内浏览器旧缓存（新进程/旧进程都覆盖）。
        resetInAppBrowserCacheOnVersionChange();
        // 自更新装完但系统没杀旧进程：本进程还在跑旧代码/旧 WebView → 主动收尾。
        killLegacyProcessAfterPackageUpdate();
        final WebView w = web;
        if (w == null) return;
        try { w.onResume(); } catch (Throwable ignored) { }
        try {
            w.evaluateJavascript(
                    "try{if(window.__mycoHostResume){window.__mycoHostResume();}}catch(e){}", null);
        } catch (Throwable ignored) { }
        // 兜底：1.2s 后再踢一次（部分机型 onResume 时 WebView 还没恢复网络栈）
        try {
            new DelayedResumeKick(w).schedule(1200);
        } catch (Throwable ignored) { }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 2026-10-26：InAppBrowserActivity 覆盖主壳时，主 WebView 的 vnet-forward / WS
        // 回调会被 Chromium 挂起；DSH 的 127.0.0.1:23911 请求因此卡在 JS 队列，页面报
        // ERR_EMPTY_RESPONSE。主壳保持 JS timers/网络栈运行，别让 DSH 隧道依赖的 JS
        // 在主 WebView 不可见时停摆。
        final WebView w = web;
        if (w == null) return;
        try { w.onResume(); } catch (Throwable ignored) { }
        try { w.resumeTimers(); } catch (Throwable ignored) { }
    }

    /** JS bridge:PWA 侧 window.MycoShell 探测/保活/自更新。 */
    private static class MycoShell {
        /**
         * 2026-10-23：应用内浏览器（DSH 分享页专用）。
         * 系统浏览器（荣耀/百度 LightSearchActivity）经 vnet forward 打开 127.0.0.1 页面不可用；
         * 主 WebView 又会被 PageSeen 拉回 file:// 首页 ⇒ 用独立的 InAppBrowserActivity 承载。
         * 返回 JSON 字符串（桥只能传 string）。
         */
        @android.webkit.JavascriptInterface
        public String openInAppBrowser(String url, String guardJs) {
            try {
                android.webkit.WebView w = sWeb;
                if (w == null) return "{\"ok\":false,\"err\":\"no-webview\"}";
                // 2026-10-31 诊断：记录每次打开的真实 URL（区分"参数不同" vs "状态被老页影响"）。
                try { GwLog.note(w.getContext(), "inapp-open " + url); } catch (Throwable ignored) { }
                // 2026-10-31 复用（A 方案）：同一张分享已有存活的应用内浏览器 → 直接
                // REORDER_TO_FRONT 回前台（不再新建 Activity/WebView；页面状态与 WS 保持，
                // 修「返回 myco 再点同一张卡 → 空列表」的冷启动竞态）。
                if (InAppBrowserActivity.tryBringToFront(w.getContext(), url)) {
                    try { GwLog.note(w.getContext(), "inapp-reuse " + InAppBrowserActivity.keyOf(url)); } catch (Throwable ignored) { }
                    return "{\"ok\":true,\"reused\":true}";
                }
                android.content.Intent i =
                        new android.content.Intent(w.getContext(), InAppBrowserActivity.class);
                i.putExtra(InAppBrowserActivity.EXTRA_URL, url);
                i.putExtra(InAppBrowserActivity.EXTRA_GUARD, guardJs == null ? "" : guardJs);
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                w.getContext().startActivity(i);
                return "{\"ok\":true}";
            } catch (Throwable e) {
                return "{\"ok\":false,\"err\":\"" + String.valueOf(e).replace("\"", "'") + "\"}";
            }
        }

        private final MainActivity act;
        MycoShell(MainActivity a) { act = a; }
        /** 批四：聊天通知渠道 + 自增 id（每条新消息独立通知，不互相顶掉）。 */
        private static final String CHAT_CHANNEL = "myco_chat";
        private static int chatNotifyId = 1000;

        @JavascriptInterface
        public boolean isApk() { return true; }

        /**
         * 2026-11-06 目标②：RDP 桥——启动手机上的 Microsoft Remote Desktop。
         * 已装包名 com.microsoft.rdc.androidx；用 ACTION_VIEW + rdp:// URI 或
         * 显式 Component 启动。失败时返回 false（JS 走复制地址降级）。
         */
        @JavascriptInterface
        public boolean openRdp(String address, String device) {
            try {
                // 优先：rdp:// URI（MS RD 注册了的 scheme）
                android.content.Intent i = new android.content.Intent(
                        android.content.Intent.ACTION_VIEW,
                        android.net.Uri.parse("rdp://" + address));
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
                return true;
            } catch (Exception e1) {
                try {
                    // 回退：显式 Component（MS RD 主 Activity）
                    android.content.Intent i2 = new android.content.Intent();
                    i2.setComponent(new android.content.ComponentName(
                            "com.microsoft.rdc.androidx",
                            "com.microsoft.rdc.androidx.activities.HomeActivity"));
                    i2.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i2);
                    return true;
                } catch (Exception e2) {
                    android.util.Log.e("MycoShell", "openRdp failed: " + e2);
                    return false;
                }
            }
        }

        /** 2026-10-20 B 方案配套：引导加入电池优化白名单（Honor/EMUI 还需用户手动开自启动/后台活动）。 */
        @JavascriptInterface
        public String requestBackgroundWhitelist() {
            try {
                android.content.Intent i = new android.content.Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + act.getPackageName()));
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
                return "OK";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 B1：FreezeWakeReceiver 唤醒后注入 JS，JS 执行到本桥即证明唤醒有效。 */
        @JavascriptInterface
        public void alarmWakeJsRan() {
            MainActivity.sAlarmWakeAck = true;
            RelayProvider.markJsAlive();
            GwLog.note(act, "alarm-wake jsRan=1");
        }

        /** 2026-10-20 运维：清理本机「小灵（官方 did）」会话的 localStorage（测试通知留痕清理用）。 */
        @JavascriptInterface
        public String clearOfficialConv() {
            try {
                final WebView w = act.web;
                if (w == null) return "ERR:no-webview";
                // 独立顶层 Runnable（本工程 D8 对匿名 Runnable 会内部错误）
                w.post(new OfficialConvCleanTask(w));
                return "OK";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 B1 配套：请求精确闹钟权限（Android 12+ 特殊访问；未授权时 Doze 迟到更大）。 */
        @JavascriptInterface
        public String requestExactAlarmPermission() {
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    android.content.Intent i = new android.content.Intent(
                            android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                            android.net.Uri.parse("package:" + act.getPackageName()));
                    i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                    return "OK:requested";
                }
                return "OK:pre-31-noop";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 B1 配套：打开本应用系统设置页（Honor/EMUI 用户在此开自启动/后台活动）。 */
        @JavascriptInterface
        public String openAppSettings() {
            try {
                android.content.Intent i = new android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + act.getPackageName()));
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
                return "OK:opened";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 B1 配套：精确闹钟能力自检（给 DSH R8b 记录）。 */
        @JavascriptInterface
        public String exactAlarmCapability() {
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    android.app.AlarmManager am = (android.app.AlarmManager) act.getSystemService(android.content.Context.ALARM_SERVICE);
                    boolean ok = am != null && am.canScheduleExactAlarms();
                    return "{\"canScheduleExactAlarms\":" + ok + ",\"sdk\":" + Build.VERSION.SDK_INT + "}";
                }
                return "{\"canScheduleExactAlarms\":true,\"sdk\":" + Build.VERSION.SDK_INT + "}";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 B1 测试用：N 秒后触发一次 FreezeWakeReceiver（真机复现/联调用）。 */
        @JavascriptInterface
        public String scheduleTestAlarm(int seconds) {
            try {
                FreezeWakeReceiver.scheduleTest(act, seconds);
                return "OK:" + seconds + "s";
            } catch (Exception e) { return "ERR:" + e.getMessage(); }
        }

        /** 2026-10-20 C 方案：KeepAliveService 每 4s 注入的 JS 回执——能调到这里说明 JS 真跑了。 */
        @JavascriptInterface
        public void markJsTick() { RelayProvider.markJsAlive(); }

        /** 2026-10-20 C 方案诊断面：冻结/停摆时给 eval 与日志用的原生信号（不依赖 WebView JS 活性）。 */
        @JavascriptInterface
        public String relayDiag() {
            return "{\"jsIdleMs\":" + RelayProvider.jsIdleMs()
                    + ",\"pendingTunnelBytes\":" + RelayProvider.pendingTunnelBytes()
                    + ",\"lastTunnelBytesAtMs\":" + RelayProvider.lastTunnelBytesAt() + "}";
        }

        /** 身份 vault 双副本(2026-09-05):PWA 的 localStorage 被「清数据/存储回收」
         *  时,从 APK 私有文件(getFilesDir)兜底恢复。云端零私钥不变——纯本机第二副本。
         *  文件 IO 在 bridge 线程(非 UI),安全。 */
        @JavascriptInterface
        public void vaultBackup(String text) {
            try {
                java.io.File f = new java.io.File(act.getFilesDir(), "myco-vault.json");
                java.io.FileOutputStream os = new java.io.FileOutputStream(f, false);
                os.write(text.getBytes("UTF-8"));
                os.close();
            } catch (Exception e) {
                android.util.Log.e("MycoShell", "vaultBackup failed", e);
            }
        }

        @JavascriptInterface
        public String vaultRestore() {
            try {
                java.io.File f = new java.io.File(act.getFilesDir(), "myco-vault.json");
                if (!f.exists()) return "";
                java.io.FileInputStream is = new java.io.FileInputStream(f);
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) > 0) b.write(buf, 0, n);
                is.close();
                return b.toString("UTF-8");
            } catch (Exception e) {
                return "";
            }
        }

        /** 相机直拍(2026-09-04 修「拍照不弹」:此前桥上根本没有这个方法,PWA 调
         *  undefined 静默走文件选择器兜底=无反应)。真正启动在 SnapCamLaunch(UI 线程)。 */
        @JavascriptInterface
        public String captureCamera() { return act.snapCamCapture(); }

        /** 图库选图识别邀请码(对方远程发码截图的场景;与 captureCamera 同模式)。 */
        @JavascriptInterface
        public String pickImage() { return act.snapCamPick(); }

        /** 第94轮:聊天文件卡点击——写 MediaStore + ACTION_VIEW 系统默认程序打开。
         *  返回 "OK" / "ERR:人话"(前端 toast);IO 在 bridge 线程,startActivity 走
         *  FileOpen 的 UI 线程投递。 */
        @JavascriptInterface
        public String openFile(String b64, String name, String mime) {
            return FileOpen.open(act, b64, name, mime);
        }

        /** 诊断:查身份/服务器握手状态(presence/list 是否含 PC,signed 与否)。
         *  直接发 HTTP 到火山,不依赖 WebView JS——主流程出问题(任务页/配对)时用它定位。 */
        @JavascriptInterface
        public String presenceSnapshot() {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(
                    "http://myco.youling.cc:8321/presence/list").openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/json");
                c.setConnectTimeout(5000); c.setReadTimeout(5000);
                c.setDoOutput(true);
                c.getOutputStream().write("{}".getBytes());
                int code = c.getResponseCode();
                java.io.InputStream is = code == 200 ? c.getInputStream() : c.getErrorStream();
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1024]; int n;
                while ((n = is.read(buf)) > 0) b.write(buf, 0, n);
                return "http=" + code + " body=" + b.toString().substring(0, Math.min(400, b.toString().length()));
            } catch (Exception e) { return "ERR: " + e.getMessage(); }
        }

        /** 自截屏(顶层类 SelfSnap,不嵌套——R8 对内嵌类字节码 NPE)。
         *  存外部私有目录(/sdcard/Android/data/<pkg>/files/),adb 可读。 */
        @JavascriptInterface
        public String selfScreenshot() { return SelfSnap.snap(act, act.web); }

        /** 2026-10-12 聊天中继 provider（PC→手机方向兜底）：手机注册到云中继，
         *  PC 直推不可达时经中继隧道拨入（数据面 port=9100 分流到帧内 HTTP）。
         *  参数由 PWA 装配层传（设备 did + 本地隧道口）；幂等；未就绪静默 no-op。 */
        // ═══ 2026-10-22 手机端 vnet 固定端口转发（外网 RDP/SSH/DSH） ═══
        // 每个固定本地口一个原生监听；隧道由 JS 拨（手机作发起方），原生只搬字节。
        @JavascriptInterface
        public String vnetForwardStart(int localPort) {
            return ForwardListener.start(localPort);
        }

        @JavascriptInterface
        public String vnetForwardStop(int localPort) {
            ForwardListener.stop(localPort);
            return "{\"ok\":true}";
        }

        @JavascriptInterface
        public String vnetForwardList() {
            return ForwardListener.list();
        }

        @JavascriptInterface
        public void vnetForwardSend(int localPort, int connId, String b64) {
            try {
                ForwardListener.send(localPort, connId, android.util.Base64.decode(b64, android.util.Base64.NO_WRAP));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void vnetForwardClose(int localPort, int connId, String why) {
            ForwardListener.close(localPort, connId, why);
        }

        // ═══════════ 原生数据面（任意 env 本地口 → 对端目标口，2026-10-26 起） ═══════════
        // WebView JS 被冻结（切后台 / 外部客户端 App 前台 / InAppBrowser 覆盖）时隧道
        // 停摆的根修：JS 身份层把身份/种子/候选腿注入原生（arm），此后该端口的协议栈
        // （签名/X25519/AES-GCM/帧序号/WS）全在 Java 线程跑，不依赖 WebView 活性。
        // 种子只在内存，身份存储仍归 JS vault。
        // 2026-11-01：端口白名单删除（此前只支持 23389/23911，导致 23390 等新端口
        // 仍然卡在"启动中"）——**任意端口**都可以 arm。

        /** 注入/刷新原生数据面配置（独立进程服务消费；任意本地口）。 */
        @JavascriptInterface
        public String vnetRdpArm(String json) {
            int localPort = 0;
            try {
                localPort = new org.json.JSONObject(json == null ? "" : json)
                        .optInt("localPort", 0);
            } catch (Throwable ignored) {
            }
            if (localPort <= 0 || localPort > 65535) {
                return "{\"ok\":false,\"err\":\"localPort 非法 " + localPort + "\"}";
            }
            // 该端口的 listener 必须从主进程移交给 :tunnel；先停主进程监听，再启服务。
            ForwardListener.stop(localPort);
            Intent svc = new Intent(act, TunnelProcessService.class);
            svc.setAction(TunnelProcessService.ACTION_ARM);
            svc.putExtra(TunnelProcessService.EXTRA_ARM_JSON, json == null ? "" : json);
            svc.putExtra(TunnelProcessService.EXTRA_LOCAL_PORT, localPort);
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    act.startForegroundService(svc);
                } else {
                    act.startService(svc);
                }
                return "{\"ok\":true,\"armed\":true,\"pending\":true,\"localPort\":" + localPort + "}";
            } catch (Exception e) {
                return "{\"ok\":false,\"err\":\"" + e.getMessage() + "\"}";
            }
        }

        /** 撤注指定端口（23389=RDP / 23911=DSH；独立名避免 JS bridge 重载歧义）。 */
        @JavascriptInterface
        public String vnetStreamDisarm(int localPort) {
            Intent svc = new Intent(act, TunnelProcessService.class);
            svc.setAction(TunnelProcessService.ACTION_DISARM);
            svc.putExtra(TunnelProcessService.EXTRA_LOCAL_PORT, localPort);
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    act.startForegroundService(svc);
                } else {
                    act.startService(svc);
                }
            } catch (Throwable ignored) {
            }
            return "{\"ok\":true,\"armed\":false,\"localPort\":" + localPort + "}";
        }

        /** 兼容旧无参桥：撤注全部原生流端口。 */
        @JavascriptInterface
        public String vnetRdpDisarm() {
            Intent svc = new Intent(act, TunnelProcessService.class);
            svc.setAction(TunnelProcessService.ACTION_DISARM);
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    act.startForegroundService(svc);
                } else {
                    act.startService(svc);
                }
            } catch (Throwable ignored) {
            }
            return "{\"ok\":true,\"armed\":false}";
        }

        /** 原生 RDP/DSH 数据面状态（直读 :tunnel 进程原子状态文件）。 */
        @JavascriptInterface
        public String vnetRdpState() {
            String s = TunnelProcessService.readState(act);
            if (s == null || s.isEmpty()) return "{\"ok\":true,\"armed\":false}";
            return s;
        }

        // ═══ 2026-11-11「ADB 调试」分享卡（需求 youling-myco apps/vnet/docs/
        // ADB-SHARE-TASK.md）：手机当 vnet server（5555），授权设备经隧道
        // adb connect。与上面的 vnetRdpArm 方向相反——那是"我去连别人"的
        // 数据面，这是"别人连我"。peer_id 公式与 PC vnet_forward.rs 同源。
        // ⚠️ 凡触 libvnet 的桥一律**异步**（注册重试在调用线程会冻 WebView，
        // 真机事故实证）；state() 只读原子字段，保持同步。═══

        /** 启动 ADB vnet server（异步；结果经 callbackJs(resultJson) 回）。
         *  json：{device:本机设备did, targetPort:5555, relay?, secret?}。 */
        @JavascriptInterface
        public void vnetAdbServerStartAsync(final String callbackJs, final String json) {
            final MainActivity a = act;
            new Thread(new AdbServerTask(a, callbackJs, json, true), "myco-adb-ensure").start();
        }

        /** 停止 ADB vnet server（异步；撤销=闸门随 server 消亡立即断开）。 */
        @JavascriptInterface
        public void vnetAdbServerStopAsync(final String callbackJs) {
            final MainActivity a = act;
            new Thread(new AdbServerTask(a, callbackJs, "", false), "myco-adb-ensure").start();
        }

        /** ADB vnet server 状态快照（running/targetPort/startedAtMs/lastErr）——
         *  只读原子字段，不触 libvnet，同步安全。 */
        @JavascriptInterface
        public String vnetAdbServerState() {
            return AdbShareServer.state();
        }

        /** 本机设备 did（轻量同步桥，不触 libvnet）：优先 RelayProvider 装配时
         *  注入的 did，并持久化到 SharedPreferences（下次冷启动 relay 未装配时
         *  也能取到）。空串 = 尚未就绪。JS 侧身份 vault 没有 rootDid 字段
         *  （2026-11-11 DSH协议应用 踩过），手机 DID 以本桥为准。 */
        @JavascriptInterface
        public String myDeviceDid() {
            try {
                String did = RelayProvider.deviceDid();
                if (did != null && did.length() >= 8) {
                    act.getSharedPreferences(PREFS_APP, MODE_PRIVATE)
                            .edit().putString("my_device_did", did).apply();
                    return did;
                }
                return act.getSharedPreferences(PREFS_APP, MODE_PRIVATE)
                        .getString("my_device_did", "");
            } catch (Throwable t) {
                return "";
            }
        }

        /**
         * 2026-11-11：注入本机设备身份到 libvnet（seed 传 base64，同
         * `youling.vault.keyB64`）。必须在起任何 vnet client 之前调一次。
         *
         * 不做成异步：内部只是 base64→hex + 一次 setter，微秒级，不碰网络。
         * 返回 "ok" / 错误串；`vnetHasLocalIdentity()` 可复核。
         */
        @JavascriptInterface
        public String vnetSetLocalIdentity(String did, String seedB64) {
            try {
                int rc = VnetClient.setLocalIdentityB64(did, seedB64);
                return rc == VnetClient.VNET_OK ? "ok" : ("rc=" + rc);
            } catch (Throwable t) {
                return String.valueOf(t);
            }
        }

        @JavascriptInterface
        public boolean vnetHasLocalIdentity() {
            return VnetClient.hasLocalIdentity();
        }

        /** 2026-11-11 对账数据面 vnet 隧道（手机 → 对端 p2p :9100，本地回环口）。
         *  json：{targetDevice, targetPort:9100, localPort:25910, device:本机did}。
         *  **异步桥**（vnet Rust 修复前 libvnet 的 Connection 构造在调用线程同步
         *  做 relay 注册重试/STUN，最长 ~30s——同步桥会冻住 WebView JS 线程，
         *  真机事故实证）。结果经 callbackJs(resultJson) 回；单次尝试不重试。 */
        @JavascriptInterface
        public void p2pTunnelEnsureAsync(final String callbackJs, final String json) {
            final MainActivity a = act;
            new Thread(new P2pTunnelEnsureTask(a, callbackJs, json), "myco-p2p-ensure").start();
        }

        /** 对账隧道状态（诊断；只读原子字段，不碰 vnet）。 */
        @JavascriptInterface
        public String p2pTunnelState() {
            return P2pSyncTunnel.state();
        }

        @JavascriptInterface
        public String relayProviderStart(String deviceDid, int localPort) {
            try {
                RelayProvider.configure(RelayTunnel.DEFAULT_HOST, RelayTunnel.DEFAULT_PORT, deviceDid, localPort);
                RelayProvider.start();
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"ok\":false,\"err\":\"" + e.getMessage() + "\"}";
            }
        }

        /** 2026-10-12 任务卡「在浏览器中打开」：交给系统浏览器（不占 myco 的
         *  WebView/交互，断线由浏览器自己刷新）。**只放行 http(s)**（防 file://
         *  与 intent:// 之类被注入的 URL 借壳——卡片 URL 全部来自我们自己的
         *  隧道口 127.0.0.1:<port>）。 */
        @JavascriptInterface
        public String openInBrowser(String url) {
            try {
                if (url == null) return "ERR:空地址";
                String u = url.trim();
                if (!(u.startsWith("http://") || u.startsWith("https://"))) {
                    return "ERR:只允许 http(s) 地址";
                }
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(u));
                i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
                return "OK";
            } catch (Exception e) {
                return "ERR:" + e.getMessage();
            }
        }

        /** APK 版本号(PWA 更新检查用;从 PackageManager 动态读,不硬编码)。 */
        @JavascriptInterface
        public String getVersionName() {
            try {
                return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
            } catch (Exception e) { return ""; }
        }

        /** 批四：聊天系统通知（好友/群新消息；PWA 侧 onMessageIngested 钩子调用）。
         *  渠道 myco_chat（IMPORTANCE_DEFAULT，可响铃震动）；点击通知回 app 主界面。
         *  命名避开 Object.notify()——JS bridge 方法名若与 Object 撞名,WebView 侧
         *  调用解析有歧义风险,这里用 notifyChat。 */
        @JavascriptInterface
        public void notifyChat(String title, String body) {
            try {
                android.app.NotificationManager nm = act.getSystemService(android.app.NotificationManager.class);
                if (nm == null) return;
                if (Build.VERSION.SDK_INT >= 26) {
                    android.app.NotificationChannel c = new android.app.NotificationChannel(
                        CHAT_CHANNEL, "聊天消息", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                    c.setDescription("好友/群新消息");
                    nm.createNotificationChannel(c);
                }
                // Android 13+：未授予运行时通知权限直接放弃（onCreate 已申请；用户拒绝则不打扰）
                if (Build.VERSION.SDK_INT >= 33 && act.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
                android.app.Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new android.app.Notification.Builder(act, CHAT_CHANNEL)
                    : new android.app.Notification.Builder(act);
                android.content.Intent open = new android.content.Intent(act, MainActivity.class);
                android.app.PendingIntent pi = android.app.PendingIntent.getActivity(act, 0, open,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                b.setContentTitle(title).setContentText(body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true).setShowWhen(true).setContentIntent(pi);
                nm.notify(CHAT_CHANNEL, chatNotifyId++, b.build());
            } catch (Exception e) {
                android.util.Log.e("MycoShell", "notifyChat failed", e);
            }
        }

        /** 诊断用:PWA 当前 URL+标题(web.getUrl/getTitle 线程安全,不用 runOnUiThread——
         *  匿名内嵌类会让 d8(R8 8.2.2-dev)NPE)。 */
        @JavascriptInterface
        public String selfReport() {
            try {
                return "url=" + act.web.getUrl() + " title=" + act.web.getTitle();
            } catch (Exception e) { return "ERR: " + e.getMessage(); }
        }

        @JavascriptInterface
        public void keepAlive() {
            // startService/startForegroundService 是 binder 调用,JS bridge 线程可直接调;
            // 不包 runOnUiThread 匿名类——JBR javac -source 8 产的内嵌类字节码会让
            // d8(R8 8.2.2-dev)NPE(2026-09-04 实测,散 class 和 jar 两种喂法都炸)
            startSvc();
        }

        // ══════════════ 隧道代理（2026-10-09：手机当成员设备「点卡就进」）══════════════
        // 为什么原生必须参与（两条都是浏览器能力天花板）:
        //   ① WebView 的 JS 不能监听 TCP 端口 —— 而"点卡就进"要把
        //      http://127.0.0.1:<本地端口>/gw/<id>/?mt=… 交给 WebView 打开;
        //   ② JS 的 WebSocket **不能设自定义请求头** —— 而隧道握手信封 + 设备签名
        //      必须在 x-myco-tunnel / x-myco-auth 上（PC 端只读 header）。
        // 分工: **原生搬字节,JS 管协议**（X25519/AEAD 帧全在 apps/phone/src/p2p-tunnel.ts）。
        // 安全: 本地监听只绑 127.0.0.1、端口随用随开、关页面即释放（见 TunnelProxyServer）。

        private TunnelProxyService tunnelSvc() {
            return TunnelProxyService.get(act);
        }

        /** 起本地监听（返回 {"ok":true,"port":N}）。 */
        @JavascriptInterface
        public String tunnelStart() { return tunnelSvc().start(); }

        /** 停本地监听 + 关掉所有在途隧道连接。 */
        @JavascriptInterface
        public void tunnelStop() { tunnelSvc().stop(); }

        /** 把对端解出来的明文写回浏览器那条 TCP。 */
        @JavascriptInterface
        public void tunnelSend(int connId, String b64) { tunnelSvc().sendLocal(connId, b64); }

        /** 关掉浏览器那条 TCP（隧道断了/协议错）。 */
        @JavascriptInterface
        public void tunnelClose(int connId, String why) { tunnelSvc().closeLocal(connId, why); }

        /** 代开一条**带自定义请求头**的 WS（异步；结果经 window.__mycoTunnel.wsOpened 回）。 */
        @JavascriptInterface
        public String tunnelOpenWs(String wsId, String url, String headersJson) {
            return tunnelSvc().openWs(wsId, url, headersJson);
        }

        /** 发一条二进制 WS 帧（payload 已是密文帧，原生不解释）。 */
        @JavascriptInterface
        public void tunnelWsSend(String wsId, String b64) { tunnelSvc().wsSend(wsId, b64); }

        /** 关 WS。 */
        @JavascriptInterface
        public void tunnelWsClose(String wsId, int code, String reason) {
            tunnelSvc().wsClose(wsId, code, reason);
        }

        /** 云端中继：预连池补池（开卡前 JS 先热池，省 1×公网 RTT；深 2 / TTL 8s）。
         *  中继腿本身走 tunnelOpenWs 的 relay:// URL（TunnelWs 解析 → RelayTunnel）。 */
        @JavascriptInterface
        public String relayPredial(String addr) { return tunnelSvc().relayPredial(addr); }

        /** 2026-10-22：JS 日志 → EnvServer 环形缓冲（/api/state.notes 读回）。
         *  手机 WebView 里 fetch('http://127.0.0.1:8210') 被拦（file:// 源 + 无 CORS），
         *  而 logcat 在荣耀设备上被 HKS 加密——这是唯一可靠的远程 JS 日志通道。 */
        @JavascriptInterface
        public void jsNote(String s) {
            try { EnvServer.note("JS " + (s == null ? "" : s)); } catch (Throwable ignored) { }
        }

        /** 2026-10-22 真机定位：`jsNote`（void 返回）在 0.3.154 上"调用即挂"——
         *  evaluateJavascript 拿不到结果、`/api/state.notes` 里一条也不落（app 自己的
         *  JS 日志同样丢）。而**有返回值**的桥方法（`selfScreenshot`/`getVersionName`）
         *  正常，所以补一个**返回 String** 的同款日志口给 JS 用：写同一条 NOTES 环形
         *  缓冲，返回 "ok"（JS 侧可据此确认真的落地了）。 */
        @JavascriptInterface
        public String jsNote2(String s) {
            try {
                EnvServer.note("JS " + (s == null ? "" : s));
                return "ok";
            } catch (Throwable t) {
                return "ERR:" + t.getClass().getSimpleName();
            }
        }

        // 2026-10-22 手机入向 vnet 隧道：隧道帧 ↔ 127.0.0.1:<端口>（如 adb 5555）
        @JavascriptInterface
        public String tcpDial(int port) { return tunnelSvc().dialTcp(port); }

        @JavascriptInterface
        public void tcpSend(int connId, String b64) { tunnelSvc().dialSend(connId, b64); }

        @JavascriptInterface
        public void tcpClose(int connId) { tunnelSvc().dialClose(connId); }

        /** 在**独立 WebView**里打开分享页（主 WebView 必须活着——它持有隧道客户端）。 */
        @JavascriptInterface
        public String reuseSharePage(String shareId) {
            try {
                return ShareWebActivity.reuseForIdDiag(shareId);
            } catch (Throwable t) {
                return "ERR:" + t.getClass().getSimpleName();
            }
        }

        /** 清场：关闭当前分享页（R10 计量用；正常用户返回不关页）。 */
        @JavascriptInterface
        public String closeSharePage() {
            ShareWebActivity.closeActive();
            return "OK";
        }

        @JavascriptInterface
        public String openShareWeb(String url, String title) {
            return tunnelSvc().openShareWeb(url, title);
        }

        /** 诊断一行（EnvServer/adb 取证用）。 */
        @JavascriptInterface
        public String tunnelState() { return tunnelSvc().snapshot(); }

        /** 原生异步 HTTP POST 到本地代理（绕过 WebView CORS + 避免同步死锁）。
         *  同步版的问题：@JavascriptInterface 阻塞 JS 线程 → 代理需要 JS 处理连接
         *  → JS 被阻塞 → 死锁。异步版在后台线程跑 HTTP（ProxyPostTask 顶层类），
         *  完成后回 JS 回调。callbackJs 形如 'window.__ppResolve'。 */
        @JavascriptInterface
        public void proxyPostAsync(final String callbackJs, final String urlString, final String contentType, final String authHeader, final String body) {
            new Thread(new ProxyPostTask(act, callbackJs, urlString, contentType, authHeader, body)).start();
        }

        /** 同步版（保留兼容）：直接在调用线程跑（JS 桥线程），本地代理场景
         *  会死锁（代理需要 JS 处理连接而 JS 被阻塞）——新代码请用 proxyPostAsync。 */
        @JavascriptInterface
        public String proxyPost(String urlString, String contentType, String authHeader, String body) {
            ProxyPostTask task = new ProxyPostTask(act, "", urlString, contentType, authHeader, body);
            return task.doHttpPost();
        }

        private void startSvc() {
            Intent i = new Intent(act, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) act.startForegroundService(i);
            else act.startService(i);
        }

        /** 下载新 APK(公共 Download 目录)并弹安装意图——PWA 检查 latest.json 后调用。
         *  全程 try-catch:JS bridge 层 Java 异常会直接抛到 WebView console,
         *  用户看到 "Java exception was raised"——捕获后静默或 Log.e 即可。 */
        @JavascriptInterface
        public void downloadApkUpdate(final String url, final String fileName) {
            try {
                DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) return;
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setMimeType("application/vnd.android.package-archive");
                final long id = dm.enqueue(req);
                // 下载完成 → 触发安装意图(REQUEST_INSTALL_PACKAGES 已在 Manifest 声明)
                InstallOnDone recv = new InstallOnDone(act, dm, id);
                IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                // Android 13+(API 33): registerReceiver 必须带 EXPORTED flag,否则
                // SecurityException → JS 层 "Java exception was raised"(用户实测实测问题)
                if (Build.VERSION.SDK_INT >= 33) {
                    act.registerReceiver(recv, filter, Context.RECEIVER_EXPORTED);
                } else {
                    act.registerReceiver(recv, filter);
                }
            } catch (Exception e) {
                android.util.Log.e("MycoShell", "downloadApkUpdate failed", e);
            }
        }
    }
}

/** WebView getUserMedia 授权（扫码摄像头用）。
 *  无 WebChromeClient 时 onPermissionRequest 无人应答，页面拿到 NotAllowedError。
 *  2026-09-29 补 onShowFileChooser（Bug2「传照片点了没反应」根修）：此前未实现，
 *  HTML <input type=file> 在 WebView 里点击完全无响应——好友聊天 📷 按钮、
 *  agent 聊天选图全瘫。现在走系统文件/图片选择器（accept=image/* → PhotoPicker，
 *  content URI 临时授权无需存储权限），结果经 MainActivity.onActivityResult
 *  （REQ_FILE_CHOOSER）回灌 WebView（包成 File 喂 input 的 change 事件）。
 *  顶层类（R8 对 MainActivity 内嵌类炸——同 SnapTask/PageSeen 风格）。 */
class PermChrome extends WebChromeClient {
    /** onActivityResult 路由码（避开 SnapCam 的 0xCA01/0xCA02）。 */
    public static final int REQ_FILE_CHOOSER = 0xCA03;
    /** 未决 file chooser 回调（Chromium 一次只允许一个；不消费则后续点击不再弹）。 */
    private static android.webkit.ValueCallback<android.net.Uri[]> pendingCallback;

    /** 2026-10-22：JS console → logcat（tag MycoConsole）。
     *  手机侧排障长期缺一条通道——WebView 的 console.log 默认不进 logcat，
     *  vnet 入向隧道这类 JS 逻辑只能盲猜。`adb logcat -s MycoConsole:*` 即可看。 */
    @Override
    public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
        try {
            android.util.Log.i("MycoConsole", m.messageLevel() + " " + m.message() + " @" + m.lineNumber());
        } catch (Throwable ignored) { }
        return true;
    }

    @Override
    public void onPermissionRequest(android.webkit.PermissionRequest request) {
        request.grant(request.getResources());
    }

    /** input[type=file].click() → 系统选择器。回调存静态位，Activity 结果路由回来消费。 */
    @Override
    public boolean onShowFileChooser(WebView webView, android.webkit.ValueCallback<android.net.Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        if (pendingCallback != null) {
            // 上一次未消费（异常路径遗留）——先释放，否则 Chromium 拒绝本次新开
            pendingCallback.onReceiveValue(null);
        }
        pendingCallback = filePathCallback;
        try {
            Intent i = fileChooserParams.createIntent(); // 自动带 acceptTypes（image/*）
            ((Activity) webView.getContext()).startActivityForResult(i, REQ_FILE_CHOOSER);
            return true;
        } catch (Exception e) {
            android.util.Log.e("PermChrome", "file chooser launch failed", e);
            pendingCallback = null;
            filePathCallback.onReceiveValue(null);
            return false;
        }
    }

    /** Activity onActivityResult 转发：选中 → parseResult（Uri[]）；取消也必须
     *  消费（null）——否则下一次点击 input 不再弹选择器（经典坑）。 */
    static void onFileChooserResult(int resultCode, Intent data) {
        if (pendingCallback == null) return;
        android.webkit.ValueCallback<android.net.Uri[]> cb = pendingCallback;
        pendingCallback = null;
        android.net.Uri[] uris = null;
        try { uris = FileChooserParams.parseResult(resultCode, data); } catch (Exception e) { uris = null; }
        cb.onReceiveValue(uris);
    }
}
