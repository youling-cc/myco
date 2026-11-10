package com.myco.phone;

/**
 * NetGate —— 网络感知闸门（2026-10-31，vnet 根治 P1）。
 *
 * 目标（设计定稿："vnet 内部能自愈的切网，不要让上层知道"）：
 *   只有**真的换了一条可用网络**（transport 集合变化 / 默认网络身份变化 / validated 上升沿）
 *   才产生事件；信号强度、带宽估计、同一网络的重复回调一律视为噪声，**0 事件**。
 *
 * 为什么放在 vnet 内部：
 *   系统 NetworkCallback 在荣耀/华为上高频回调（capabilities 抖动），曾导致
 *   `network-changed force-reconnect` 风暴 → 每次重连都打断隧道 → 上层 ws-close 1006。
 *   app 侧过滤只是止血（release 分支 be13e86）；这里是 vnet 内部的**唯一判定点**。
 *
 * 规则：
 *   1. 幂等：token 相同 → 不产生事件（重复事件天然合并）；
 *   2. 沿触发：validated 只在 false→true 上升沿产生一次；
 *   3. 节流：两次事件至少间隔 minIntervalMs（默认 1000ms）——切换瞬间的
 *      "WiFi→无→蜂窝" 三连回调被压成一次；
 *   4. 首个快照只做基线：进程刚起来不知道该信谁，不触发重连。
 *
 * 纯 Java、无 Android 依赖（可在 JVM 单测直击，见 eval/vnetfix/NetGateTest.java）。
 */
public final class NetGate {

    /** 真拓扑变化的两类事件。 */
    public enum Kind {
        /** transport 集合或默认网络身份变化（真的换路：WiFi↔蜂窝↔有线↔VPN）。 */
        TRANSPORT_CHANGED,
        /** 当前网络刚被系统判定"已验证可用"（断网恢复的完成信号）。 */
        VALIDATED
    }

    public static final class Event {
        public final Kind kind;
        public final String token;
        public final long atMs;

        Event(Kind kind, String token, long atMs) {
            this.kind = kind;
            this.token = token;
            this.atMs = atMs;
        }

        @Override public String toString() {
            return kind + "(token=" + token + ", at=" + atMs + ")";
        }
    }

    private final long minIntervalMs;

    private String curToken = null;      // null = 还没有基线
    private boolean curValidated = false;
    private long lastEmitAt = Long.MIN_VALUE / 4;

    public NetGate() { this(1000L); }

    public NetGate(long minIntervalMs) { this.minIntervalMs = Math.max(0L, minIntervalMs); }

    /**
     * 每次系统回调喂一次（binder 线程可以随意调，方法自身无锁需求由调用方串行）。
     *
     * @param token      当前**默认网络**的拓扑令牌（transport 集合 + 网络身份）。
     *                   同一条网络必须稳定同值；不同网络/换网必须不同。
     * @param validated  当前默认网络是否带 NET_CAPABILITY_VALIDATED。
     * @param nowMs      当前毫秒时间（测试注入，避免 sleep）。
     * @return 需要向上层/隧道层发通知时返回事件，否则 null。
     */
    public Event offer(String token, boolean validated, long nowMs) {
        String t = token == null ? "none" : token;

        // 4) 首个快照只做基线
        if (curToken == null) {
            curToken = t;
            curValidated = validated;
            return null;
        }

        boolean changed = !t.equals(curToken);
        boolean validatedEdge = validated && !curValidated;
        curValidated = validated;

        if (!changed && !validatedEdge) return null;            // 1) 幂等
        if (nowMs - lastEmitAt < minIntervalMs) return null;     // 3) 节流

        curToken = t;
        lastEmitAt = nowMs;
        return new Event(changed ? Kind.TRANSPORT_CHANGED : Kind.VALIDATED, t, nowMs);
    }

    /** 当前基线令牌（诊断/日志用；null = 还没有基线）。 */
    public String currentToken() { return curToken; }

    /** 当前基线是否 validated（诊断用）。 */
    public boolean currentValidated() { return curValidated; }
}
