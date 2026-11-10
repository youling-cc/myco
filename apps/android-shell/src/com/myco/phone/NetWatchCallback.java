package com.myco.phone;

import android.os.Handler;
import android.os.Looper;

/**
 * NetWatchCallback — 主进程全局网络切换监听（2026-10-30 外部 WiFi/移动网真案）。
 *
 * 旧实现只在 ShareWebActivity 里监听网络；主 WebView 的任务分享隧道、
 * RelayProvider、RDP/DSH 原生流都不会收到 WiFi↔蜂窝切换。半开 WS 仍显示
 * open，`__mycoTick` 不重接，用户在外部网络看到 DSH 空列表/RDP 不通，
 * 回家或再次切网前恢复。
 * 这里在 KeepAliveService 注册系统 NetworkCallback，统一防抖后：
 *  ① 强拆 RelayProvider 旧控制连；
 *  ② 注入 window.__mycoNetChanged()，由 JS 清候选缓存并 forceNetworkReset；
 *  ③ JS 会重报本机 addrs，并把 RDP/DSH 原生流先回 relay-only。
 *
 * 2026-10-31 真机事故修复（"返回再点卡仍空列表 / 页面一直重新连接中"）：
 * 旧实现把 **onCapabilitiesChanged 的每一次回调**都当成网络切换去 force-reconnect。
 * 荣耀/Android 在 WiFi 信号、带宽估计、网络校验状态变化时会**高频**回调（实测几秒一次），
 * 结果是隧道被反复强拆 → DSH 页 WS 每 ~8s 断一次（code=1006）→ 永远"重新连接中"、
 * 会话数据加载不完 → 空列表。现在只在**真正的网络形态变化**时才触发：
 *  - transport 集合变化（WiFi ↔ 蜂窝 ↔ 有线 ↔ VPN 等）；
 *  - 默认网络从"未校验"变为"已校验上网"（首次真正可用，值得重连一次）。
 * 信号强度/带宽估计等能力字段变化一律忽略。
 */
public class NetWatchCallback extends android.net.ConnectivityManager.NetworkCallback {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable task = new NetWatchTask();

    /** 上一次看到的 transport 掩码（WIFI/CELLULAR/ETHERNET/BLUETOOTH/VPN…）。0 = 未知。 */
    private int lastTransportMask;
    /** 上一次看到的"已验证上网"标记。 */
    private boolean lastValidated;

    private static int transportMask(android.net.NetworkCapabilities caps) {
        int mask = 0;
        if (caps == null) return mask;
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) mask |= 1;
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) mask |= 2;
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) mask |= 4;
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_BLUETOOTH)) mask |= 8;
        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) mask |= 16;
        return mask;
    }

    private void schedule(String why) {
        try { GwLog.note(null, "network-callback " + why + "（600ms 防抖）"); } catch (Throwable ignored) { }
        handler.removeCallbacks(task);
        handler.postDelayed(task, 600);
    }

    @Override public void onAvailable(android.net.Network network) { schedule("available"); }

    @Override public void onLost(android.net.Network network) { schedule("lost"); }

    @Override public void onCapabilitiesChanged(android.net.Network network, android.net.NetworkCapabilities caps) {
        // 2026-10-31：只在"网络形态真的变了"时才重连（详见类注释）。
        final int mask = transportMask(caps);
        final boolean validated = caps != null
                && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        final int prevMask = lastTransportMask;
        final boolean prevValidated = lastValidated;
        lastTransportMask = mask;
        lastValidated = validated;
        if (prevMask == 0) {
            // 首个能力快照：只记录基线，不触发（启动时必有一次）
            return;
        }
        if (mask != prevMask) {
            schedule("transport-changed");
            return;
        }
        if (validated && !prevValidated) {
            schedule("validated");
        }
    }
}
