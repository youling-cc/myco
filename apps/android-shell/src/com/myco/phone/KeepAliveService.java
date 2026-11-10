package com.myco.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台保活服务(2026-09-03 常驻长连接):把进程提到前台优先级——WebView 里的
 * PWA(信令 SSE/WebRTC 连接/presence 心跳)在 App 退后台后继续跑,不被系统冻结。
 * 服务自身零逻辑:常连接由 WebView 页面持有(与 PC/笔记本同一形态——PWA 身份
 * 与签名复用,原生层不碰密钥)。通知栏常驻"myco 后台在线"。
 */
public class KeepAliveService extends Service {
    private static final String CH = "myco_keepalive";
    /** 2026-10-24: screen-off WiFi power save kills inbound tunnels; keep WiFi radio awake. */
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private NetWatchCallback netWatch;
    private static final int ID = 1;

    @Override
    public void onCreate() {
        super.onCreate();
        // 2026-10-20 B/C：原生 context 交给 RelayProvider（C 方案原生通知用）
        try { RelayProvider.setContext(getApplicationContext()); } catch (Throwable ignored) { }
        // 2026-10-20 B：前台服务存活期持 PARTIAL_WAKE_LOCK，避免熄屏 CPU 深睡导致 JS 停摆
        try {
            android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
            if (pm != null) {
                wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "myco:keepalive");
                wake.setReferenceCounted(false);
                wake.acquire();
            }
        } catch (Throwable ignored) { }
        // 2026-10-24: WiFi high-perf lock (real case: inbound adb dead after screen off)
        try {
            android.net.wifi.WifiManager wm = getSystemService(android.net.wifi.WifiManager.class);
            if (wm != null) {
                wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "myco:wifi-keepalive");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Throwable ignored) { }
        // 2026-10-30 外部 WiFi 真案：主进程全局监听网络切换，强制重探 relay/隧道。
        try {
            android.net.ConnectivityManager cm = getSystemService(android.net.ConnectivityManager.class);
            if (cm != null) {
                netWatch = new NetWatchCallback();
                android.net.NetworkRequest req = new android.net.NetworkRequest.Builder()
                        .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                cm.registerNetworkCallback(req, netWatch);
            }
        } catch (Throwable ignored) { }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel c = new NotificationChannel(CH, "后台在线", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("保持与 PC 的常连接");
            nm.createNotificationChannel(c);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CH)
            : new Notification.Builder(this);
        b.setContentTitle("myco 后台在线")
            .setContentText("与 PC 的连接保持中(常驻长连接)")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true);
        // 2026-10-26：改用 specialUse 长连接档位。dataSync 在 Android 14 上会被
        // 系统当作可冻结的临时同步任务，myco 进程在后台 1 分钟左右即被 cached
        // apps freezer 冻结（真机 isFrozen=true、schedstat 完全停止）。
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                return;
            } catch (Throwable ignored) {
                // 个别 ROM 不认 specialUse：回落传统 startForeground
            }
        }
        startForeground(ID, b.build());
    }

    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        // 2026-10-20 B1：进入前台即排 AlarmManager 周期唤醒（FreezeWakeReceiver 自我续排）。
        try { FreezeWakeReceiver.scheduleNext(this); } catch (Throwable ignored) { }
        startTunnelTick();
        return START_STICKY; // 进程被杀后系统重拉(重拉后 WebView 重建,PWA 自愈重连)
    }

    /**
     * 隧道 tick（2026-10-15 真机实测定案）：主 WebView 被 DSH 页面盖住后，Chromium 对
     * 隐藏页限流定时器——WebView 里 PWA 的隧道重拨状态机停摆（后台探本地隧道口
     * 0 字节超时；回前台 0.54s 复活；用户真案"关 WiFi 后一直重连不上"同根）。
     * 前台服务不受冻结，由它每 4s 经 evaluateJavascript 注入 window.__mycoTunnelTick()：
     * JS 注入不受定时器限流，PWA 借此绕退避重探（refreshCandidates 重装中继腿）。
     */
    private void startTunnelTick() {
        if (tick != null) return;
        tick = new Thread(() -> {
            while (true) {
                try { Thread.sleep(4000); } catch (InterruptedException e) { return; }
                // 2026-10-16：原生侧保护网——中继 provider 的注册循环也在这一拍上兜底
                // （线程死了重开 / 卡在半开 read 上就强拆重连）。**不依赖 WebView**：
                // 真案里 WebView 的 JS 被隐藏页限流，但这条前台服务的线程照跑。
                try { com.myco.phone.RelayProvider.ensureAlive(); } catch (Throwable ignored) { }
                // 2026-10-26 RDP/DSH 原生数据面在 :tunnel 进程；主进程静态 CFG 恒空。
                // watchdog/tick 由 TunnelProcessService 自己打，避免这里误报 armed=[]。
            // 2026-10-20 冻结分类诊断（给 DSH R8b/6c12330）：原生线程每 4s 记一行，不依赖 WebView。
            // 判据：app console[LOG] 停 + 本行 continue = webview_stall（C 组）；
            //      本行也停 = process_suspend（厂商深睡，B/C 均不覆盖）。
            try {
                GwLog.note(null, "native-tick jsIdleMs=" + RelayProvider.jsIdleMs()
                        + " pendingBytes=" + RelayProvider.pendingTunnelBytes());
            } catch (Throwable ignored) { }
                final android.webkit.WebView w = MainActivity.sWeb;
                if (w == null) continue;
                w.post(() -> {
                    try {
                        // 2026-10-16 修「ERR: Script error 红条」（用户真机报+复现）：
                        // tick 内任何同步抛错会以 "Script error." 冒泡到页面的
                        // window.onerror → 全局红条每 4s 刷一次。JS 侧包 try/catch
                        // 吞掉（tick 是 best-effort 心跳，错误不该上 UI）。
                        w.evaluateJavascript(
                            // 2026-10-20 C 方案：回执走 JS 桥（MycoShell.markJsTick）——JS 真执行了才会回调，
                            // 避免在 lambda 里再嵌套匿名类（D8 8.2 对嵌套匿名类会内部错误）。
                            "try{window.__mycoTick&&window.__mycoTick();MycoShell.markJsTick()}catch(e){}", null);
                    } catch (Throwable ignored) { }
                });
            }
        }, "myco-tunnel-tick");
        tick.setDaemon(true);
        tick.start();
    }

    private android.os.PowerManager.WakeLock wake;

    private Thread tick;

    @Override
    public void onDestroy() {
        try {
            if (netWatch != null) {
                android.net.ConnectivityManager cm = getSystemService(android.net.ConnectivityManager.class);
                if (cm != null) cm.unregisterNetworkCallback(netWatch);
            }
        } catch (Throwable ignored) { }
        netWatch = null;
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Throwable ignored) { }
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Throwable ignored) { }
        wifiLock = null;
        wake = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
