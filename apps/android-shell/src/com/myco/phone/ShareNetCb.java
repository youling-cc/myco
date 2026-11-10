package com.myco.phone;

/**
 * 系统网络变化直通（2026-10-18 起，2026-10-31 vnet 根治改造）。
 *
 * 历史问题（真机日志实锤）：原来 `onAvailable`/`onLost` **任何网络**都直接通知页面重载，
 * 而荣耀/华为的 capabilities 回调高频抖动（信号强度/带宽估计/netId 变化），导致
 * `relay-provider network-changed force-reconnect (connectivity-changed)` 风暴 →
 * 每次重连都打断隧道 → 上层 DSH 页 `ws-close 1006` → "重新连接中" 循环。
 *
 * 现在的判定（vnet 根治 P1，设计定稿："感知只认真拓扑"）：
 *   1. 只认**默认网络**（getActiveNetwork）的拓扑令牌：
 *        token = transport 集合 + 网络身份
 *      —— transport 集合变（WiFi↔蜂窝↔有线↔VPN）或默认网络换了一条，token 才变；
 *   2. 再加 validated 上升沿（断网恢复完成的信号）；
 *   3. 同一个 token 的重复回调一律丢弃（幂等）；事件最小间隔 1s（节流，压掉切换瞬间三连回调）；
 *   4. 首个快照只做基线，不触发重连；
 *   5. 被节流吞掉的中间态：安排一次 1.2s 后的复查，保证"真实状态"不依赖下一次系统回调。
 *
 * 判定逻辑在 {@link NetGate}（纯 Java，JVM 单测覆盖：eval/vnetfix/NetGateTest.java）。
 */
public class ShareNetCb extends android.net.ConnectivityManager.NetworkCallback {
    /** 事件最小间隔（ms）。 */
    static final long MIN_INTERVAL_MS = 1000L;

    private final ShareWebActivity act;
    private final NetGate gate = new NetGate(MIN_INTERVAL_MS);

    public ShareNetCb(ShareWebActivity a) { this.act = a; }

    @Override public void onAvailable(android.net.Network network) { check(); }

    @Override public void onLost(android.net.Network network) { check(); }

    @Override public void onCapabilitiesChanged(android.net.Network network,
                                                android.net.NetworkCapabilities caps) {
        check();
    }

    /** 定时复查入口（节流吞掉中间态后，由 Activity 的 handler 回调）。 */
    void recheck() { check(); }

    /** 读当前真实状态喂给闸门；只有闸门说"真的换路了"才通知页面。 */
    private void check() {
        String token;
        boolean validated;
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) act.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            token = transportToken(cm);
            validated = isValidated(cm);
        } catch (Throwable t) {
            return; // 回调线程里绝不抛（会被系统吞掉且可能影响进程）
        }

        NetGate.Event e = gate.offer(token, validated, System.currentTimeMillis());
        if (e != null) {
            GwLog.note(null, "net-gate " + e.kind + " token=" + e.token);
            act.onNetChanged(e.kind);
            return;
        }
        // 被节流吞掉的中间态：当前真实 token 与闸门基线不一致 → 安排复查
        String cur = gate.currentToken();
        if (cur != null && !cur.equals(token)) act.scheduleNetRecheck();
    }

    /**
     * 默认网络的拓扑令牌：`<transports>#<netId>`。
     *
     * - transports：wifi/cell/eth/vpn/bt，顺序固定（保证可比较）；VPN 叠加在底层网络上时
     *   集合会同时含 vpn 与 wifi/cell —— 这正是"换路"；
     * - netId：Network 的稳定 id（同一网络稳定、换网络变化），用来发现
     *   "WiFi A → WiFi B"这种 transport 集合不变的换网。
     */
    static String transportToken(android.net.ConnectivityManager cm) {
        android.net.Network n = cm.getActiveNetwork();
        if (n == null) return "none#0";
        android.net.NetworkCapabilities c = cm.getNetworkCapabilities(n);
        if (c == null) return "none#0";
        StringBuilder sb = new StringBuilder();
        if (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) sb.append("wifi,");
        if (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) sb.append("cell,");
        if (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) sb.append("eth,");
        if (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) sb.append("vpn,");
        if (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_BLUETOOTH)) sb.append("bt,");
        if (sb.length() == 0) sb.append("other,");
        sb.setLength(sb.length() - 1);
        return sb + "#" + netId(n);
    }

    /** 默认网络是否已验证（NET_CAPABILITY_VALIDATED）。 */
    static boolean isValidated(android.net.ConnectivityManager cm) {
        android.net.Network n = cm.getActiveNetwork();
        if (n == null) return false;
        android.net.NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && c.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    /** Network.toString() 形如 `Network{100}`——取其数字 id 作为稳定身份。 */
    static String netId(android.net.Network n) {
        try {
            String s = n.toString();
            int i = s.indexOf('{');
            int j = s.indexOf('}', i + 1);
            if (i >= 0 && j > i) return s.substring(i + 1, j);
        } catch (Throwable ignored) { }
        return String.valueOf(n.hashCode());
    }
}
